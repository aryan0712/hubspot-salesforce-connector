import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, type App } from '../src/app.js';
import { buildHttpApp } from '../src/httpApp.js';
import { installGracefulShutdown } from '../src/lifecycle.js';
import { logContext, withLogContext } from '../src/observability/context.js';
import { evaluateAlerts } from '../src/observability/alerts.js';
import { MetricsRegistry } from '../src/observability/metrics.js';
import { InMemorySyncEventStore } from '../src/engine/syncEventStore.js';
import { InMemoryWebhookInbox } from '../src/webhooks/inbox.js';
import type { RuntimePolicy } from '../src/security/runtimeGuard.js';

/** R14: correlation, metrics, liveness/readiness and operational alerts. */

const runtime: RuntimePolicy = {
  production: false,
  authRequired: false,
  demoRoutes: false,
  publicBaseUrl: 'http://localhost:3000',
  multiTenant: false,
};
const TOKEN = 'metrics-token-0123456789';

let app: App;
let server: Server;
let base: string;

beforeAll(async () => {
  app = await createApp({ mock: true });
  await app.sync.stop();
  const [jobId] = await app.sync.store.enqueue([
    { system: 'hubspot', type: 'contact', sourceId: '42', changeType: 'updated', occurredAt: new Date().toISOString() },
  ]);
  await app.sync.store.deadLetter(jobId!, 'rejected');
  const http = await buildHttpApp(app, { runtime, metricsToken: TOKEN });
  server = http.server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.inboxProcessor.stop();
});

describe('R14 correlation', () => {
  it('echoes a safe caller request id and replaces an unsafe one', async () => {
    const safe = await fetch(`${base}/api/status`, { headers: { 'x-request-id': 'deploy-check.42' } });
    expect(safe.headers.get('x-request-id')).toBe('deploy-check.42');
    const unsafe = await fetch(`${base}/api/status`, { headers: { 'x-request-id': 'x'.repeat(200) } });
    expect(unsafe.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('carries request, workspace and job ids into nested work', async () => {
    const seen = await withLogContext({ requestId: 'r-1' }, () =>
      withLogContext({ jobId: 'j-1' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return logContext();
      }),
    );
    expect(seen).toEqual({ requestId: 'r-1', jobId: 'j-1' });
    expect(logContext()).toBeUndefined();
  });
});

describe('R14 metrics', () => {
  it('requires the bearer token and exposes request, queue and alert metrics', async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong-token-000000000' } })).status).toBe(401);
    await fetch(`${base}/api/status`);
    const response = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toMatch(/crm_sync_http_requests_total\{[^}]*route="\/api\/status"[^}]*\} \d+/);
    expect(text).toMatch(/crm_sync_http_request_duration_seconds_bucket\{/);
    expect(text).toMatch(/crm_sync_sync_jobs\{tenant="demo",status="deadLetter"\} 1/);
    expect(text).toMatch(/crm_sync_alert_active\{tenant="demo",alert="sync_dead_letters",severity="warning"\} 1/);
    expect(text).toContain('# TYPE crm_sync_webhook_inbox_pending gauge');
  });

  it('renders valid Prometheus text with escaped labels', async () => {
    const registry = new MetricsRegistry();
    registry.counter('demo_total', 'Demo.').inc({ reason: 'a "quoted"\nvalue' }, 2);
    expect(await registry.render()).toContain('demo_total{reason="a \\"quoted\\"\\nvalue"} 2');
  });
});

describe('R14 health and alerts', () => {
  it('reports operational alerts for the workspace', async () => {
    const body = (await (await fetch(`${base}/api/alerts`)).json()) as { entries: { id: string }[] };
    const alerts = body.entries;
    expect(alerts.map((alert) => alert.id)).toContain('sync_dead_letters');
  });

  it('detects stale sync, CRM credential failures and failed migrations', async () => {
    const syncStore = new InMemorySyncEventStore();
    await syncStore.enqueue([{ system: 'salesforce', type: 'contact', sourceId: '1', changeType: 'updated', occurredAt: new Date().toISOString() }]);
    const alerts = await evaluateAlerts({
      syncStore,
      executions: { list: async () => [{ status: 'failed', createdAt: new Date().toISOString(), pauseReason: 'preview drift detected' }] } as never,
      webhookInbox: new InMemoryWebhookInbox(),
      connectors: {
        salesforce: { health: () => ({ state: 'open', lastError: 'invalid_grant: expired access/refresh token' }) },
        hubspot: { health: () => ({ state: 'closed' }) },
      } as never,
      maxWebhookBacklog: 100,
      staleAfterMs: 60_000,
      now: () => Date.now() + 5 * 60_000,
    });
    expect(alerts.map((alert) => [alert.id, alert.severity])).toEqual([
      ['sync_stale', 'warning'],
      ['crm_reconnect_required_salesforce', 'critical'],
      ['migrations_need_attention', 'critical'],
    ]);
    expect(alerts[2]!.detail).toContain('drift');
  });

  it('liveness stays up while readiness turns false during shutdown', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect(await (await fetch(`${base}/health/ready`)).json()).toEqual({ ready: true, problems: [] });
    const shutdown = installGracefulShutdown([], { exit: () => undefined });
    await shutdown();
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ ready: false, problems: ['shutting_down'] });
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
  });
});
