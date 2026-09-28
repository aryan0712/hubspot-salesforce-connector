import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { buildHttpApp } from '../src/httpApp.js';
import { ConfigContext, createDefaultConfigContext } from '../src/core/configContext.js';
import { FileMappingStore } from '../src/core/mappingStore.js';
import { MockConnector } from '../src/connectors/mock/mockConnector.js';
import {
  assertSafeRuntime,
  resolveRuntimePolicy,
  UnsafeRuntimeError,
  type RuntimePolicy,
} from '../src/security/runtimeGuard.js';

/**
 * R01 regressions: one app's configuration can never be changed by initializing or using
 * another app, and production refuses unsafe startup configurations.
 */
function liveLikeContext(): ConfigContext {
  const config = createDefaultConfigContext('tenant-a');
  config.registerObjectMapping({
    canonicalObject: 'invoice',
    label: 'Invoice',
    salesforceObject: 'Invoice__c',
    hubspotObject: 'p_invoices',
  });
  config.configureFieldRules('salesforce', 'invoice', [
    { canonical: 'invoiceNumber', native: 'Invoice_Number__c' },
    { canonical: 'status', native: 'Status__c' },
  ]);
  config.configureFieldRules('hubspot', 'invoice', [
    { canonical: 'invoiceNumber', native: 'invoice_number' },
    { canonical: 'status', native: 'invoice_status' },
  ]);
  config.configureNaturalKeyFields('invoice', ['invoiceNumber']);
  config.configureFieldRules('hubspot', 'contact', [
    { canonical: 'email', native: 'work_email' },
    { canonical: 'firstName', native: 'given_name' },
  ]);
  config.configureNaturalKeyFields('contact', ['email']);
  config.configureValueMappings([
    { type: 'invoice', canonicalField: 'status', canonicalValue: 'paid', salesforceValue: 'Paid', hubspotValue: 'settled' },
  ]);
  return config;
}

function snapshotOf(config: ConfigContext) {
  return {
    fingerprint: config.fingerprint(),
    revision: config.revision,
    objects: config.listCanonicalObjects(),
    invoiceRules: config.fieldRules('hubspot', 'invoice'),
    contactRules: config.fieldRules('hubspot', 'contact'),
    invoiceKey: config.naturalKeyFields('invoice'),
    values: config.valueMappings(),
  };
}

