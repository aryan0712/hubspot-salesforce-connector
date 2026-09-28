import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createApp, type App } from '../../src/app.js';
import { buildHttpApp } from '../../src/httpApp.js';
import { InMemoryIdentityStore, LocalPasswordProvider, SessionService } from '../../src/security/identity.js';
import { configureConnectionStore, type Connection } from '../../src/core/connectionStore.js';
import { configureSettingsStore, type AppCredentials } from '../../src/core/settingsStore.js';
import { TenantApps } from '../../src/tenancy.js';
import type { MockConnector } from '../../src/connectors/mock/mockConnector.js';
import type { SystemId } from '../../src/core/types.js';

/**
 * R13 browser tests: real Chrome (or Edge) against the HTTP app with mock CRMs. They assert
 * visible outcomes -- what an operator sees and can do -- not HTML substrings.
 *
 * `page.evaluate`/`page.waitForFunction` callbacks below run inside the browser, not this
 * (DOM-less) Node/TS project, so `document` and friends are declared loosely here rather
 * than pulling in the "DOM" lib (which would collide with @types/node's fetch/Response
 * globals used everywhere else in the test suite).
 */
declare const document: any;
declare function getComputedStyle(element: any): any;

const TENANT = '00000000-0000-4000-8000-0000000000c1';
const PASSWORD = 'correct horse battery staple';
const OLD = '2020-01-01T00:00:00.000Z';
const NEW = '2025-01-01T00:00:00.000Z';

let app: App;
let server: HttpServer;
let base: string;
let browser: Browser;
let pausedExecutionId: string;
let renamePlanId: string;
let approvedPlanId: string;

async function freePort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function launch(): Promise<Browser> {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // try the next installed browser
    }
  }
  throw new Error('No installed Chrome or Edge found for browser tests');
}

/** Seeds records, passes a one-record test and freezes a full preview (an approved plan). */
async function approvedPlan(name: string, records: number) {
  const sf = app.connectors.salesforce as MockConnector;
  const ids = Array.from({ length: records }, (_, i) =>
    sf.seed('contact', { firstName: `${name}${i}`, lastName: 'Test', email: `${name.toLowerCase()}${i}@example.com` }),
  );
  const plan = await app.migrationPlans.create({ name, source: 'salesforce', types: ['contact'] });
  const canary = await app.migrations.previewRecords({ from: 'salesforce', type: 'contact', sourceIds: [ids[0]!] });
  await app.migrationPlans.saveCanaryPreview(plan.id, plan.revision, 'contact', ids[0]!, canary.runId);
  const verified = await app.migrations.executeCanary(plan.id, canary.runId);
  if (!verified.verification?.passed) throw new Error('canary did not pass in the fixture');
  const preview = await app.migrations.preview({ from: 'salesforce', types: ['contact'] });
  await app.migrationPlans.savePreview(plan.id, plan.revision, preview.runId);
  return plan;
}

/** Seeds records and creates a plan without testing or previewing it (a fresh draft). */
async function draftPlan(name: string, records: number) {
  const sf = app.connectors.salesforce as MockConnector;
  const ids = Array.from({ length: records }, (_, i) =>
    sf.seed('contact', { firstName: `${name}${i}`, lastName: 'Original', email: `${name.toLowerCase()}${i}@example.com` }),
  );
  const plan = await app.migrationPlans.create({ name, source: 'salesforce', types: ['contact'] });
  return { plan, ids };
}

