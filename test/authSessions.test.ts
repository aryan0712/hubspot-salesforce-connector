import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import axios from 'axios';
import { createApp, type App } from '../src/app.js';
import { buildHttpApp, sameAccount, type HttpApp } from '../src/httpApp.js';
import {
  InMemoryIdentityStore,
  LocalPasswordProvider,
  LoginThrottledError,
  SessionService,
} from '../src/security/identity.js';
import { hashPassword, verifyPassword } from '../src/security/passwords.js';
import type { RoleGuard } from '../src/security/access.js';
import { configureConnectionStore, type Connection } from '../src/core/connectionStore.js';
import { configureSettingsStore, type AppCredentials } from '../src/core/settingsStore.js';
import { TenantApps } from '../src/tenancy.js';
import type { RuntimePolicy } from '../src/security/runtimeGuard.js';
import type { SystemId } from '../src/core/types.js';

/** R11: sessions, CSRF, roles and session-bound OAuth state over the real HTTP surface. */

const TENANT = '00000000-0000-4000-8000-00000000000a';
const OTHER_TENANT = '00000000-0000-4000-8000-00000000000b';
const PASSWORD = 'correct horse battery staple';

const runtime: RuntimePolicy = {
  production: false,
  authRequired: true,
  demoRoutes: false,
  publicBaseUrl: 'http://localhost:3000',
  multiTenant: true,
};

let app: App;
let http: HttpApp;
let store: InMemoryIdentityStore;
let sessions: SessionService;
let listener: Server;
let base: string;
const savedConnections = new Map<SystemId, Connection>();
const savedSettings = new Map<SystemId, AppCredentials>();

beforeAll(async () => {
  configureConnectionStore({
    get: async (system) => savedConnections.get(system),
    set: async (connection) => void savedConnections.set(connection.system, { ...connection }),
    update: async () => undefined,
    delete: async (system) => void savedConnections.delete(system),
    all: async () => [...savedConnections.values()],
  });
  configureSettingsStore({
    get: async (system) => savedSettings.get(system),
    set: async (system, creds) => void savedSettings.set(system, creds),
    delete: async (system) => void savedSettings.delete(system),
  });
  savedSettings.set('salesforce', { clientId: 'client-id', clientSecret: 'client-secret' });
  app = await createApp({ mock: true });
  store = new InMemoryIdentityStore();
  sessions = new SessionService(store, new LocalPasswordProvider(store));
  // Both test workspaces are served by the same mock App; isolation between real tenant
  // Apps is covered against PostgreSQL in tenantIsolation.test.ts.
  http = await buildHttpApp(app, { runtime, sessions, tenants: new TenantApps(async () => app) });
  listener = http.server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  for (const [email, role] of [
    ['owner@example.com', 'owner'],
    ['admin@example.com', 'admin'],
    ['operator@example.com', 'operator'],
    ['viewer@example.com', 'viewer'],
  ] as const) {
    await sessions.addMember({ tenantId: TENANT, email, role, password: PASSWORD });
  }
});

afterAll(async () => {
  listener.closeAllConnections();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  await http.stopBackground();
});

beforeEach(() => {
  savedConnections.clear();
  vi.restoreAllMocks();
});

interface Browser {
  cookies: Map<string, string>;
  csrf(): string;
  fetch(path: string, init?: RequestInit & { csrf?: boolean }): Promise<Response>;
}

function browser(): Browser {
  const cookies = new Map<string, string>();
  return {
    cookies,
    csrf: () => decodeURIComponent(cookies.get('crm_csrf') ?? ''),
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers);
      if (cookies.size) headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
      if (init.csrf && cookies.has('crm_csrf')) headers.set('x-csrf-token', decodeURIComponent(cookies.get('crm_csrf')!));
      const response = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const [key, ...value] = pair!.split('=');
        if (/Max-Age=0/.test(cookie)) cookies.delete(key!);
        else cookies.set(key!, value.join('='));
      }
      return response;
    },
  };
}

async function signIn(email: string, password = PASSWORD): Promise<{ b: Browser; response: Response }> {
  const b = browser();
  const response = await b.fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password }).toString(),
  });
  return { b, response };
}

const json = { 'content-type': 'application/json' };

