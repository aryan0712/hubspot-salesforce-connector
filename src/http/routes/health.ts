import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { isShuttingDown } from '../../lifecycle.js';
import { metrics } from '../../observability/metrics.js';
import type { RouteContext } from '../context.js';

/** Liveness, readiness and Prometheus metrics (R14). */
export function healthRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { rootApp, runtime, options } = ctx;

  /** Liveness: the process is up and serving (restart it only if this fails). */
  router.get('/health/live', (_req, res) => res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) }));

  /** Readiness: send traffic here? False while draining, without a database, or with unapplied migrations. */
  router.get('/health/ready', async (_req, res) => {
    const problems: string[] = [];
    if (isShuttingDown()) problems.push('shutting_down');
    if (rootApp.db) {
      try {
        await rootApp.db.health();
        const pending = await rootApp.pendingMigrations();
        if (pending.length) problems.push(`pending_migrations:${pending.join(',')}`);
      } catch {
        problems.push('database_unavailable');
      }
    }
    res.status(problems.length ? 503 : 200).json({ ready: !problems.length, problems });
  });

  const metricsToken = options.metricsToken ?? env.METRICS_TOKEN;
  metrics.collect(async () => {
    const apps = [rootApp, ...(options.tenants?.loaded() ?? [])].filter((item, index, all) => all.indexOf(item) === index);
    const families = new Map<string, { help: string; samples: { labels?: Record<string, string | number>; value: number }[] }>();
    const add = (name: string, help: string, value: number, labels?: Record<string, string | number>) => {
      const family = families.get(name) ?? { help, samples: [] };
      family.samples.push({ labels, value });
      families.set(name, family);
    };
    for (const target of apps) {
      const tenant = target.tenantId ?? (target.mock ? 'demo' : 'local');
      const stats = await target.sync.stats();
      for (const [status, count] of Object.entries(stats)) add('crm_sync_sync_jobs', 'Sync jobs by status.', count, { tenant, status });
      const oldest = await target.sync.store.oldestPending();
      add('crm_sync_sync_oldest_pending_seconds', 'Age of the oldest change waiting to sync.', oldest ? (Date.now() - Date.parse(oldest)) / 1000 : 0, { tenant });
      add('crm_sync_webhook_inbox_pending', 'Webhook deliveries waiting to be processed.', await target.webhookInbox.pendingCount(), { tenant });
      for (const system of ['salesforce', 'hubspot'] as const) {
        const health = (target.connectors[system] as { health?: () => { state: string } | undefined }).health?.();
        add('crm_sync_crm_circuit_open', 'CRM circuit breaker state (0 closed, 0.5 half-open, 1 open).', !health || health.state === 'closed' ? 0 : health.state === 'open' ? 1 : 0.5, { tenant, system });
      }
      for (const alert of await target.alerts()) add('crm_sync_alert_active', 'Active operational alerts.', 1, { tenant, alert: alert.id, severity: alert.severity });
    }
    if (rootApp.db) {
      const pool = rootApp.db.poolStats();
      add('crm_sync_db_pool_connections', 'Database pool connections.', pool.total, { state: 'total' });
      add('crm_sync_db_pool_connections', 'Database pool connections.', pool.idle, { state: 'idle' });
      add('crm_sync_db_pool_connections', 'Database pool connections.', pool.waiting, { state: 'waiting' });
    }
    add('crm_sync_process_uptime_seconds', 'Process uptime.', process.uptime());
    add('crm_sync_process_resident_memory_bytes', 'Resident memory.', process.memoryUsage().rss);
    add('crm_sync_shutting_down', 'Whether the process is draining for shutdown.', isShuttingDown() ? 1 : 0);
    return [...families].map(([name, family]) => ({ name, ...family }));
  });

  /** Prometheus scrape endpoint; a bearer token is required whenever one is configured. */
  router.get('/metrics', async (req, res) => {
    if (metricsToken) {
      const supplied = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
      const a = Buffer.from(supplied);
      const b = Buffer.from(metricsToken);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).type('text').send('unauthorized');
    } else if (runtime.production) {
      return res.status(404).type('text').send('not found');
    }
    res.type('text/plain; version=0.0.4').send(await metrics.render());
  });

  /** Legacy alias, kept for existing monitors: liveness + a database ping. */
  router.get('/health', async (_req, res) => {
    try {
      const database = ctx.app.db ? await ctx.app.db.health() : { ok: true, databaseTime: 'mock' };
      res.json({ ok: true, database, ts: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
  });

  return router;
}
