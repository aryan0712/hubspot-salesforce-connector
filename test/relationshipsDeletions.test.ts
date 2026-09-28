import { describe, it, expect } from 'vitest';
import type { CRMConnector, ConnectorAssociation } from '../src/core/connector.js';
import type { CanonicalType, ChangeEvent, SystemId } from '../src/core/types.js';
import { MockConnector } from '../src/connectors/mock/mockConnector.js';
import { HubSpotConnector } from '../src/connectors/hubspot/hubspotConnector.js';
import { FileIdMapStore } from '../src/core/idMap.js';
import { createDefaultConfigContext, type ConfigContext } from '../src/core/configContext.js';
import { Reconciler } from '../src/engine/reconciler.js';
import {
  AssociationEngine,
  InMemoryAssociationStore,
  UnsupportedAssociationError,
} from '../src/engine/associationEngine.js';
import { InMemoryGovernanceStore } from '../src/engine/governanceStore.js';
import { MigrationEngine } from '../src/engine/migrationEngine.js';
import { SyncEngine } from '../src/engine/syncEngine.js';
import { InMemorySyncEventStore } from '../src/engine/syncEventStore.js';
import { NEW, OLD } from './helpers/harness.js';

/** R10 regressions: relationships, deletions/tombstones and inspectable conflicts. */

/** A destination that cannot represent a "Board" labeled relationship. */
class LabelLimitedMock extends MockConnector {
  override async associate(fromType: CanonicalType, fromId: string, association: ConnectorAssociation) {
    if (association.label === 'Board') throw new UnsupportedAssociationError('no Board label');
    return super.associate(fromType, fromId, association);
  }
}

async function setup(config: ConfigContext = createDefaultConfigContext('r10')) {
  const sf = new MockConnector('salesforce', config);
  const hs = new LabelLimitedMock('hubspot', config);
  const connectors: Record<SystemId, CRMConnector> = { salesforce: sf, hubspot: hs };
  const idMap = new FileIdMapStore(null);
  await idMap.init();
  const governance = new InMemoryGovernanceStore();
  const conflict = { strategy: 'last-write-wins' as const, sourceOfTruth: 'salesforce' as SystemId };
  const reconciler = new Reconciler(connectors, idMap, config, {
    governance,
    conflictOptions: () => ({ ...conflict }),
  });
  const store = new InMemoryAssociationStore();
  const associations = new AssociationEngine(connectors, idMap, store);
  /** What the sync worker does for one record: reconcile, then its relationships. */
  const syncRecord = async (system: SystemId, type: CanonicalType, id: string) => {
    const record = await connectors[system].read(type, id);
    await reconciler.reconcile(record!);
    return associations.syncRecord(record!);
  };
  return { config, sf, hs, connectors, idMap, governance, reconciler, store, associations, syncRecord };
}

const ada = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@analytical.co' };
const acme = { name: 'Acme', domain: 'acme.com' };