beforeAll(async () => {
  const connections = new Map<SystemId, Connection>();
  const settings = new Map<SystemId, AppCredentials>();
  configureConnectionStore({
    get: async (system) => connections.get(system),
    set: async (connection) => void connections.set(connection.system, connection),
    update: async () => undefined,
    delete: async (system) => void connections.delete(system),
    all: async () => [...connections.values()],
  });
  configureSettingsStore({
    get: async (system) => settings.get(system),
    set: async (system, creds) => void settings.set(system, creds),
    delete: async (system) => void settings.delete(system),
  });

  app = await createApp({ mock: true });
  await app.sync.stop(); // fixtures below must not be processed away underneath the UI
  const identity = new InMemoryIdentityStore();
  const sessions = new SessionService(identity, new LocalPasswordProvider(identity));
  for (const [email, role] of [
    ['admin@example.com', 'admin'],
    ['operator@example.com', 'operator'],
    ['viewer@example.com', 'viewer'],
  ] as const) {
    await sessions.addMember({ tenantId: TENANT, email, role, password: PASSWORD });
  }
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const http = await buildHttpApp(app, {
    runtime: { production: false, authRequired: true, demoRoutes: false, publicBaseUrl: base, multiTenant: true },
    sessions,
    tenants: new TenantApps(async () => app),
  });
  server = http.server.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  // A failed sync job.
  const [jobId] = await app.sync.store.enqueue([
    { system: 'salesforce', type: 'contact', sourceId: '003000000000009AAA', changeType: 'updated', occurredAt: NEW },
  ]);
  await app.sync.store.deadLetter(jobId!, 'HubSpot rejected the email address');

  // A real conflict: both sides changed, HubSpot's newer edit won automatically.
  const sf = app.connectors.salesforce as MockConnector;
  const hs = app.connectors.hubspot as MockConnector;
  const sfId = sf.seed('contact', { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@analytical.co', phone: '+1-000' });
  await app.reconciler.reconcile((await sf.read('contact', sfId))!);
  const hsId = (await app.idMap.bySource('salesforce', sfId, 'contact'))!.ids.hubspot!;
  await sf.upsert({ ...(await sf.read('contact', sfId))!, fields: { ...(await sf.read('contact', sfId))!.fields, phone: '+1-SF' } }, sfId);
  await hs.upsert({ ...(await hs.read('contact', hsId))!, fields: { ...(await hs.read('contact', hsId))!.fields, phone: '+1-HS' } }, hsId);
  sf.setModifiedAt('contact', sfId, OLD);
  hs.setModifiedAt('contact', hsId, NEW);
  await app.reconciler.reconcile((await sf.read('contact', sfId))!);

  // An execution that was paused part-way (resumable run).
  const plan = await approvedPlan('Paused', 3);
  const { execution } = await app.migrations.executePlan(plan.id);
  await app.migrations.pause(execution.id, 'paused for maintenance');
  pausedExecutionId = execution.id;

  renamePlanId = (await app.migrationPlans.create({ name: 'Draft plan', source: 'salesforce', types: ['contact'] })).id;
  approvedPlanId = (await approvedPlan('Approved', 2)).id;

  browser = await launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await app?.inboxProcessor.stop();
});

interface Session {
  context: BrowserContext;
  page: Page;
  problems: string[];
}

/** Signs in with the keyboard only, collecting CSP violations and script errors. */
async function signIn(email: string, viewport = { width: 1280, height: 860 }): Promise<Session> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/status of 40[13]/.test(message.text())) problems.push(message.text());
  });
  await page.goto(`${base}/auth/login`);
  await page.keyboard.press('Tab');
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  try {
    await page.waitForURL(`${base}/ops`, { timeout: 5000 });
    await page.waitForLoadState('networkidle');
  } catch (err) {
    throw new Error(`sign-in did not reach /ops: at ${page.url()} :: ${(await page.content()).slice(0, 600)} :: ${problems.join(' | ')}`);
  }
  return { context, page, problems };
}

