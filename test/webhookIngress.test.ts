import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, type App } from '../src/app.js';
import { buildHttpApp, type HttpApp } from '../src/httpApp.js';
import { hubspotSignatureUri, hubspotV3Signature, verifyHubSpotRequest } from '../src/webhooks/hubspot.js';
import { salesforceV2Signature } from '../src/webhooks/salesforce.js';
import { WebhookIngress, salesforceWebhookSecret, type WebhookWorkspace } from '../src/webhooks/ingress.js';
import { InMemoryWebhookInbox } from '../src/webhooks/inbox.js';
import { WebhookRejectedError } from '../src/webhooks/types.js';
import { WebhookInboxProcessor } from '../src/engine/webhookInboxProcessor.js';
import { InMemorySyncEventStore } from '../src/engine/syncEventStore.js';
import { UnsafeRuntimeError, type RuntimePolicy } from '../src/security/runtimeGuard.js';
import { SecretCipher } from '../src/db/security.js';
import { PostgresWebhookInbox, PostgresAccountRouteStore } from '../src/db/postgresWebhookStores.js';
import { TenantApps } from '../src/tenancy.js';
import { MockConnector } from '../src/connectors/mock/mockConnector.js';
import { createDefaultConfigContext } from '../src/core/configContext.js';
import type { ChangeEvent, SystemId } from '../src/core/types.js';
import { startIsolatedPostgres, type IsolatedPostgres } from './helpers/postgres.js';

/** R12: webhook authenticity, validation, account routing and persistence before ack. */

/**
 * Burst (acknowledgement latency) measurements saturate the process on purpose, so they run
 * only in `npm run test:load:webhooks`; inside the parallel unit suite they would starve
 * neighbouring test files and measure the suite instead of the ingress.
 */
const LOAD = process.env.RUN_LOAD_TESTS === '1';

const BASE_URL = 'https://sync.example.com';
const HS_SECRET = 'hubspot-app-secret';
const SF_SECRET = 'salesforce-webhook-secret';
const NOW = Date.parse('2026-09-24T12:00:00Z');
const ORG = '00D000000000001AAA';

function hubspotBody(portalId: number | string = 111, count = 1, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      eventId: 1000 + i,
      subscriptionId: 7,
      portalId,
      objectId: 5000 + i,
      subscriptionType: 'contact.propertyChange',
      occurredAt: NOW - 1000,
      ...extra,
    })),
  );
}

function hubspotRequest(body: string, opts: { timestamp?: number; secret?: string; url?: string; base?: string } = {}) {
  const timestamp = String(opts.timestamp ?? NOW);
  const url = opts.url ?? '/webhooks/hubspot';
  return {
    method: 'POST',
    originalUrl: url,
    body: Buffer.from(body),
    headers: {
      'x-hubspot-request-timestamp': timestamp,
      'x-hubspot-signature-v3': hubspotV3Signature(opts.secret ?? HS_SECRET, 'POST', `${opts.base ?? BASE_URL}${url}`, body, timestamp),
    },
  };
}

function salesforceBody(events = [{ sobject: 'Contact', recordId: '003000000000001AAA', changeType: 'updated', occurredAt: new Date(NOW - 1000).toISOString() }]) {
  return JSON.stringify({ events });
}

function salesforceRequest(body: string, opts: { nonce?: string; timestamp?: number; org?: string; secret?: string } = {}) {
  const timestamp = String(opts.timestamp ?? NOW);
  const nonce = opts.nonce ?? crypto.randomBytes(16).toString('hex');
  const org = opts.org ?? ORG;
  return {
    method: 'POST',
    originalUrl: '/webhooks/salesforce',
    body: Buffer.from(body),
    headers: {
      'x-crmsync-timestamp': timestamp,
      'x-crmsync-nonce': nonce,
      'x-crmsync-org-id': org,
      'x-crmsync-signature': salesforceV2Signature(opts.secret ?? SF_SECRET, timestamp, nonce, org, body),
    },
  };
}