describe('R10 relationships', () => {
  it('a contact processed before its company gains the relationship without a new contact edit', async () => {
    const t = await setup();
    const companyId = t.sf.seed('company', acme);
    const contactId = t.sf.seed('contact', ada);
    t.sf.link('contact', contactId, 'company', companyId);

    const first = await t.syncRecord('salesforce', 'contact', contactId);
    expect(first).toMatchObject({ synced: 0, deferred: 1 });
    expect(await t.associations.listPending(10, 'pending')).toHaveLength(1);

    // Only the company is synced afterwards; the contact is never edited again.
    const second = await t.syncRecord('salesforce', 'company', companyId);
    expect(second.synced).toBe(1);

    const hsContact = (await t.idMap.bySource('salesforce', contactId, 'contact'))!.ids.hubspot!;
    const hsCompany = (await t.idMap.bySource('salesforce', companyId, 'company'))!.ids.hubspot!;
    expect(await t.hs.listAssociations('contact', hsContact)).toEqual([
      expect.objectContaining({ toType: 'company', toId: hsCompany }),
    ]);
    expect(await t.associations.listPending(10, 'pending')).toHaveLength(0);
    expect(await t.associations.listPending(10, 'resolved')).toHaveLength(1);
  });

  it('duplicate association jobs defer once and write once', async () => {
    const t = await setup();
    const companyId = t.sf.seed('company', acme);
    const contactId = t.sf.seed('contact', ada);
    t.sf.link('contact', contactId, 'company', companyId);

    await t.syncRecord('salesforce', 'contact', contactId);
    await t.syncRecord('salesforce', 'contact', contactId);
    expect(await t.associations.listPending(10)).toHaveLength(1);

    await t.syncRecord('salesforce', 'company', companyId);
    await t.syncRecord('salesforce', 'contact', contactId);
    await t.syncRecord('salesforce', 'contact', contactId);
    const hsContact = (await t.idMap.bySource('salesforce', contactId, 'contact'))!.ids.hubspot!;
    expect(await t.hs.listAssociations('contact', hsContact)).toHaveLength(1);
  });

  it('preserves labels as distinct relationships and reports unsupported ones', async () => {
    const t = await setup();
    const companyId = t.sf.seed('company', acme);
    const contactId = t.sf.seed('contact', ada);
    t.sf.link('contact', contactId, 'company', companyId, 'company', 'Billing');
    t.sf.link('contact', contactId, 'company', companyId, 'company', 'Board');

    await t.syncRecord('salesforce', 'company', companyId);
    const result = await t.syncRecord('salesforce', 'contact', contactId);
    expect(result).toMatchObject({ synced: 1, unsupported: 1 });

    const hsContact = (await t.idMap.bySource('salesforce', contactId, 'contact'))!.ids.hubspot!;
    const written = await t.hs.listAssociations('contact', hsContact);
    expect(written.map((item) => item.label)).toEqual(['Billing']);
    const unsupported = await t.associations.listPending(10, 'unsupported');
    expect(unsupported).toEqual([expect.objectContaining({ label: 'Board', lastError: 'no Board label' })]);
  });

  it('HubSpot reads every page of associations and keeps custom labels', async () => {
    const config = createDefaultConfigContext('r10-hs-paging');
    const hs = new HubSpotConnector(config);
    const calls: unknown[] = [];
    (hs as unknown as { http: unknown }).http = {
      get: async (url: string, opts: { params: { after?: string } }) => {
        calls.push(opts.params.after);
        if (!url.endsWith('/companies')) return { data: { results: [] } };
        if (!opts.params.after) {
          return {
            data: {
              results: [{ toObjectId: 1, associationTypes: [{ category: 'HUBSPOT_DEFINED', label: null }] }],
              paging: { next: { after: 'page-2' } },
            },
          };
        }
        return {
          data: {
            results: [{ toObjectId: 2, associationTypes: [{ category: 'USER_DEFINED', label: 'Billing' }] }],
          },
        };
      },
    };
    const result = await hs.listAssociations('contact', '99');
    const companies = result.filter((item) => item.toType === 'company');
    expect(companies).toEqual([
      { toType: 'company', toId: '1', kind: 'company', label: undefined },
      { toType: 'company', toId: '2', kind: 'company', label: 'Billing' },
    ]);
    expect(calls).toContain('page-2');
  });

  it('HubSpot rejects a label the portal does not define as unsupported', async () => {
    const config = createDefaultConfigContext('r10-hs-labels');
    const hs = new HubSpotConnector(config);
    const puts: unknown[] = [];
    (hs as unknown as { http: unknown }).http = {
      get: async () => ({ data: { results: [{ label: 'Billing', typeId: 7, category: 'USER_DEFINED' }] } }),
      put: async (url: string, body: unknown) => puts.push({ url, body }),
    };
    await hs.associate('contact', '1', { toType: 'company', toId: '2', kind: 'company', label: 'billing' });
    expect(puts).toEqual([
      expect.objectContaining({ body: [{ associationCategory: 'USER_DEFINED', associationTypeId: 7 }] }),
    ]);
    await expect(
      hs.associate('contact', '1', { toType: 'company', toId: '2', kind: 'company', label: 'Board' }),
    ).rejects.toBeInstanceOf(UnsupportedAssociationError);
  });

  it('migration approval states that relationships are out of scope', async () => {
    const t = await setup();
    t.sf.seed('contact', ada);
    const engine = new MigrationEngine(t.connectors, t.config, t.reconciler);
    const preview = await engine.preview({ from: 'salesforce', types: ['contact'] });
    expect(preview.approval?.relationshipScope).toBe('records-only');
  });
});