describe('R01 configuration isolation', () => {
  it('initializing and using the demo never changes a live-like context', async () => {
    const tenant = liveLikeContext();
    const before = snapshotOf(tenant);

    const demo = await createApp({ mock: true });
    const sf = demo.connectors.salesforce as MockConnector;
    sf.seed('contact', { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' });
    await demo.migration.run({ from: 'salesforce', types: ['contact'], dryRun: false });
    await demo.mappingStore.set('hubspot', 'contact', [{ canonical: 'email', native: 'email' }]);

    expect(snapshotOf(tenant)).toEqual(before);
    expect(demo.config).not.toBe(tenant);
    expect(demo.config.isRegisteredCanonicalObject('invoice')).toBe(false);
    // The tenant's custom value translation and natural key still apply.
    expect(tenant.toCanonicalFields('hubspot', 'invoice', { invoice_number: 'INV-1', invoice_status: 'settled' }))
      .toEqual({ invoiceNumber: 'INV-1', status: 'paid' });
    expect(tenant.naturalKey({
      canonicalId: '',
      type: 'invoice',
      fields: { invoiceNumber: 'INV-1' },
      meta: { source: 'hubspot', sourceId: '1', modifiedAt: new Date().toISOString() },
    })).toBe('invoiceNumber:inv-1');
  });

  it('two demo apps get separate configuration and storage', async () => {
    const first = await createApp({ mock: true });
    const second = await createApp({ mock: true });
    await first.mappingStore.set('hubspot', 'contact', [{ canonical: 'email', native: 'first_email' }]);
    expect(second.config.nativeField('hubspot', 'contact', 'email')).toBe('email');
    (first.connectors.salesforce as MockConnector).seed('contact', { email: 'one@example.com' });
    expect((second.connectors.salesforce as MockConnector).size()).toBe(0);
  });

  it('two tenant contexts can map the same canonical type differently', () => {
    const a = createDefaultConfigContext('tenant-a');
    const b = createDefaultConfigContext('tenant-b');
    a.configureFieldRules('hubspot', 'contact', [{ canonical: 'email', native: 'email' }]);
    b.configureFieldRules('hubspot', 'contact', [{ canonical: 'email', native: 'alt_email' }]);
    const fields = { email: 'ada@example.com' };
    expect(a.fromCanonicalFields('hubspot', 'contact', fields)).toEqual({ email: 'ada@example.com' });
    expect(b.fromCanonicalFields('hubspot', 'contact', fields)).toEqual({ alt_email: 'ada@example.com' });
    const connectorA = new MockConnector('hubspot', a);
    const connectorB = new MockConnector('hubspot', b);
    const idA = connectorA.seed('contact', fields);
    const idB = connectorB.seed('contact', fields);
    expect(connectorA.peek('contact', idA, 'email')).toBe('ada@example.com');
    expect(connectorB.peek('contact', idB, 'alt_email')).toBe('ada@example.com');
  });
});

describe('R01 atomic mapping publication', () => {
  it('publishes a complete snapshot with a new revision and keeps old snapshots stable', () => {
    const config = createDefaultConfigContext('atomic');
    const held = config.current();
    const heldRules = held.fieldRules.hubspot.contact;
    config.configureFieldRules('hubspot', 'contact', [{ canonical: 'email', native: 'email' }]);
    expect(config.revision).toBe(held.revision + 1);
    // A reader holding the previous snapshot keeps one consistent view.
    expect(held.fieldRules.hubspot.contact).toBe(heldRules);
    expect(held.fieldRules.hubspot.contact!.length).toBeGreaterThan(1);
    expect(() => {
      (held.fieldRules.hubspot as Record<string, unknown>).contact = [];
    }).toThrow();
  });

  it('does not publish an invalid change', () => {
    const config = createDefaultConfigContext('invalid');
    const before = config.fingerprint();
    const revision = config.revision;
    expect(() =>
      config.configureFieldRules('hubspot', 'contact', [
        { canonical: 'email', native: 'email' },
        { canonical: 'email', native: 'other' },
      ]),
    ).toThrow('duplicate canonical field');
    expect(() => config.configureNaturalKeyFields('contact', ['LastModifiedDate'])).toThrow();
    expect(config.revision).toBe(revision);
    expect(config.fingerprint()).toBe(before);
  });

  it('does not publish a mapping whose persistence failed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-sync-mapping-'));
    const blocker = path.join(dir, 'not-a-directory');
    await fs.writeFile(blocker, 'x');
    const config = new ConfigContext('persist-first');
    // The store's target sits "inside" a regular file, so every write fails.
    const store = new FileMappingStore(config, path.join(blocker, 'mappings.json'));
    await store.init();
    const before = config.fingerprint();
    await expect(
      store.set('hubspot', 'contact', [{ canonical: 'email', native: 'unsaved_email' }]),
    ).rejects.toThrow();
    expect(config.fingerprint()).toBe(before);
    expect(config.nativeField('hubspot', 'contact', 'email')).toBe('email');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('changes the fingerprint (and notifies listeners) for any mapping change on an object', () => {
    const config = createDefaultConfigContext('fingerprint');
    const changes: string[][] = [];
    config.onChange((change) => changes.push(change.types));
    const contact = config.fingerprint(['contact']);
    const company = config.fingerprint(['company']);
    config.configureValueMappings([
      { type: 'contact', canonicalField: 'title', canonicalValue: 'ceo', hubspotValue: 'CEO' },
    ]);
    expect(config.fingerprint(['contact'])).not.toBe(contact);
    expect(config.fingerprint(['company'])).toBe(company);
    config.configureNaturalKeyFields('company', ['name']);
    expect(config.fingerprint(['company'])).not.toBe(company);
    expect(changes).toEqual([['contact'], ['company']]);
  });
});

describe('R01 mapping changes invalidate approvals', () => {
  it('clears previews and canaries of plans covering the changed object only', async () => {
    const app = await createApp({ mock: true });
    const contactPlan = await app.migrationPlans.create({ name: 'contacts', source: 'salesforce', types: ['contact'] });
    const companyPlan = await app.migrationPlans.create({ name: 'companies', source: 'salesforce', types: ['company'] });
    for (const plan of [contactPlan, companyPlan]) {
      await app.migrationPlans.savePreview(plan.id, plan.revision, `preview-${plan.id}`);
      await app.migrationPlans.saveCanaryPreview(plan.id, plan.revision, plan.types[0]!, 'src-1', `canary-${plan.id}`);
    }
    await app.mappingStore.set('hubspot', 'contact', [{ canonical: 'email', native: 'email' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const contactAfter = await app.migrationPlans.get(contactPlan.id);
    const companyAfter = await app.migrationPlans.get(companyPlan.id);
    expect(contactAfter).toMatchObject({ status: 'draft', previewRunId: undefined, canary: undefined });
    expect(companyAfter?.previewRunId).toBe(`preview-${companyPlan.id}`);
    expect(companyAfter?.canary?.previewRunId).toBe(`canary-${companyPlan.id}`);
  });
});

describe('R01 production guards', () => {
  const policy = (overrides: Partial<RuntimePolicy>): RuntimePolicy => ({
    production: false,
    authRequired: false,
    demoRoutes: true,
    publicBaseUrl: 'http://localhost:3000',
    multiTenant: false,
    ...overrides,
  });

  it('rejects production without authentication', () => {
    expect(() => assertSafeRuntime(policy({ production: true }))).toThrow(UnsafeRuntimeError);
    expect(() => assertSafeRuntime(policy({ production: true, authRequired: true }))).not.toThrow();
  });

  it('rejects a non-loopback public URL without authentication', () => {
    expect(() =>
      assertSafeRuntime(policy({ publicBaseUrl: 'https://crm-sync.example.com' })),
    ).toThrow(UnsafeRuntimeError);
    expect(() => assertSafeRuntime(policy({ publicBaseUrl: 'http://127.0.0.1:3000' }))).not.toThrow();
  });

  it('never enables demo routes in production', () => {
    expect(resolveRuntimePolicy({
      NODE_ENV: 'production',
      AUTH_REQUIRED: true,
      PUBLIC_BASE_URL: 'https://crm-sync.example.com',
      ENABLE_DEMO: true,
    }).demoRoutes).toBe(false);
    expect(resolveRuntimePolicy({
      NODE_ENV: 'development',
      AUTH_REQUIRED: false,
      PUBLIC_BASE_URL: 'http://localhost:3000',
    }).demoRoutes).toBe(true);
  });

  it('refuses to build an unauthenticated production HTTP app', async () => {
    const app = await createApp({ mock: true });
    await expect(buildHttpApp(app, { runtime: policy({ production: true }) })).rejects.toThrow(
      UnsafeRuntimeError,
    );
  });

  it('does not mount demo routes in production and mounts them locally', async () => {
    const app = await createApp({ mock: true });
    const production = await buildHttpApp(app, {
      runtime: policy({ production: true, authRequired: true, demoRoutes: false }),
    });
    const local = await buildHttpApp(app, {
      runtime: policy({}),
      createDemoApp: () => createApp({ mock: true }),
    });
    await withServer(production.server, async (base) => {
      expect((await fetch(`${base}/demo`)).status).toBe(404);
    });
    await withServer(local.server, async (base) => {
      expect((await fetch(`${base}/demo`)).status).toBe(200);
      const status = await fetch(`${base}/api/demo/status`);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ mode: 'demo' });
    });
  });
});

async function withServer(
  server: import('express').Express,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const listener = server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', () => resolve()));
  const { port } = listener.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}