function workspace(overrides: Partial<WebhookWorkspace> = {}): WebhookWorkspace & { inbox: InMemoryWebhookInbox; alerts: string[] } {
  const alerts: string[] = [];
  return {
    tenantId: 'tenant-1',
    inbox: new InMemoryWebhookInbox(),
    secret: async (system: SystemId) => (system === 'hubspot' ? HS_SECRET : SF_SECRET),
    connectedAccount: async (system: SystemId) => (system === 'hubspot' ? '111' : ORG),
    alert: (message: string) => alerts.push(message),
    alerts,
    ...overrides,
  } as WebhookWorkspace & { inbox: InMemoryWebhookInbox; alerts: string[] };
}

function ingress(ws: WebhookWorkspace | undefined, opts: Partial<ConstructorParameters<typeof WebhookIngress>[0]> = {}) {
  return new WebhookIngress({
    publicBaseUrl: BASE_URL,
    salesforceMode: 'compat',
    now: () => NOW,
    resolveWorkspace: async () => ws,
    ...opts,
  });
}

describe('R12 HubSpot signature v3', () => {
  it('matches HubSpot\'s published v3 example', () => {
    // Inputs and expected signature from HubSpot's "Validating requests" documentation.
    const body =
      '[{"eventId":531833541,"subscriptionId":3923621,"portalId":48807704,"appId":16111050,"occurredAt":1752613920733,"subscriptionType":"contact.creation","attemptNumber":0,"objectId":138017612137,"changeFlag":"CREATED","changeSource":"CRM_UI","sourceId":"userId:76023669"}]';
    const signature = hubspotV3Signature(
      'cfc68c0b-4b4e-4ef8-b764-95350e4ea479',
      'POST',
      'https://webhook.site/335453f5-94b3-49d9-b684-a55354d4b8df',
      body,
      '1752613922216',
    );
    expect(signature).toBe('gbj1XPRvUt0noT7i7fXfTzOD4sLzQmf0VT28ZYq0EYg=');
  });

  it('decodes exactly the documented characters in the request URI', () => {
    expect(hubspotSignatureUri('https://h/p%3Aa%2Fb%3Fc%40d%21e%24f%27g%28h%29i%2Aj%2Ck%3Bl%20m')).toBe(
      "https://h/p:a/b?c@d!e$f'g(h)i*j,k;l%20m",
    );
  });

  it('rejects stale, future, tampered and unsigned requests', () => {
    const body = hubspotBody();
    const valid = hubspotRequest(body);
    const check = (patch: Partial<Parameters<typeof verifyHubSpotRequest>[0]>) => () =>
      verifyHubSpotRequest({
        secret: HS_SECRET,
        method: 'POST',
        uri: `${BASE_URL}/webhooks/hubspot`,
        body,
        signature: valid.headers['x-hubspot-signature-v3'],
        timestamp: String(NOW),
        now: NOW,
        ...patch,
      });
    expect(check({})).not.toThrow();
    expect(check({ now: NOW + 5 * 60_000 + 1 })).toThrow(/stale_timestamp/);
    expect(check({ now: NOW - 2 * 60_000 })).toThrow(/future_timestamp/);
    expect(check({ body: body.replace('111', '112') })).toThrow(/bad_signature/);
    expect(check({ uri: `${BASE_URL}/webhooks/hubspot?x=1` })).toThrow(/bad_signature/);
    expect(check({ secret: 'other' })).toThrow(/bad_signature/);
    expect(check({ signature: undefined })).toThrow(/bad_signature/);
    expect(check({ timestamp: undefined })).toThrow(/stale_timestamp/);
  });
});