describe('R10 deletions', () => {
  async function deleted() {
    const t = await setup();
    const sfId = t.sf.seed('contact', ada);
    await t.syncRecord('salesforce', 'contact', sfId);
    const link = (await t.idMap.bySource('salesforce', sfId, 'contact'))!;
    const hsId = link.ids.hubspot!;
    const event: ChangeEvent = { system: 'hubspot', type: 'contact', sourceId: hsId, changeType: 'deleted' } as ChangeEvent;
    await t.hs.remove('contact', hsId);
    return { ...t, sfId, hsId, link, event };
  }

  it('an approved delete leaves a tombstone and a replay does not recreate the record', async () => {
    const t = await deleted();
    const store = new InMemorySyncEventStore();
    const sync = new SyncEngine(t.connectors, t.reconciler, store, {
      governance: t.governance,
      deletePolicy: 'manual-review',
    });
    const [jobId] = await sync.enqueue([t.event]);
    await sync.drain().catch(() => undefined);
    expect((await store.get(jobId!))?.status).toBe('manual_review');
    await sync.approveDelete(jobId!, 'admin-1');

    expect(await t.sf.read('contact', t.sfId)).toBeNull();
    const tombstone = await t.governance.activeTombstone(t.link.canonicalId);
    expect(tombstone).toMatchObject({ approvedBy: 'admin-1', deletedSystem: 'hubspot', targetSystem: 'salesforce' });

    // A late / replayed event for the deleted record does nothing.
    await sync.replay(jobId!);
    await sync.drain().catch(() => undefined);
    expect((await t.hs.list('contact')).records).toHaveLength(0);
    expect((await t.sf.list('contact')).records).toHaveLength(0);
  });

  it('a cascaded delete records provenance and restore lifts the tombstone once', async () => {
    const t = await setup();
    const sfId = t.sf.seed('contact', ada);
    await t.syncRecord('salesforce', 'contact', sfId);
    const link = (await t.idMap.bySource('salesforce', sfId, 'contact'))!;
    // Salesforce was deleted; HubSpot (the survivor) got the cascade.
    await t.sf.remove('contact', sfId);
    await t.reconciler.propagateDelete(
      { system: 'salesforce', type: 'contact', sourceId: sfId, changeType: 'deleted' } as ChangeEvent,
      { policy: 'manual-review', approvedBy: 'admin-1' },
    );
    expect((await t.hs.list('contact')).records).toHaveLength(0);
    expect(await t.governance.activeTombstone(link.canonicalId)).toBeDefined();

    // Restore is explicit, recorded, and happens once.
    expect(await t.reconciler.restoreDeleted(link.canonicalId, 'admin-2')).toBe(true);
    expect(await t.governance.activeTombstone(link.canonicalId)).toBeUndefined();
    expect((await t.governance.latestTombstone(link.canonicalId))?.restoredBy).toBe('admin-2');
    expect(await t.reconciler.restoreDeleted(link.canonicalId)).toBe(false);
  });

  it('a change after an approved delete is blocked, and restore lets it recreate the record', async () => {
    const t = await setup();
    const sfId = t.sf.seed('contact', ada);
    await t.syncRecord('salesforce', 'contact', sfId);
    const link = (await t.idMap.bySource('salesforce', sfId, 'contact'))!;
    const hsId = link.ids.hubspot!;
    // HubSpot deleted the record; the approved delete is propagated... but only as a
    // tombstone on the Salesforce side here (Salesforce keeps it to test resurrection).
    await t.hs.remove('contact', hsId);
    await t.governance.tombstone({
      linkId: link.canonicalId,
      type: 'contact',
      deletedSystem: 'hubspot',
      deletedSourceId: hsId,
      targetSystem: 'salesforce',
      targetId: sfId,
      policy: 'manual-review',
      approvedBy: 'admin-1',
    });

    // A later Salesforce edit must not recreate the HubSpot record.
    await t.sf.upsert({ ...(await t.sf.read('contact', sfId))!, fields: { ...ada, firstName: 'Ada B' } }, sfId);
    await t.syncRecord('salesforce', 'contact', sfId);
    expect((await t.hs.list('contact')).records).toHaveLength(0);

    // Explicit restore: the next sync recreates it and relinks.
    await t.reconciler.restoreDeleted(link.canonicalId, 'admin-2');
    await t.syncRecord('salesforce', 'contact', sfId);
    const recreated = (await t.hs.list('contact')).records;
    expect(recreated).toHaveLength(1);
    expect(recreated[0]!.fields.firstName).toBe('Ada B');
    const relinked = await t.idMap.bySource('salesforce', sfId, 'contact');
    expect(relinked?.ids.hubspot).toBe(recreated[0]!.meta.sourceId);
    expect(relinked?.ids.hubspot).not.toBe(hsId);
  });
});

