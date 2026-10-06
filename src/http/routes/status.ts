import { Router } from 'express';
import { env } from '../../config/env.js';
import { connections } from '../../core/connectionStore.js';
import * as sfAuth from '../../connectors/salesforce/auth.js';
import * as hsAuth from '../../connectors/hubspot/auth.js';
import { connInfo } from '../helpers.js';
import type { RouteContext } from '../context.js';

const AUTH = { salesforce: sfAuth, hubspot: hsAuth };

/** Live connection/queue status, activity feed, operational alerts, and real readiness (R13/R14). */
export function statusRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app } = ctx;

  router.get('/api/status', async (_req, res) => {
    const [sf, hs, sfConfigured, hsConfigured, queue] = await Promise.all([
      connections.get('salesforce'),
      connections.get('hubspot'),
      sfAuth.isConfigured(),
      hsAuth.isConfigured(),
      app.sync.stats(),
    ]);
    res.json({
      mode: 'live',
      configured: { salesforce: sfConfigured, hubspot: hsConfigured },
      connections: { salesforce: connInfo(sf), hubspot: connInfo(hs) },
      ready: Boolean(sf && hs),
      copilot: { configured: ctx.migrationCopilot.configured, model: ctx.migrationCopilot.model },
      // Surfaced so the UI can state the active policy instead of hardcoding a label that
      // silently goes stale when these are reconfigured. The workspace's actual sync
      // settings (env values are only the initial defaults).
      policy: {
        conflictStrategy: app.syncConfig.get().conflictStrategy,
        sourceOfTruth: app.syncConfig.get().sourceOfTruth,
      },
      stats: app.activity.snapshot(),
      queue,
    });
  });

  router.get('/api/activity', (_req, res) => res.json({ entries: app.activity.recent(50) }));

  /** R14 operational alerts for this workspace. */
  router.get('/api/alerts', async (_req, res) => res.json({ entries: await app.alerts() }));

  /**
   * R13: real readiness for the operator (never a hardcoded "healthy"): database, app
   * credentials, connected accounts, connector circuit breakers, queues, webhook backlog
   * and whether workers run. `blocked` checks stop work; `warning` ones need attention.
   */
  router.get('/api/readiness', async (_req, res) => {
    type Check = { id: string; label: string; status: 'ok' | 'warning' | 'blocked'; detail: string };
    const checks: Check[] = [];
    const add = (id: string, label: string, status: Check['status'], detail: string) =>
      checks.push({ id, label, status, detail });
    if (app.db) {
      try {
        await app.db.health();
        add('database', 'Database', 'ok', 'PostgreSQL reachable');
      } catch {
        add('database', 'Database', 'blocked', 'PostgreSQL is not reachable');
      }
    } else {
      add('database', 'Database', app.mock ? 'ok' : 'warning', app.mock ? 'In-memory demo data' : 'No database configured');
    }
    for (const system of ['salesforce', 'hubspot'] as const) {
      const label = system === 'salesforce' ? 'Salesforce' : 'HubSpot';
      if (app.mock) {
        add(`connection.${system}`, label, 'ok', 'Mock CRM (demo)');
        continue;
      }
      const [connection, configured] = await Promise.all([
        connections.get(system).catch(() => undefined),
        AUTH[system].isConfigured().catch(() => false),
      ]);
      if (!configured) add(`credentials.${system}`, `${label} app credentials`, 'blocked', 'Client id/secret not set up');
      if (!connection) add(`connection.${system}`, label, 'blocked', 'Not connected');
      else add(`connection.${system}`, label, 'ok', `Connected to ${connection.accountLabel ?? connection.instanceUrl ?? 'account'}${connection.accountId ? ` (${connection.accountId})` : ''}`);
      const health = (app.connectors[system] as { health?: () => { state: string; lastError?: string; openedUntil?: string } | undefined }).health?.();
      if (health && health.state !== 'closed') {
        add(`circuit.${system}`, `${label} API`, health.state === 'open' ? 'blocked' : 'warning',
          `Requests paused after repeated failures${health.openedUntil ? ` until ${health.openedUntil}` : ''}${health.lastError ? `: ${health.lastError}` : ''}`);
      }
    }
    const queue = await app.sync.stats();
    const attention = (queue.deadLetter ?? 0) + (queue.manualReview ?? 0);
    add('sync.queue', 'Sync queue', attention ? 'warning' : 'ok',
      attention ? `${attention} change(s) need attention (${queue.deadLetter ?? 0} failed, ${queue.manualReview ?? 0} in review)` : `${queue.queued ?? 0} queued, ${queue.retry ?? 0} retrying`);
    const pending = await app.webhookInbox.pendingCount();
    const backlogLimit = ctx.options.webhooks?.maxBacklog ?? env.WEBHOOK_MAX_BACKLOG;
    add('webhooks.inbox', 'Webhook inbox', pending >= backlogLimit ? 'blocked' : pending > backlogLimit / 2 ? 'warning' : 'ok',
      `${pending} pending of ${backlogLimit} allowed`);
    add('workers', 'Background workers', app.workersStarted || app.mock ? 'ok' : env.RUN_WORKERS ? 'warning' : 'ok',
      app.workersStarted || app.mock ? 'Running in this process' : env.RUN_WORKERS ? 'Not started yet' : 'Running in a separate worker process');
    const status = checks.some((check) => check.status === 'blocked')
      ? 'blocked'
      : checks.some((check) => check.status === 'warning')
        ? 'warning'
        : 'ok';
    res.json({ status, ready: status !== 'blocked', checks });
  });

  return router;
}