describe('R12 ingress outcomes', () => {
  it('persists a verified delivery before acknowledging, and a redelivery is a duplicate', async () => {
    const ws = workspace();
    const hooks = ingress(ws);
    const request = hubspotRequest(hubspotBody(111, 3));
    expect(await hooks.handle('hubspot', request)).toEqual({ status: 200, body: { received: 3, accepted: 3, duplicates: 0 } });
    expect(ws.inbox.entries()).toHaveLength(3);
    expect(await hooks.handle('hubspot', request)).toEqual({ status: 200, body: { received: 3, accepted: 0, duplicates: 3 } });
    expect(ws.inbox.entries()).toHaveLength(3);
    expect(hooks.metrics.snapshot('tenant-1').counters).toMatchObject({ accepted: 3, duplicates: 3 });
  });

  it('gives each failure one deterministic status', async () => {
    const ws = workspace();
    const hooks = ingress(ws);
    const cases: [string, Parameters<WebhookIngress['handle']>[1], number, string][] = [
      ['not JSON', hubspotRequest('{nope'), 400, 'malformed'],
      ['not an array', hubspotRequest('{}'), 400, 'malformed'],
      ['no events', hubspotRequest('[]'), 400, 'malformed'],
      ['bad field', hubspotRequest(hubspotBody(111, 1, { objectId: 'x' })), 400, 'malformed'],
      ['mixed portals', hubspotRequest(JSON.stringify([...JSON.parse(hubspotBody(111)), ...JSON.parse(hubspotBody(222))])), 400, 'mixed_accounts'],
      ['too many', hubspotRequest(hubspotBody(111, 1001)), 413, 'too_many_events'],
      ['oversized', { ...hubspotRequest('[]'), body: Buffer.alloc(1024 * 1024 + 1, 32) }, 413, 'oversized'],
      ['future event', hubspotRequest(hubspotBody(111, 1, { occurredAt: NOW + 10 * 60_000 })), 401, 'future_timestamp'],
      ['stale', hubspotRequest(hubspotBody(), { timestamp: NOW - 6 * 60_000 }), 401, 'stale_timestamp'],
      ['wrong secret', hubspotRequest(hubspotBody(), { secret: 'nope' }), 401, 'bad_signature'],
      ['signed for another URI', hubspotRequest(hubspotBody(), { url: '/webhooks/hubspot?a=1' }), 401, 'bad_signature'],
      ['other portal', hubspotRequest(hubspotBody(222)), 403, 'account_mismatch'],
    ];
    for (const [label, request, status, error] of cases) {
      const response = await hooks.handle('hubspot', label === 'signed for another URI' ? { ...request, originalUrl: '/webhooks/hubspot' } : request);
      expect({ label, ...response }).toEqual({ label, status, body: { error } });
    }
    expect(ws.inbox.entries()).toHaveLength(0);
    expect(ws.alerts.some((message) => message.includes('bad signature'))).toBe(true);
  });

  it('refuses unknown accounts and cannot accept without a secret', async () => {
    expect((await ingress(undefined).handle('hubspot', hubspotRequest(hubspotBody()))).status).toBe(403);
    const noSecret = workspace({ secret: async () => undefined });
    expect(await ingress(noSecret).handle('hubspot', hubspotRequest(hubspotBody()))).toEqual({
      status: 503,
      body: { error: 'secret_unavailable' },
    });
  });

  it('a database failure is retryable (503) and the retry is accepted once', async () => {
    const ws = workspace();
    const accept = ws.inbox.accept.bind(ws.inbox);
    let failures = 1;
    ws.inbox.accept = async (events, nonce) => {
      if (failures-- > 0) throw new Error('connection terminated');
      return accept(events, nonce);
    };
    const hooks = ingress(ws);
    const request = salesforceRequest(salesforceBody());
    expect(await hooks.handle('salesforce', request)).toEqual({ status: 503, body: { error: 'internal_error' } });
    // The sender retries the identical request (same nonce): not mistaken for a replay.
    expect((await hooks.handle('salesforce', request)).status).toBe(200);
    expect((await hooks.handle('salesforce', request)).body).toEqual({ error: 'replayed' });
    expect(ws.inbox.entries()).toHaveLength(1);
  });

  it('sheds load when the inbox backlog is full', async () => {
    const ws = workspace();
    const hooks = ingress(ws, { maxBacklog: 2 });
    expect((await hooks.handle('hubspot', hubspotRequest(hubspotBody(111, 2)))).status).toBe(200);
    expect(await hooks.handle('hubspot', hubspotRequest(hubspotBody(111, 1, { eventId: 9 })))).toEqual({
      status: 503,
      body: { error: 'backlog_full' },
    });
  });
});