describe('R10 conflicts', () => {
  it('records an inspectable conflict and lets an operator resolve it deliberately', async () => {
    const t = await setup();
    const sfId = t.sf.seed('contact', ada);
    await t.syncRecord('salesforce', 'contact', sfId);
    const hsId = (await t.idMap.bySource('salesforce', sfId, 'contact'))!.ids.hubspot!;

    // Both sides change; HubSpot's edit is newer, so last-write-wins keeps HubSpot's value.
    await t.sf.upsert({ ...(await t.sf.read('contact', sfId))!, fields: { ...ada, phone: '+1-SF' } }, sfId);
    await t.hs.upsert({ ...(await t.hs.read('contact', hsId))!, fields: { ...ada, phone: '+1-HS' } }, hsId);
    t.sf.setModifiedAt('contact', sfId, OLD);
    t.hs.setModifiedAt('contact', hsId, NEW);
    await t.reconciler.reconcile((await t.sf.read('contact', sfId))!);
    expect((await t.hs.read('contact', hsId))!.fields.phone).toBe('+1-HS');

    const [conflict] = await t.governance.listConflicts();
    expect(conflict).toMatchObject({ status: 'resolved', resolutionSource: 'automatic', type: 'contact' });
    expect(conflict!.decision?.winner).toBe('hubspot');

    // The operator decides Salesforce is right for this record.
    // Automatic resolution already copied HubSpot's value into Salesforce, so the
    // operator's choice must come from the recorded snapshot.
    expect((await t.sf.read('contact', sfId))!.fields.phone).toBe('+1-HS');
    await t.reconciler.resolveConflictManually(conflict!, 'salesforce');
    await t.governance.resolveConflict(conflict!.id, 'operator-1', 'salesforce');
    expect((await t.hs.read('contact', hsId))!.fields.phone).toBe('+1-SF');
    expect((await t.sf.read('contact', sfId))!.fields.phone).toBe('+1-SF');
    // The write we just made to Salesforce comes back as a webhook: it is an echo.
    await t.reconciler.reconcile((await t.sf.read('contact', sfId))!);
    expect((await t.hs.read('contact', hsId))!.fields.phone).toBe('+1-SF');
    expect(await t.governance.getConflict(conflict!.id)).toMatchObject({
      resolutionSource: 'manual',
      resolvedBy: 'operator-1',
      decision: expect.objectContaining({ winner: 'salesforce' }),
    });
  });
});