describe('R13 operator UX in a real browser', () => {
  it('signs in with the keyboard; pages run under the strict CSP with no script errors', async () => {
    const { context, page, problems } = await signIn('admin@example.com');
    await page.waitForFunction(() => document.getElementById('readiness-label')?.textContent !== 'Checking readiness…');
    await page.goto(`${base}/`);
    await page.waitForLoadState('networkidle');
    const csp = (await page.goto(`${base}/ops`))!.headers()['content-security-policy'];
    expect(csp).toContain("script-src 'self';");
    expect(await page.locator('script:not([src])').count()).toBe(0);
    await page.waitForLoadState('networkidle');
    expect(problems.join(' | ')).toBe('');
    await context.close();
  });

  it('shows the real workspace and readiness instead of a hardcoded status', async () => {
    const { context, page } = await signIn('admin@example.com');
    await expect.poll(() => page.locator('#workspace-name').textContent()).toBe('Workspace · Demo workspace');
    const label = page.locator('#readiness-label');
    await expect.poll(() => label.textContent()).toMatch(/^(Ready|Needs attention \(\d+\))$/);
    // The failed sync job is reported, not hidden behind "healthy".
    expect(await label.textContent()).toMatch(/Needs attention/);
    await label.click();
    expect(await label.getAttribute('aria-expanded')).toBe('true');
    const panel = page.locator('#readiness-panel');
    expect(await panel.isVisible()).toBe(true);
    expect(await panel.textContent()).toContain('1 change(s) need attention');
    await context.close();
  });

  it('explains a role restriction inline with a correlation reference', async () => {
    const { context, page } = await signIn('viewer@example.com');
    await page.goto(`${base}/ops#activity`);
    const replay = page.locator('[data-action="replay"]').first();
    await replay.waitFor();
    await replay.click();
    const error = page.locator('.ui-error');
    await error.waitFor();
    expect(await error.getAttribute('role')).toBe('alert');
    expect(await error.textContent()).toMatch(/requires operator/);
    expect(await error.textContent()).toMatch(/Reference: [\w-]{8,}/);
    // Viewers are told the audit log is for admins instead of seeing a failure.
    await page.locator('[data-activity-tab="audit"]').click();
    expect(await page.locator('#audit').textContent()).toContain('visible to admins');
    await context.close();
  });

  it('lets an operator review a conflict and deliberately keep the other side', async () => {
    const { context, page } = await signIn('operator@example.com');
    await page.goto(`${base}/ops#activity`);
    await page.locator('[data-activity-tab="conflicts"]').click();
    const row = page.locator('#conflict-review tr[data-conflict]').first();
    await row.waitFor();
    expect(await row.textContent()).toContain('automatic');
    expect(await row.textContent()).toContain('+1-SF');
    expect(await row.textContent()).toContain('+1-HS');
    await row.getByRole('button', { name: 'Keep Salesforce' }).click();
    await page.locator('.ui-notice', { hasText: 'Kept Salesforce values' }).waitFor();
    await expect.poll(() => page.locator('#conflict-review tr[data-conflict]').first().textContent()).toContain('resolved by operator');
    const [conflict] = await app.governance.listConflicts();
    expect(conflict).toMatchObject({ resolutionSource: 'manual', decision: expect.objectContaining({ winner: 'salesforce' }) });
    const link = (await app.idMap.bySource('salesforce', conflict!.source.meta.sourceId, 'contact'))!;
    expect((await app.connectors.hubspot.read('contact', link.ids.hubspot!))!.fields.phone).toBe('+1-SF');
    await context.close();
  });

  it('resumes a paused run after a reload, and can pause it again', async () => {
    const { context, page } = await signIn('operator@example.com');
    await page.locator('[data-migrate-open="plans"]').click();
    const view = page.locator(`[data-action="viewExecution"][data-arg="${pausedExecutionId}"]`);
    await view.waitFor();
    await view.click();
    await expect.poll(() => page.locator('#mig-status').textContent()).toContain('paused');
    expect(await page.locator('#mig-status').textContent()).toContain('paused for maintenance');
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect.poll(async () => (await app.migrations.execution(pausedExecutionId))?.status).toBe('running');
    const pause = page.getByRole('button', { name: 'Pause', exact: true });
    await pause.waitFor();
    await pause.click();
    await expect.poll(async () => (await app.migrations.execution(pausedExecutionId))?.status).toBe('paused');
    await context.close();
  });

  it('saves a plan and shows it after a reload', async () => {
    const { context, page } = await signIn('operator@example.com');
    await page.locator('[data-migrate-open="plans"]').click();
    await page.locator(`#saved-plans [data-plan="${renamePlanId}"]`).click();
    await page.locator('#plan-name').fill('Renamed in the browser');
    await page.locator('#save-plan').click();
    await expect.poll(() => page.locator('#save-plan').textContent()).toBe('Saved ✓');
    await page.reload();
    await expect.poll(() => page.locator(`#saved-plans [data-plan="${renamePlanId}"]`).textContent()).toContain('Renamed in the browser');
    expect((await app.migrationPlans.get(renamePlanId))?.name).toBe('Renamed in the browser');
    await context.close();
  });

  it('shows that a mapping change invalidated an approved plan', async () => {
    const { context, page } = await signIn('operator@example.com');
    const card = page.locator(`#saved-plans [data-plan="${approvedPlanId}"]`);
    await expect.poll(() => card.textContent()).toContain('One-record test passed');
    const before = await card.locator('.pill').textContent();
    // An operator edits the contact field mapping (through the API, as the mapping studio does).
    const { status, original } = await page.evaluate(async () => {
      const current = (await (await fetch('/api/mappings/salesforce/contact')).json()) as
        | { rules: { canonical: string }[] }
        | { canonical: string }[];
      const original = 'rules' in current ? current.rules : current;
      const rules = original.filter((rule) => rule.canonical !== 'phone');
      const put = await fetch('/api/mappings/salesforce/contact', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules }),
      });
      return { status: put.status, original };
    });
    try {
      expect(status).toBe(200);
      await page.reload();
      await expect.poll(() => card.textContent()).toContain('One-record test required');
      expect(await card.locator('.pill').textContent()).not.toBe(before);
    } finally {
      // Restore the mapping: this config is global (shared by every plan and every later test
      // in this file), not scoped to this one plan's revision.
      await page.evaluate(
        async (rules) =>
          fetch('/api/mappings/salesforce/contact', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rules }),
          }),
        original,
      );
    }
    await context.close();
  });

  it('a double click on Run full migration only executes the plan once', async () => {
    const plan = await approvedPlan('DoubleClick', 2);
    const email = 'doubleclick1@example.com'; // the plan's one untested record; index 0 was already canary-written
    const { context, page } = await signIn('operator@example.com');
    // Two concurrent requests through the browser's own session/CSRF token -- this exercises the
    // server's exclusivity guarantee (R03), not the typed-confirmation modal's own debounce, so it
    // bypasses the modal and drives the endpoint the "Run migration" button itself calls.
    const results: { status: number; executionId?: string }[] = await page.evaluate(async (planId) => {
      const fire = () =>
        fetch(`/api/migration-plans/${planId}/execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        }).then(async (response) => ({ status: response.status, executionId: ((await response.json()) as any)?.execution?.id }));
      return Promise.all([fire(), fire()]);
    }, plan.id);
    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === 202)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    // Nothing auto-drains executions in this harness (that's a separate worker process in
    // production); settle the one accepted execution deterministically instead of polling. A
    // full migration covers every Salesforce contact, not just this plan's own two records, so
    // it also sweeps up untested records left behind by earlier fixtures in this shared app --
    // the guarantee under test is that *this* record was written exactly once, not a fixed
    // total write count.
    const executionId = results.find((result) => result.status === 202)!.executionId!;
    await app.migrations.worker.runUntilIdle(executionId);
    expect((await app.migrationPlans.get(plan.id))?.status).toBe('completed');
    const hs = app.connectors.hubspot as MockConnector;
    expect(hs.writes.filter((w) => w.payload.email === email)).toHaveLength(1);
    expect((await hs.list('contact')).records.filter((r) => r.fields.email === email)).toHaveLength(1);
    await context.close();
  });

  it('a failing one-record test blocks the full migration and explains why', async () => {
    const { plan, ids } = await draftPlan('Canary', 1);
    const hs = app.connectors.hubspot as MockConnector;
    const write = hs.write.bind(hs);
    // The destination silently drops a mapped field (same technique as canaryVerification.test.ts).
    hs.write = async (type, payload, targetId, options) => {
      const { lastname: _dropped, ...rest } = payload;
      return write(type, rest, targetId, options);
    };
    try {
      const { context, page } = await signIn('operator@example.com');
      await page.locator('[data-migrate-open="plans"]').click();
      await page.locator(`#saved-plans [data-plan="${plan.id}"]`).click();
      await page.locator('.workspace-step[data-step="preview"]').click();
      // The source select defaults to whatever record the connector lists first, which by now
      // includes contacts seeded by earlier fixtures too -- pick this plan's own record explicitly.
      await page.locator('#test-record-source').selectOption(ids[0]!);
      const executeCanary = page.locator('#execute-canary');
      try {
        await expect.poll(() => executeCanary.isDisabled()).toBe(false);
      } catch (err) {
        throw new Error(`${(err as Error).message} :: mig-status=${await page.locator('#mig-status').textContent()}`);
      }
      await executeCanary.click();
      const modal = page.locator('#typed-confirmation');
      await modal.waitFor();
      await page.locator('#typed-confirm-input').fill('TEST');
      await page.locator('#typed-confirm-submit').click();
      await expect.poll(() => page.locator('#mig-status').textContent()).toContain('did not match');
      expect(await page.locator('#mig-status').textContent()).toContain('Not verified:');
      expect(await page.locator('#full-migration').isHidden()).toBe(true);
      expect(await page.locator('#execute').isDisabled()).toBe(true);
      expect((await app.migrationPlans.get(plan.id))?.canary?.verifiedAt).toBeUndefined();
      await context.close();
    } finally {
      hs.write = write;
    }
  });

  for (const path of ['/auth/login', '/', '/ops']) {
    it(`fits a phone-width screen without sideways scrolling: ${path}`, async () => {
      const { context, page } = await signIn('admin@example.com', { width: 390, height: 844 });
      await page.goto(`${base}${path}`);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const offenders = [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().right > width + 1 && getComputedStyle(el).position !== 'fixed')
          .filter((el, _i, all) => !all.some((other) => other !== el && el.contains(other)))
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')} right=${Math.round(el.getBoundingClientRect().right)}`);
        return { excess: document.documentElement.scrollWidth - width, offenders };
      });
      expect(overflow.excess, overflow.offenders.join(' | ')).toBeLessThanOrEqual(1);
      await context.close();
    });
  }
});