describe('R12 Salesforce sender contract', () => {
  it('accepts v2 once per nonce and refuses stale, tampered or foreign-org requests', async () => {
    const ws = workspace();
    const hooks = ingress(ws);
    const request = salesforceRequest(salesforceBody());
    expect((await hooks.handle('salesforce', request)).status).toBe(200);
    expect(await hooks.handle('salesforce', request)).toEqual({ status: 401, body: { error: 'replayed' } });
    expect((await hooks.handle('salesforce', salesforceRequest(salesforceBody(), { timestamp: NOW - 6 * 60_000 }))).body).toEqual({
      error: 'stale_timestamp',
    });
    const tampered = salesforceRequest(salesforceBody());
    expect((await hooks.handle('salesforce', { ...tampered, body: Buffer.from(salesforceBody().replace('Contact', 'Account')) })).body).toEqual({
      error: 'bad_signature',
    });
    // Signed correctly, but for another org than the connected one.
    expect((await hooks.handle('salesforce', salesforceRequest(salesforceBody(), { org: '00D000000000009AAA' }))).body).toEqual({
      error: 'account_mismatch',
    });
    expect(
      (await hooks.handle('salesforce', salesforceRequest(JSON.stringify({ events: [{ sobject: 'Contact', recordId: 'x' }] })))).body,
    ).toEqual({ error: 'malformed' });
    expect(ws.inbox.entries()).toEqual([expect.objectContaining({ accountId: ORG, nativeObject: 'Contact' })]);
  });

  it('keeps existing legacy senders working in compat mode, and can refuse them', async () => {
    const body = salesforceBody();
    const legacy = {
      method: 'POST',
      originalUrl: '/webhooks/salesforce',
      body: Buffer.from(body),
      headers: { 'x-signature': crypto.createHmac('sha256', SF_SECRET).update(body).digest('hex') },
    };
    const compat = ingress(workspace());
    expect((await compat.handle('salesforce', legacy)).status).toBe(200);
    expect(compat.metrics.snapshot('tenant-1').counters.signature_legacy).toBe(1);
    const strict = ingress(workspace(), { salesforceMode: 'v2' });
    expect(await strict.handle('salesforce', legacy)).toEqual({ status: 401, body: { error: 'legacy_signature_disabled' } });
  });

  it('events without occurredAt are not collapsed onto the first delivery', async () => {
    const ws = workspace();
    const hooks = ingress(ws, { now: () => NOW });
    const body = salesforceBody([{ sobject: 'Contact', recordId: '003000000000001AAA', changeType: 'updated' }] as never);
    await hooks.handle('salesforce', salesforceRequest(body));
    const later = ingress(ws, { now: () => NOW + 5000 });
    await later.handle('salesforce', salesforceRequest(body, { timestamp: NOW + 5000 }));
    expect(ws.inbox.entries()).toHaveLength(2);
  });

  it('derives a distinct secret per workspace in multi-tenant mode', () => {
    expect(salesforceWebhookSecret('m', 'a', false)).toBe('m');
    const a = salesforceWebhookSecret('m', 'a', true);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(salesforceWebhookSecret('m', 'b', true));
  });
});

describe('R12 inbox processing', () => {
  it('turns persisted deliveries into sync jobs on the worker, discarding unsynced objects with a reason', async () => {
    const config = createDefaultConfigContext('inbox');
    const connectors = { salesforce: new MockConnector('salesforce', config), hubspot: new MockConnector('hubspot', config) };
    const inbox = new InMemoryWebhookInbox();
    const store = new InMemorySyncEventStore();
    const processor = new WebhookInboxProcessor(connectors, inbox, (events) => store.enqueue(events));
    const event = { system: 'hubspot' as const, accountId: '111', sourceId: '1', changeType: 'updated' as const, occurredAt: new Date(NOW).toISOString() };
    await inbox.accept([
      { ...event, deliveryId: 'a', nativeObject: 'contact' },
      { ...event, deliveryId: 'b', nativeObject: 'widget' },
    ]);
    expect(await processor.drain()).toBe(2);
    const entries = inbox.entries();
    expect(entries.find((entry) => entry.deliveryId === 'a')?.status).toBe('queued');
    expect(entries.find((entry) => entry.deliveryId === 'b')).toMatchObject({ status: 'discarded', reason: expect.stringMatching(/not synced/) });
    const jobs = await store.list(10);
    expect(jobs.map((job) => job.event)).toEqual([expect.objectContaining<Partial<ChangeEvent>>({ type: 'contact', eventId: 'hubspot:a' })]);
  });

  it('waits for the connector to be ready and retries transient failures', async () => {
    const config = createDefaultConfigContext('inbox-retry');
    const hubspot = new MockConnector('hubspot', config);
    const connectors = { salesforce: new MockConnector('salesforce', config), hubspot };
    const inbox = new InMemoryWebhookInbox();
    let ready = false;
    let failures = 1;
    const resolve = hubspot.resolveWebhookEvent.bind(hubspot);
    hubspot.resolveWebhookEvent = async (event) => {
      if (failures-- > 0) throw new Error('metadata unavailable');
      return resolve(event);
    };
    const enqueued: ChangeEvent[] = [];
    const processor = new WebhookInboxProcessor(connectors, inbox, async (events) => void enqueued.push(...events));
    processor.start(async () => ready);
    await inbox.accept([{ system: 'hubspot', deliveryId: 'x', nativeObject: 'contact', sourceId: '1', changeType: 'created', occurredAt: new Date().toISOString() }]);
    expect(await processor.runOnce()).toBe(0); // not ready: nothing claimed, nothing lost
    ready = true;
    expect(await processor.runOnce()).toBe(1);
    expect(inbox.entries()[0]).toMatchObject({ status: 'pending', reason: 'metadata unavailable' });
    await processor.stop();
    expect(enqueued).toEqual([]);
  });
});