describe('R11 sessions', () => {
  it('signs in with a secure session cookie and a CSRF token', async () => {
    const { b, response } = await signIn('admin@example.com');
    expect(response.status).toBe(303);
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.find((cookie) => cookie.startsWith('crm_session='))).toMatch(/HttpOnly; SameSite=Lax/);
    expect(setCookies.find((cookie) => cookie.startsWith('crm_csrf='))).not.toMatch(/HttpOnly/);
    const session = await (await b.fetch('/api/session')).json();
    expect(session).toMatchObject({ email: 'admin@example.com', role: 'admin', via: 'session', tenantId: TENANT });
  });

  it('rejects unauthenticated requests and a bad password', async () => {
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect((await signIn('admin@example.com', 'wrong password!!')).response.status).toBe(401);
    expect((await signIn('nobody@example.com')).response.status).toBe(401);
  });

  it('requires the CSRF token on every unsafe request made with a session', async () => {
    const { b } = await signIn('owner@example.com');
    const body = JSON.stringify({ email: 'new@example.com', role: 'viewer' });
    expect((await b.fetch('/api/members', { method: 'POST', headers: json, body })).status).toBe(403);
    const wrong = await b.fetch('/api/members', {
      method: 'POST',
      headers: { ...json, 'x-csrf-token': 'forged' },
      body,
    });
    expect(await wrong.json()).toMatchObject({ error: 'csrf_token_invalid', requestId: expect.any(String) });
    expect((await b.fetch('/api/members', { method: 'POST', headers: json, body, csrf: true })).status).toBe(201);
  });

  it('does not accept an API key from a cookie (only as a Bearer header)', async () => {
    const response = await fetch(`${base}/api/status`, { headers: { cookie: 'crm_api_key=crm_whatever' } });
    expect(response.status).toBe(401);
  });

  it('logout revokes the session server-side', async () => {
    const { b } = await signIn('viewer@example.com');
    const token = b.cookies.get('crm_session')!;
    expect((await b.fetch('/auth/logout', { method: 'POST' })).status).toBe(303);
    const replayed = await fetch(`${base}/api/status`, { headers: { cookie: `crm_session=${token}` } });
    expect(replayed.status).toBe(401);
  });

  it('removing a member or changing a role takes effect on the next request', async () => {
    const member = await sessions.addMember({ tenantId: TENANT, email: 'temp@example.com', role: 'admin', password: PASSWORD });
    const { b } = await signIn('temp@example.com');
    expect((await b.fetch('/api/members')).status).toBe(200);
    await store.setMembership({ ...member, role: 'viewer' });
    expect((await b.fetch('/api/members')).status).toBe(403);
    await sessions.removeMember(TENANT, member.userId);
    expect((await b.fetch('/api/session')).status).toBe(401);
  });

  it('enforces the role matrix', async () => {
    const { b: viewer } = await signIn('viewer@example.com');
    const { b: operator } = await signIn('operator@example.com');
    expect((await viewer.fetch('/api/status')).status).toBe(200);
    expect(
      (await viewer.fetch('/api/sync/jobs/x/replay', { method: 'POST', csrf: true })).status,
    ).toBe(403);
    expect(
      (await operator.fetch('/api/connections/salesforce/disconnect', { method: 'POST', csrf: true })).status,
    ).toBe(403);
    expect(
      (await operator.fetch('/api/members', { method: 'POST', headers: json, body: '{}', csrf: true })).status,
    ).toBe(403);
  });

  it('a user cannot switch into a workspace they do not belong to', async () => {
    const { b } = await signIn('admin@example.com');
    const response = await b.fetch('/api/session/workspace', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ tenantId: OTHER_TENANT }),
      csrf: true,
    });
    expect(response.status).toBe(403);
  });

  it('every unsafe API route declares a minimum role', () => {
    const selfService = new Set(['POST /api/session/workspace']);
    const missing: string[] = [];
    let inspected = 0;
    // Walk mounted routers too (route modules, R13).
    const flatten = (layers: RouteLayer[]): RouteLayer[] =>
      layers.flatMap((layer) => (layer.route ? [layer] : layer.handle?.stack ? flatten(layer.handle.stack) : []));
    const stack = flatten((http.server as unknown as { router: { stack: RouteLayer[] } }).router.stack);
    for (const layer of stack) {
      const route = layer.route;
      if (!route || typeof route.path !== 'string' || !route.path.startsWith('/api/')) continue;
      for (const method of Object.keys(route.methods)) {
        if (['get', 'head', 'options'].includes(method)) continue;
        const key = `${method.toUpperCase()} ${route.path}`;
        inspected += 1;
        const guarded = route.stack.some((entry) => (entry.handle as Partial<RoleGuard>).requiredRole);
        if (!guarded && !selfService.has(key)) missing.push(key);
      }
    }
    expect(inspected).toBeGreaterThanOrEqual(40);
    expect(missing).toEqual([]);
  });
});

