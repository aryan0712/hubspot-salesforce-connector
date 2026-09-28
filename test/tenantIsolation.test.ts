import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, type App } from '../src/app.js';
import { buildHttpApp, type HttpApp } from '../src/httpApp.js';
import { SecretCipher } from '../src/db/security.js';
import { assertRuntimeRole, inspectRuntimeRole } from '../src/db/roles.js';
import { connections } from '../src/core/connectionStore.js';
import { requireTenantScope, runInTenant } from '../src/core/tenantScope.js';
import { TenantApps } from '../src/tenancy.js';
import type { RuntimePolicy } from '../src/security/runtimeGuard.js';
import type { CanonicalRecord } from '../src/core/types.js';
import { startIsolatedPostgres, type IsolatedPostgres } from './helpers/postgres.js';

/**
 * R11 acceptance: tenant A cannot read, edit, execute, replay or resolve tenant B's data
 * through any API or worker path -- tested with the restricted runtime role (no superuser,
 * no BYPASSRLS, owns nothing), exactly the privileges the deployed runtime has.
 */

const PASSWORD = 'correct horse battery staple';
const runtime: RuntimePolicy = {
  production: false,
  authRequired: true,
  demoRoutes: false,
  publicBaseUrl: 'http://localhost:3000',
  multiTenant: true,
};

let pg: IsolatedPostgres;
let tenantA: string;
let tenantB: string;
let appA: App;
let appB: App;
let http: HttpApp;
let listener: Server;
let base: string;
let bJobId: string;
let bConflictId: string;
let bPlanId: string;

async function build(tenantId: string): Promise<App> {
  return createApp({
    mock: false,
    initConnectors: false,
    scoped: true,
    database: { db: pg.database, cipher: new SecretCipher('x'.repeat(32)), tenantId },
  });
}

beforeAll(async () => {
  requireTenantScope(true); // multi-tenant processes fail closed outside a tenant scope
  pg = await startIsolatedPostgres();
  tenantA = await pg.ensureTenant('alpha');
  tenantB = await pg.ensureTenant('beta');
  appA = await build(tenantA);
  appB = await build(tenantB);
  const tenants = new TenantApps(async (id) => (id === tenantA ? appA : id === tenantB ? appB : build(id)));
  http = await buildHttpApp(appA, { runtime, tenants });
  await http.sessions.addMember({ tenantId: tenantA, email: 'alice@a.example', role: 'owner', password: PASSWORD });
  await http.sessions.addMember({ tenantId: tenantB, email: 'bob@b.example', role: 'owner', password: PASSWORD });
  listener = http.server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  // Tenant B's data.
  bJobId = (await appB.sync.store.enqueue([
    { system: 'salesforce', type: 'contact', sourceId: '003B', changeType: 'updated', occurredAt: new Date().toISOString() },
  ]))[0]!;
  await appB.sync.store.deadLetter(bJobId!, 'failed in B');
  const record: CanonicalRecord = {
    canonicalId: '11111111-1111-4111-8111-111111111111',
    type: 'contact',
    fields: { email: 'b@b.example' },
    meta: { source: 'salesforce', sourceId: '003B', modifiedAt: new Date().toISOString() },
  };
  await appB.idMap.upsertLink({
    canonicalId: record.canonicalId,
    type: 'contact',
    ids: { salesforce: '003B', hubspot: '501' },
    hashes: {},
    modifiedAt: {},
    updatedAt: new Date().toISOString(),
  });
  await appB.governance.recordConflict({
    linkId: record.canonicalId,
    type: 'contact',
    source: record,
    target: record,
    strategy: 'last-write-wins',
    resolution: record,
  });
  bConflictId = (await appB.governance.listConflicts())[0]!.id;
  bPlanId = (await appB.migrationPlans.create({ name: 'B plan', source: 'salesforce', types: ['contact'] })).id;
}, 120_000);

afterAll(async () => {
  listener?.closeAllConnections();
  await new Promise<void>((resolve) => (listener ? listener.close(() => resolve()) : resolve()));
  await Promise.all([appA, appB].filter(Boolean).map((app) => app.sync.stop()));
  requireTenantScope(false);
  await pg?.stop();
});

