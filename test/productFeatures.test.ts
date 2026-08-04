import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { CRMConnector } from '../src/core/connector.js';
import type { ChangeEvent, SystemId } from '../src/core/types.js';
import { MockConnector } from '../src/connectors/mock/mockConnector.js';
import { FileIdMapStore } from '../src/core/idMap.js';
import { Reconciler } from '../src/engine/reconciler.js';
import { MigrationEngine } from '../src/engine/migrationEngine.js';
import {
  AssociationEngine,
  InMemoryAssociationStore,
} from '../src/engine/associationEngine.js';
import { InMemorySyncEventStore } from '../src/engine/syncEventStore.js';
import { SyncEngine } from '../src/engine/syncEngine.js';
import { InMemoryMigrationPlanStore } from '../src/engine/migrationPlanStore.js';

async function setup() {
  const sf = new MockConnector('salesforce');
  const hs = new MockConnector('hubspot');
  const connectors: Record<SystemId, CRMConnector> = { salesforce: sf, hubspot: hs };
  const idMap = new FileIdMapStore(
    path.join(os.tmpdir(), `idmap-features-${crypto.randomUUID()}.json`),
  );
  await idMap.init();
  const reconciler = new Reconciler(connectors, idMap);
  const associations = new AssociationEngine(
    connectors,
    idMap,
    new InMemoryAssociationStore(),
  );
  const migration = new MigrationEngine(connectors, reconciler);
  return { sf, hs, connectors, idMap, reconciler, associations, migration };
}

describe('safe migration product features', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('links a pre-existing target record that was never in the ID map', async () => {
    const sfId = ctx.sf.seed('contact', {
      firstName: 'Ada',
      email: 'ada@example.com',
    });
    const hsId = ctx.hs.seed('contact', {
      firstName: 'Ada',
      email: 'ada@example.com',
    });

    await ctx.migration.run({ from: 'salesforce', types: ['contact'] });

    expect((await ctx.hs.list('contact')).records).toHaveLength(1);
    const link = await ctx.idMap.bySource('salesforce', sfId);
    expect(link?.ids.hubspot).toBe(hsId);
  });

  it('reports ambiguous target matches instead of guessing or creating', async () => {
    ctx.sf.seed('contact', { email: 'duplicate@example.com' });
    ctx.hs.seed('contact', { email: 'duplicate@example.com' });
    ctx.hs.seed('contact', { email: 'duplicate@example.com' });

    const report = await ctx.migration.run({
      from: 'salesforce',
      types: ['contact'],
      dryRun: true,
    });

    expect(report.plans[0]?.action).toBe('ambiguous');
    expect(report.perType.contact?.actions.ambiguous).toBe(1);
    expect((await ctx.hs.list('contact')).records).toHaveLength(2);
  });

  it('previews creates and field diffs without writing records', async () => {
    ctx.sf.seed('company', { name: 'Analytical Engines', domain: 'analytical.test' });
    const report = await ctx.migration.run({
      from: 'salesforce',
      types: ['company'],
      dryRun: true,
    });
    expect(report.mode).toBe('preview');
    expect(report.plans[0]).toMatchObject({ action: 'create', type: 'company' });
    expect(report.plans[0]?.fieldDiff.map((item) => item.field)).toContain('domain');
    expect((await ctx.hs.list('company')).records).toHaveLength(0);
  });

  it('keeps relationship propagation in the separate live-sync core', async () => {
    const companyId = ctx.sf.seed('company', {
      name: 'Analytical Engines',
      domain: 'analytical.test',
    });
    const contactId = ctx.sf.seed('contact', {
      firstName: 'Ada',
      email: 'ada@analytical.test',
    });
    ctx.sf.link('contact', contactId, 'company', companyId);

    await ctx.reconciler.reconcile((await ctx.sf.read('company', companyId))!);
    const sourceContact = (await ctx.sf.read('contact', contactId))!;
    await ctx.reconciler.reconcile(sourceContact);
    await ctx.associations.syncRecord(sourceContact);

    const targetContact = (await ctx.hs.list('contact')).records[0]!;
    const targetCompany = (await ctx.hs.list('company')).records[0]!;
    expect(await ctx.hs.listAssociations('contact', targetContact.meta.sourceId)).toContainEqual({
      toType: 'company',
      toId: targetCompany.meta.sourceId,
      kind: 'company',
      label: undefined,
    });
  });

  it('discovers supported and catalog-only CRM objects', async () => {
    const objects = await ctx.sf.listObjects();
    expect(objects.find((object) => object.id === 'Contact')?.canonicalType).toBe('contact');
    expect(objects.find((object) => object.id === 'Case')?.canonicalType).toBeUndefined();
  });

  it('executes the exact reviewed preview', async () => {
    ctx.sf.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });
    const preview = await ctx.migration.run({
      from: 'salesforce',
      types: ['contact'],
      dryRun: true,
    });
    const report = await ctx.migration.executePreview(preview.runId);
    expect(report.mode).toBe('execute');
    expect((await ctx.hs.list('contact')).records).toHaveLength(1);
  });

  it('previews and executes exactly one explicitly selected test record', async () => {
    const firstId = ctx.sf.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });
    const secondId = ctx.sf.seed('contact', { firstName: 'Grace', email: 'grace@example.com' });

    const preview = await ctx.migration.previewRecord({
      from: 'salesforce',
      type: 'contact',
      sourceId: secondId,
    });

    expect(preview.plans).toHaveLength(1);
    expect(preview.plans[0]?.sourceId).toBe(secondId);
    expect(preview.plans[0]?.sourceId).not.toBe(firstId);
    expect((await ctx.hs.list('contact')).records).toHaveLength(0);

    await ctx.migration.executePreview(preview.runId);
    const targets = (await ctx.hs.list('contact')).records;
    expect(targets).toHaveLength(1);
    expect(targets[0]?.fields.email).toBe('grace@example.com');
  });

  it('rejects preview drift before writing any records', async () => {
    const sourceId = ctx.sf.seed('contact', {
      firstName: 'Ada',
      email: 'ada@example.com',
    });
    const preview = await ctx.migration.run({
      from: 'salesforce',
      types: ['contact'],
      dryRun: true,
    });
    const changed = await ctx.sf.read('contact', sourceId);
    changed!.fields.firstName = 'Grace';
    await ctx.sf.upsert(changed!, sourceId);

    await expect(ctx.migration.executePreview(preview.runId)).rejects.toThrow('preview drift');
    expect((await ctx.hs.list('contact')).records).toHaveLength(0);
  });
});