interface RouteLayer {
  route?: { path: unknown; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle?: { stack?: RouteLayer[] };
}

describe('R11 login throttling', () => {
  it('throttles repeated failures per email and IP, even with the right password afterwards', async () => {
    const identity = new InMemoryIdentityStore();
    const service = new SessionService(identity, new LocalPasswordProvider(identity), { maxFailuresPerEmailAndIp: 3 });
    await service.addMember({ tenantId: TENANT, email: 'x@example.com', role: 'viewer', password: PASSWORD });
    for (let i = 0; i < 3; i += 1) {
      await expect(service.login({ email: 'x@example.com', password: 'nope', ip: '1.1.1.1' })).rejects.toThrow();
    }
    await expect(service.login({ email: 'x@example.com', password: PASSWORD, ip: '1.1.1.1' })).rejects.toBeInstanceOf(
      LoginThrottledError,
    );
    // Another IP is not locked out by someone else's failures on this account (yet).
    await expect(service.login({ email: 'x@example.com', password: PASSWORD, ip: '2.2.2.2' })).resolves.toBeDefined();
  });

  it('caps failures for one account across IPs', async () => {
    const identity = new InMemoryIdentityStore();
    const service = new SessionService(identity, new LocalPasswordProvider(identity), { maxFailuresPerEmail: 4 });
    await service.addMember({ tenantId: TENANT, email: 'y@example.com', role: 'viewer', password: PASSWORD });
    for (let i = 0; i < 4; i += 1) {
      await expect(service.login({ email: 'y@example.com', password: 'nope', ip: `10.0.0.${i}` })).rejects.toThrow();
    }
    await expect(service.login({ email: 'y@example.com', password: PASSWORD, ip: '10.0.0.99' })).rejects.toBeInstanceOf(
      LoginThrottledError,
    );
  });

  it('expires idle and absolute sessions', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const identity = new InMemoryIdentityStore();
    const service = new SessionService(identity, new LocalPasswordProvider(identity), {
      idleMs: 60_000,
      absoluteMs: 10 * 60_000,
      now: () => now,
    });
    await service.addMember({ tenantId: TENANT, email: 'z@example.com', role: 'viewer', password: PASSWORD });
    const idle = await service.login({ email: 'z@example.com', password: PASSWORD, ip: 'a' });
    now += 61_000;
    expect(await service.resolve(idle.token)).toBeUndefined();
    const active = await service.login({ email: 'z@example.com', password: PASSWORD, ip: 'a' });
    for (let i = 0; i < 12; i += 1) {
      now += 50_000; // keeps it alive (sliding idle window) ...
      await service.resolve(active.token);
    }
    expect(await service.resolve(active.token)).toBeUndefined(); // ... until the absolute limit
  });

  it('hashes passwords with salted scrypt', async () => {
    const one = await hashPassword(PASSWORD);
    const two = await hashPassword(PASSWORD);
    expect(one).not.toBe(two);
    expect(one).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword(PASSWORD, one)).toBe(true);
    expect(await verifyPassword('something else', one)).toBe(false);
  });
});