async function signIn(email: string): Promise<(path: string, init?: RequestInit) => Promise<Response>> {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password: PASSWORD }).toString(),
    redirect: 'manual',
  });
  expect(response.status).toBe(303);
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]!);
  const csrf = decodeURIComponent(cookies.find((cookie) => cookie.startsWith('crm_csrf='))!.split('=')[1]!);
  return (path, init = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie: cookies.join('; '), 'x-csrf-token': csrf, ...init.headers },
    });
}

describe('R11 database privileges', () => {
  it('runs as a restricted role that cannot bypass row-level security', async () => {
    const info = await inspectRuntimeRole(pg.database);
    expect(info).toMatchObject({ superuser: false, bypassRls: false, ownedTables: 0 });
    expect(() => assertRuntimeRole(info, true)).not.toThrow();
    expect(() => assertRuntimeRole({ ...info, bypassRls: true }, true)).toThrow(/BYPASSRLS/);
    expect(() => assertRuntimeRole({ ...info, ownedTables: 3 }, true)).toThrow(/owns 3/);
    // The runtime role cannot change the schema or its history.
    await expect(pg.database.pool.query('ALTER TABLE sync_events DISABLE ROW LEVEL SECURITY')).rejects.toThrow();
    await expect(pg.database.pool.query("DELETE FROM schema_migrations WHERE version = 'x'")).rejects.toThrow();
  });

  it('every tenant-owned table has forced row-level security and a policy', async () => {
    const result = await pg.database.pool.query<{ table: string; rls: boolean; forced: boolean; policies: string }>(
      `SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns col
                     WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id')`,
    );
    // Global by design (no tenant data): user_sessions is identity, looked up only by an
    // unguessable token hash; account_routes maps a CRM account to its workspace so an
    // inbound webhook (which names only the account) can be routed.
    const tenantTables = result.rows.filter((row) => !['user_sessions', 'account_routes'].includes(row.table));
    expect(tenantTables.length).toBeGreaterThan(25);
    const unprotected = tenantTables.filter((row) => !row.rls || !row.forced || Number(row.policies) === 0);
    expect(unprotected.map((row) => row.table)).toEqual([]);
  });

  it('raw queries see and write only the scoped tenant, and nothing without a scope', async () => {
    const visible = await pg.database.tenant(tenantA, async (client) =>
      (await client.query('SELECT count(*)::int AS n FROM sync_events WHERE tenant_id = $1', [tenantB])).rows[0].n,
    );
    expect(visible).toBe(0);
    await expect(
      pg.database.tenant(tenantA, (client) =>
        client.query(
          `INSERT INTO audit_entries(tenant_id, action, resource_type, detail) VALUES ($1,'x','y','{}')`,
          [tenantB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const unscoped = await pg.database.pool.query('SELECT count(*)::int AS n FROM sync_events');
    expect(unscoped.rows[0].n).toBe(0);
  });

  it('a sign-in transaction sees only that user\'s own memberships', async () => {
    const alice = (await http.sessions.store.userByEmail('alice@a.example'))!;
    const rows = await pg.database.asUser(alice.id, async (client) =>
      (await client.query<{ tenant_id: string }>('SELECT tenant_id FROM tenant_users')).rows,
    );
    expect(rows.map((row) => row.tenant_id)).toEqual([tenantA]);
  });
});

describe('R11 API isolation', () => {
  it('tenant A cannot read, replay, dismiss or approve tenant B jobs', async () => {
    const alice = await signIn('alice@a.example');
    const jobsBody = (await (await alice('/api/sync/jobs')).json()) as { entries: { id: string }[] };
    const jobs = jobsBody.entries;
    expect(jobs.map((job) => job.id)).not.toContain(bJobId);
    for (const action of ['replay', 'dismiss', 'approve-delete']) {
      expect((await alice(`/api/sync/jobs/${bJobId}/${action}`, { method: 'POST' })).status).toBe(404);
    }
    expect((await appB.sync.store.get(bJobId))?.status).toBe('dead_letter');
  });

  it('tenant A cannot see or resolve tenant B conflicts', async () => {
    const alice = await signIn('alice@a.example');
    const conflictsBody = (await (await alice('/api/conflicts')).json()) as { entries: unknown[] };
    expect(conflictsBody.entries).toEqual([]);
    const resolve = await alice(`/api/conflicts/${bConflictId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ winner: 'salesforce' }),
    });
    expect(resolve.status).toBe(404);
    expect((await appB.governance.getConflict(bConflictId))?.resolutionSource).toBe('automatic');
  });

  it('tenant A cannot read, change or execute tenant B plans; B can', async () => {
    const alice = await signIn('alice@a.example');
    const bob = await signIn('bob@b.example');
    expect((await alice(`/api/migration-plans/${bPlanId}`)).status).toBe(404);
    expect(
      (await alice(`/api/migration-plans/${bPlanId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'pwned', source: 'salesforce', types: ['contact'] }),
      })).status,
    ).toBe(404);
    expect((await alice(`/api/migration-plans/${bPlanId}/execute`, { method: 'POST', body: '{}' })).status).toBeGreaterThanOrEqual(400);
    const plans = (await (await alice('/api/migration-plans')).json()) as { entries?: { id: string }[] } | { id: string }[];
    const ids = (Array.isArray(plans) ? plans : plans.entries ?? []).map((plan) => plan.id);
    expect(ids).not.toContain(bPlanId);
    // Bob's requests are routed to tenant B's App.
    expect((await bob(`/api/migration-plans/${bPlanId}`)).status).toBe(200);
    expect((await appB.migrationPlans.get(bPlanId))?.name).toBe('B plan');
    const bobSession = (await bob('/api/session').then((r) => r.json())) as { tenantId: string };
    expect(bobSession.tenantId).toBe(tenantB);
  });

  it('a user cannot switch into another workspace', async () => {
    const alice = await signIn('alice@a.example');
    const response = await alice('/api/session/workspace', { method: 'POST', body: JSON.stringify({ tenantId: tenantB }) });
    expect(response.status).toBe(403);
  });

  it('an API key works only in its own workspace and cannot be re-pointed', async () => {
    const created = await appA.apiKeys!.create('ci', 'operator');
    const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
    expect((await fetch(`${base}/api/migration-plans/${bPlanId}`, { headers: bearer(created.key) })).status).toBe(404);
    const keySession = (await fetch(`${base}/api/session`, { headers: bearer(created.key) }).then((r) => r.json())) as {
      tenantId: string;
    };
    expect(keySession.tenantId).toBe(tenantA);
    // Swapping the embedded workspace id for B's does not verify.
    const forged = created.key.replace(tenantA.replace(/-/g, ''), tenantB.replace(/-/g, ''));
    expect((await fetch(`${base}/api/session`, { headers: bearer(forged) })).status).toBe(401);
  });
});