describe('R12 over HTTP (single workspace)', () => {
  const LOCAL = 'http://localhost:3000';
  const runtime: RuntimePolicy = { production: false, authRequired: false, demoRoutes: false, publicBaseUrl: LOCAL, multiTenant: false };
  let app: App;
  let http: HttpApp;
  let listener: Server;
  let base: string;

  beforeAll(async () => {
    app = await createApp({ mock: true });
    http = await buildHttpApp(app, {
      runtime,
      webhooks: { now: () => NOW, secret: async (system) => (system === 'hubspot' ? HS_SECRET : SF_SECRET) },
    });
    listener = http.server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await app.inboxProcessor.stop();
  });

  const post = (path: string, request: ReturnType<typeof hubspotRequest>) =>
    fetch(`${base}${path}`, { method: 'POST', headers: request.headers, body: request.body });
  const signed = (body: string) => hubspotRequest(body, { base: LOCAL });

  it('acknowledges after persisting; the worker then creates the sync job', async () => {
    const response = await post('/webhooks/hubspot', signed(hubspotBody(111, 2, { subscriptionType: 'contact.creation' })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: 2, accepted: 2, duplicates: 0 });
    await app.inboxProcessor.drain();
    const jobs = await app.sync.store.list(50);
    expect(jobs.filter((job) => job.event.system === 'hubspot' && ['5000', '5001'].includes(job.event.sourceId))).toHaveLength(2);
    const stats = (await (await fetch(`${base}/api/webhooks/stats`)).json()) as { counters: Record<string, number> };
    expect(stats.counters.accepted).toBeGreaterThanOrEqual(2);
  });

  it('rejects bodies over the limit before parsing them', async () => {
    const response = await fetch(`${base}/webhooks/hubspot`, { method: 'POST', body: Buffer.alloc(1024 * 1024 + 10, 32) });
    expect(response.status).toBe(413);
  });

  it('refuses unsigned webhooks in production', async () => {
    await expect(
      buildHttpApp(app, { runtime: { ...runtime, production: true, authRequired: true }, webhooks: { allowUnsigned: true } }),
    ).rejects.toBeInstanceOf(UnsafeRuntimeError);
  });

  it.runIf(LOAD)('acknowledges a burst of deliveries quickly (latency measured, recorded in the release evidence)', { timeout: 120_000 }, async () => {
    // Acknowledgement cost of the ingress itself: in-process workers are paused, as with
    // RUN_WORKERS=false + a separate worker process. (Workers sharing the web process's
    // event loop delay acknowledgements -- see docs/WEBHOOKS.md.)
    await app.inboxProcessor.stop();
    await app.sync.stop();
    const deliveries = 200;
    const latencies: number[] = [];
    await Promise.all(
      Array.from({ length: deliveries }, async (_, i) => {
        const body = hubspotBody(111, 50, { subscriptionId: 10_000 + i });
        const started = performance.now();
        const response = await post('/webhooks/hubspot', signed(body));
        latencies.push(performance.now() - started);
        expect(response.status).toBe(200);
      }),
    );
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
    console.info(`[R12 burst, in-memory] ${deliveries} deliveries x 50 events: p50 ${latencies[deliveries / 2]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
    expect(p95).toBeLessThan(2000);
  });
});

describe('R12 account routing on PostgreSQL (multi-tenant)', () => {
  let pg: IsolatedPostgres;
  let appA: App;
  let appB: App;
  let hooks: WebhookIngress;
  let http: HttpApp;

  beforeAll(async () => {
    pg = await startIsolatedPostgres();
    const cipher = new SecretCipher('y'.repeat(32));
    const tenantA = await pg.ensureTenant('hooks-a');
    const tenantB = await pg.ensureTenant('hooks-b');
    const build = (tenantId: string) =>
      createApp({ mock: false, initConnectors: false, scoped: true, database: { db: pg.database, cipher, tenantId } });
    appA = await build(tenantA);
    appB = await build(tenantB);
    const routes = new PostgresAccountRouteStore(pg.database);
    expect(await routes.bind('hubspot', '111', tenantA)).toBe('bound');
    expect(await routes.bind('hubspot', '222', tenantB)).toBe('bound');
    // One account belongs to one workspace.
    expect(await routes.bind('hubspot', '111', tenantB)).toBe('conflict');
    http = await buildHttpApp(appA, {
      runtime: { production: false, authRequired: true, demoRoutes: false, publicBaseUrl: BASE_URL, multiTenant: true },
      tenants: new TenantApps(async (id) => (id === tenantA ? appA : appB)),
      accountRoutes: routes,
      webhooks: { now: () => NOW, secret: async (_system, tenantId) => (tenantId === tenantA ? 'secret-a' : 'secret-b') },
    });
    hooks = http.webhooks;
  }, 120_000);

  afterAll(async () => {
    await Promise.all([appA, appB].filter(Boolean).map((app) => app.sync.stop()));
    await pg?.stop();
  });

  it('routes each delivery to the workspace of its verified account, never another', async () => {
    const toA = await hooks.handle('hubspot', hubspotRequest(hubspotBody(111), { secret: 'secret-a' }));
    const toB = await hooks.handle('hubspot', hubspotRequest(hubspotBody(222, 1, { eventId: 77 }), { secret: 'secret-b' }));
    expect([toA.status, toB.status]).toEqual([200, 200]);
    expect(await appA.webhookInbox.pendingCount()).toBe(1);
    expect(await appB.webhookInbox.pendingCount()).toBe(1);
    // Workspace A's secret cannot deliver into workspace B's portal.
    const forged = await hooks.handle('hubspot', hubspotRequest(hubspotBody(222, 1, { eventId: 78 }), { secret: 'secret-a' }));
    expect(forged).toEqual({ status: 401, body: { error: 'bad_signature' } });
    expect((await hooks.handle('hubspot', hubspotRequest(hubspotBody(333)))).status).toBe(403);
    expect(await appB.webhookInbox.pendingCount()).toBe(1);
  });

  it.runIf(LOAD)('persists atomically and acknowledges bursts within budget on PostgreSQL', { timeout: 120_000 }, async () => {
    const inbox = appA.webhookInbox as PostgresWebhookInbox;
    const deliveries = 100;
    const latencies: number[] = [];
    await Promise.all(
      Array.from({ length: deliveries }, async (_, i) => {
        const started = performance.now();
        const response = await hooks.handle(
          'hubspot',
          hubspotRequest(hubspotBody(111, 20, { subscriptionId: 20_000 + i }), { secret: 'secret-a' }),
        );
        latencies.push(performance.now() - started);
        expect(response.status).toBe(200);
      }),
    );
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
    console.info(`[R12 burst, PostgreSQL] ${deliveries} deliveries x 20 events: p50 ${latencies[deliveries / 2]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`);
    expect(await inbox.pendingCount()).toBe(1 + deliveries * 20);
    expect(p95).toBeLessThan(5000);
  });

  it('a nonce is recorded with its delivery in one transaction', async () => {
    const inbox = appB.webhookInbox;
    const event = { system: 'salesforce' as const, deliveryId: 'n1', nativeObject: 'Contact', sourceId: '003000000000001AAA', changeType: 'updated' as const, occurredAt: new Date().toISOString() };
    const nonce = { system: 'salesforce' as const, value: 'nonce-0000000000001', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    expect(await inbox.accept([event], nonce)).toMatchObject({ accepted: 1 });
    expect(await inbox.accept([{ ...event, deliveryId: 'n2' }], nonce)).toMatchObject({ replayed: true, accepted: 0 });
    expect(() => {
      throw new WebhookRejectedError('replayed');
    }).toThrow('replayed');
  });
});