describe('R11 OAuth', () => {
  const tokenResponse = (orgId: string) => ({
    data: {
      refresh_token: `refresh-${orgId}`,
      access_token: `access-${orgId}`,
      instance_url: `https://${orgId.toLowerCase()}.my.salesforce.com`,
      id: `https://login.salesforce.com/id/${orgId}/005000000000001AAA`,
    },
  });

  async function start(b: Browser, system = 'salesforce'): Promise<string> {
    const response = await b.fetch(`/auth/${system}/start?env=production`);
    expect(response.status).toBe(302);
    return new URL(response.headers.get('location')!).searchParams.get('state')!;
  }

  it('requires an authenticated admin to begin OAuth', async () => {
    expect((await fetch(`${base}/auth/salesforce/start`, { redirect: 'manual' })).status).toBe(401);
    const { b } = await signIn('operator@example.com');
    expect((await b.fetch('/auth/salesforce/start')).status).toBe(403);
  });

  it('connects with single-use state bound to the session and system', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue(tokenResponse('00D000000000001AAA'));
    const { b } = await signIn('admin@example.com');
    const state = await start(b);
    // Another admin's session cannot complete this flow.
    const { b: other } = await signIn('owner@example.com');
    expect((await other.fetch(`/auth/salesforce/callback?code=c&state=${state}`)).headers.get('location')).toBe(
      '/?error=oauth_state_invalid',
    );
    // Wrong system with the right state is refused.
    expect((await b.fetch(`/auth/hubspot/callback?code=c&state=${state}`)).headers.get('location')).toBe(
      '/?error=oauth_state_invalid',
    );
    const done = await b.fetch(`/auth/salesforce/callback?code=c&state=${state}`);
    expect(done.headers.get('location')).toBe('/?connected=salesforce');
    expect(savedConnections.get('salesforce')).toMatchObject({ accountId: '00D000000000001AAA' });
    // Reuse is refused.
    expect((await b.fetch(`/auth/salesforce/callback?code=c&state=${state}`)).headers.get('location')).toBe(
      '/?error=oauth_state_invalid',
    );
    // The PKCE verifier bound to the state was sent with the exchange.
    expect(String((post.mock.calls[0]![1] as URLSearchParams).get('code_verifier'))).toMatch(/^[\w-]{43,}$/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('refuses an expired state', async () => {
    const entryState = await app.oauthStates.create(
      {
        tenantId: TENANT,
        sessionHash: 'session',
        userId: 'u',
        system: 'salesforce',
        environment: 'production',
        redirectUri: 'x',
        codeVerifier: 'v',
      },
      -1,
    );
    expect(await app.oauthStates.consume(TENANT, entryState, 'session', 'salesforce')).toBeUndefined();
  });

  it('stages a different account until an admin confirms, then invalidates approvals', async () => {
    const { b } = await signIn('admin@example.com');
    vi.spyOn(axios, 'post').mockResolvedValue(tokenResponse('00D000000000001AAA'));
    await b.fetch(`/auth/salesforce/callback?code=c&state=${await start(b)}`);
    const invalidate = vi.spyOn(app.migrationPlans, 'invalidateApprovals');

    vi.spyOn(axios, 'post').mockResolvedValue(tokenResponse('00D000000000002AAA'));
    const staged = await b.fetch(`/auth/salesforce/callback?code=c&state=${await start(b)}`);
    const location = new URL(staged.headers.get('location')!, base);
    expect(location.searchParams.get('confirm')).toBe('salesforce');
    const pendingId = location.searchParams.get('pending')!;
    // Nothing replaced yet.
    expect(savedConnections.get('salesforce')?.accountId).toBe('00D000000000001AAA');

    const details = await (await b.fetch(`/api/connections/salesforce/pending/${pendingId}`)).json();
    expect(details).toMatchObject({ current: { accountId: '00D000000000001AAA' }, next: { accountId: '00D000000000002AAA' } });
    // Another admin session cannot confirm it; nor can a request without CSRF.
    const { b: other } = await signIn('owner@example.com');
    expect((await other.fetch(`/api/connections/salesforce/pending/${pendingId}/confirm`, { method: 'POST', csrf: true })).status).toBe(404);
    expect((await b.fetch(`/api/connections/salesforce/pending/${pendingId}/confirm`, { method: 'POST' })).status).toBe(403);

    const confirmed = await b.fetch(`/api/connections/salesforce/pending/${pendingId}/confirm`, { method: 'POST', csrf: true });
    expect(await confirmed.json()).toMatchObject({ replaced: true });
    expect(savedConnections.get('salesforce')?.accountId).toBe('00D000000000002AAA');
    // Approvals made against the previous account are invalidated for every object.
    expect(invalidate).toHaveBeenCalledWith(expect.arrayContaining(['contact', 'company', 'deal']));
    // Single use.
    expect((await b.fetch(`/api/connections/salesforce/pending/${pendingId}/confirm`, { method: 'POST', csrf: true })).status).toBe(404);
  });

  it('reauthorizing the same account replaces tokens without confirmation', async () => {
    const { b } = await signIn('admin@example.com');
    vi.spyOn(axios, 'post').mockResolvedValue(tokenResponse('00D000000000001AAA'));
    await b.fetch(`/auth/salesforce/callback?code=c&state=${await start(b)}`);
    const again = await b.fetch(`/auth/salesforce/callback?code=c&state=${await start(b)}`);
    expect(again.headers.get('location')).toBe('/?connected=salesforce');
  });

  it('compares accounts by exact id, then by instance', () => {
    const base = { system: 'salesforce' as const, environment: 'production' as const, refreshToken: 'r', connectedAt: '' };
    expect(sameAccount({ ...base, accountId: 'A' }, { ...base, accountId: 'B' })).toBe(false);
    expect(sameAccount({ ...base, accountId: 'A' }, { ...base, accountId: 'A', instanceUrl: 'x' })).toBe(true);
    expect(sameAccount({ ...base, instanceUrl: 'https://a' }, { ...base, accountId: 'A', instanceUrl: 'https://a' })).toBe(true);
    expect(sameAccount({ ...base }, { ...base, accountId: 'A' })).toBe(false);
    expect(sameAccount({ ...base, accountId: 'A' }, { ...base, accountId: 'A', environment: 'sandbox' })).toBe(false);
  });
});