describe('R11 worker and store isolation', () => {
  it('a tenant worker never claims another tenant\'s jobs', async () => {
    await appB.sync.store.enqueue([
      { system: 'hubspot', type: 'contact', sourceId: '201', changeType: 'updated', occurredAt: new Date().toISOString() },
    ]);
    const claimed = await appA.sync.store.claim(50, 'worker-a');
    expect(claimed).toEqual([]);
    expect((await appB.sync.store.stats()).queued).toBeGreaterThanOrEqual(1);
  });

  it('OAuth state and connections are bound to their workspace', async () => {
    const state = await appA.oauthStates.create({
      tenantId: tenantA,
      sessionHash: 's',
      userId: 'u',
      system: 'salesforce',
      environment: 'production',
      redirectUri: 'r',
      codeVerifier: 'v',
    });
    expect(await appB.oauthStates.consume(tenantB, state, 's', 'salesforce')).toBeUndefined();
    expect(await appA.oauthStates.consume(tenantA, state, 's', 'salesforce')).toMatchObject({ codeVerifier: 'v' });

    await runInTenant(appA.scope!, () =>
      connections.set({ system: 'hubspot', environment: 'production', refreshToken: 'a-token', connectedAt: new Date().toISOString() }),
    );
    expect(await runInTenant(appB.scope!, () => connections.get('hubspot'))).toBeUndefined();
    expect((await runInTenant(appA.scope!, () => connections.get('hubspot')))?.refreshToken).toBe('a-token');
    // Outside any workspace, tenant stores are unreachable (fail closed).
    await expect(async () => connections.get('hubspot')).rejects.toThrow(/outside a tenant scope/);
  });
});