describe('migration plan drafts', () => {
  it('versions edits and invalidates stale previews', async () => {
    const store = new InMemoryMigrationPlanStore();
    const plan = await store.create({
      name: 'Initial migration',
      source: 'salesforce',
      types: ['contact'],
    });
    await store.saveValidation(plan.id, plan.revision, { 'salesforce:contact': 'a' });
    await store.savePreview(plan.id, plan.revision, 'preview-1');
    await store.saveCanaryPreview(
      plan.id,
      plan.revision,
      'contact',
      'source-contact-1',
      'canary-preview-1',
    );
    await store.finishCanary(plan.id, plan.revision, 'canary-execute-1');
    expect((await store.get(plan.id))?.canary).toMatchObject({
      type: 'contact',
      sourceId: 'source-contact-1',
      previewRunId: 'canary-preview-1',
      executionRunId: 'canary-execute-1',
    });
    const updated = await store.update(plan.id, {
      name: 'Initial migration',
      source: 'salesforce',
      types: ['contact', 'company'],
    });
    expect(updated).toMatchObject({
      revision: 2,
      status: 'draft',
      previewRunId: undefined,
      previewRevision: undefined,
      canary: undefined,
    });
  });
});

describe('durable sync semantics', () => {
  it('deduplicates repeated webhook deliveries by event id', async () => {
    const ctx = await setup();
    const sfId = ctx.sf.seed('contact', {
      firstName: 'Ada',
      email: 'ada@example.com',
    });
    const store = new InMemorySyncEventStore();
    const sync = new SyncEngine(ctx.connectors, ctx.reconciler, store);
    await sync.init();
    const event: ChangeEvent = {
      eventId: 'vendor-event-1',
      system: 'salesforce',
      type: 'contact',
      sourceId: sfId,
      changeType: 'updated',
      occurredAt: new Date().toISOString(),
    };
    await sync.enqueue([event, event]);
    await sync.drain();
    const stats = await sync.stats();
    expect(stats.completed).toBe(1);
    expect((await ctx.hs.list('contact')).records).toHaveLength(1);
  });

  it('routes delete events to manual review by default', async () => {
    const ctx = await setup();
    const sfId = ctx.sf.seed('contact', { email: 'delete@example.com' });
    await ctx.migration.run({ from: 'salesforce', types: ['contact'] });
    const hsId = (await ctx.hs.list('contact')).records[0]!.meta.sourceId;
    const store = new InMemorySyncEventStore();
    const sync = new SyncEngine(ctx.connectors, ctx.reconciler, store, {
      deletePolicy: 'manual-review',
    });
    await sync.init();
    const [jobId] = await sync.enqueue([
      {
        eventId: 'delete-1',
        system: 'salesforce',
        type: 'contact',
        sourceId: sfId,
        changeType: 'deleted',
        occurredAt: new Date().toISOString(),
      },
    ]);
    await sync.drain();
    expect((await sync.stats()).manualReview).toBe(1);
    await sync.approveDelete(jobId!);
    expect(await ctx.hs.read('contact', hsId)).toBeNull();
    expect((await sync.stats()).completed).toBe(1);
  });
});
