import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { CRMConnector } from '../src/core/connector.js';
import type { ChangeEvent, SystemId } from '../src/core/types.js';
import { MockConnector } from '../src/connectors/mock/mockConnector.js';
import { FileIdMapStore } from '../src/core/idMap.js';
import { Reconciler } from '../src/engine/reconciler.js';
import { MigrationEngine } from '../src/engine/migrationEngine.js';

function setup() {
  const sf = new MockConnector('salesforce');
  const hs = new MockConnector('hubspot');
  const connectors: Record<SystemId, CRMConnector> = { salesforce: sf, hubspot: hs };
  const idMap = new FileIdMapStore(path.join(os.tmpdir(), `idmap-test-${crypto.randomUUID()}.json`));
  const events: ChangeEvent[] = [];
  sf.onChange((e) => events.push(e));
  hs.onChange((e) => events.push(e));
  const reconciler = new Reconciler(connectors, idMap);
  const migration = new MigrationEngine(connectors, reconciler);
  return { sf, hs, idMap, reconciler, migration, events };
}

type Ctx = ReturnType<typeof setup>;
let ctx: Ctx;
beforeEach(async () => {
  ctx = setup();
  await ctx.idMap.init();
});

const ada = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@analytical.co', phone: '+1-111' };

describe('migration', () => {
  it('backfills Salesforce contacts into HubSpot and links them', async () => {
    const sfId = ctx.sf.seed('contact', ada);
    await ctx.migration.run({ from: 'salesforce', types: ['contact'] });

    const hsRecs = (await ctx.hs.list('contact')).records;
    expect(hsRecs).toHaveLength(1);
    expect(hsRecs[0]!.fields.email).toBe('ada@analytical.co');

    const link = await ctx.idMap.bySource('salesforce', sfId);
    expect(link?.ids.hubspot).toBe(hsRecs[0]!.meta.sourceId);
  });

  it('is idempotent — re-running migration does not create duplicates', async () => {
    ctx.sf.seed('contact', ada);
    await ctx.migration.run({ from: 'salesforce', types: ['contact'] });
    await ctx.migration.run({ from: 'salesforce', types: ['contact'] });
    expect((await ctx.hs.list('contact')).records).toHaveLength(1);
  });
});

describe('loop prevention', () => {
  it('suppresses echo events caused by our own writes', async () => {
    const sfId = ctx.sf.seed('contact', ada);
    ctx.events.length = 0;
    await ctx.migration.run({ from: 'salesforce', types: ['contact'] });

    // Migration wrote to HubSpot, which emitted "created" webhooks. Replay them.
    const echoes = ctx.events.filter((e) => e.system === 'hubspot');
    expect(echoes.length).toBeGreaterThan(0);

    const sfBefore = await ctx.sf.read('contact', sfId);
    for (const e of echoes) {
      const rec = await ctx.hs.read(e.type, e.sourceId);
      if (rec) await ctx.reconciler.reconcile(rec);
    }
    const sfAfter = await ctx.sf.read('contact', sfId);

    // No echo should have written back to Salesforce → same record count & untouched timestamp.
    expect((await ctx.sf.list('contact')).records).toHaveLength(1);
    expect(sfAfter!.meta.modifiedAt).toBe(sfBefore!.meta.modifiedAt);
  });
});

describe('real-time bidirectional sync', () => {
  it('propagates a HubSpot edit back to Salesforce', async () => {
    const sfId = ctx.sf.seed('contact', ada);
    await ctx.migration.run({ from: 'salesforce', types: ['contact'] });
    const hsId = (await ctx.hs.list('contact')).records[0]!.meta.sourceId;

    // User edits the phone in HubSpot.
    await ctx.hs.upsert(
      { canonicalId: '', type: 'contact', fields: { phone: '+1-999-NEW' }, meta: { source: 'hubspot', sourceId: hsId, modifiedAt: new Date().toISOString() } },
      hsId,
    );
    const edited = await ctx.hs.read('contact', hsId);
    await ctx.reconciler.reconcile(edited!);

    expect(ctx.sf.peek('contact', sfId, 'Phone')).toBe('+1-999-NEW');
  });

  it('resolves concurrent edits by last-write-wins (default strategy)', async () => {
    const sfId = ctx.sf.seed('contact', ada);
    await ctx.migration.run({ from: 'salesforce', types: ['contact'] });
    const hsId = (await ctx.hs.list('contact')).records[0]!.meta.sourceId;

    const now = Date.now();
    // Older edit in HubSpot, newer edit in Salesforce → Salesforce should win.
    await ctx.hs.upsert({ canonicalId: '', type: 'contact', fields: { firstName: 'Robert' }, meta: { source: 'hubspot', sourceId: hsId, modifiedAt: new Date(now).toISOString() } }, hsId);
    ctx.hs.setModifiedAt('contact', hsId, new Date(now).toISOString());
    await ctx.sf.upsert({ canonicalId: '', type: 'contact', fields: { firstName: 'Bob' }, meta: { source: 'salesforce', sourceId: sfId, modifiedAt: new Date(now + 5000).toISOString() } }, sfId);
    ctx.sf.setModifiedAt('contact', sfId, new Date(now + 5000).toISOString());

    const sfEdited = await ctx.sf.read('contact', sfId);
    await ctx.reconciler.reconcile(sfEdited!);

    expect(ctx.hs.peek('contact', hsId, 'firstname')).toBe('Bob');
  });
});
