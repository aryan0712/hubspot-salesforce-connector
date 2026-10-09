import { describe, expect, it } from 'vitest';
import type { FieldValue, SystemId } from '../src/core/types.js';
import { AssociationEngine, InMemoryAssociationStore } from '../src/engine/associationEngine.js';
import { InMemoryGovernanceStore } from '../src/engine/governanceStore.js';
import { Reconciler } from '../src/engine/reconciler.js';
import { buildHarness, OLD } from './helpers/harness.js';

/** Full-flow acceptance checks for every supported object in both directions. */
const objects: {
  type: string;
  fields: Record<string, FieldValue>;
  changedField: string;
  firstEdit: FieldValue;
  secondEdit: FieldValue;
}[] = [
  {
    type: 'contact',
    fields: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@matrix.example', phone: '111' },
    changedField: 'phone',
    firstEdit: '222',
    secondEdit: '333',
  },
  {
    type: 'company',
    fields: { name: 'Matrix Co', domain: 'matrix.example', phone: '111' },
    changedField: 'phone',
    firstEdit: '222',
    secondEdit: '333',
  },
  {
    type: 'deal',
    fields: { name: 'Matrix Deal', closeDate: '2026-06-01', amount: 100, stage: 'open' },
    changedField: 'amount',
    firstEdit: 200,
    secondEdit: 300,
  },
];

for (const object of objects) {
  for (const from of ['salesforce', 'hubspot'] as const) {
    const to: SystemId = from === 'salesforce' ? 'hubspot' : 'salesforce';

    describe(`${object.type}: ${from} to ${to}`, () => {
      it('creates a destination from a first live event and does not duplicate it on replay', async () => {
        const h = await buildHarness({ idMapInMemory: true });
        const source = from === 'salesforce' ? h.sf : h.hs;
        const destination = to === 'salesforce' ? h.sf : h.hs;
        const sourceId = source.seed(object.type, object.fields);
        const sourceRecord = (await source.read(object.type, sourceId))!;

        await h.reconciler.reconcile(sourceRecord);
        expect((await destination.list(object.type)).records).toHaveLength(1);
        expect(destination.writes).toHaveLength(1);
        const targetId = (await h.idMap.bySource(from, sourceId, object.type))?.ids[to];
        expect(targetId).toBeTruthy();

        await h.reconciler.reconcile(sourceRecord);
        await h.reconciler.reconcile((await destination.read(object.type, targetId!))!);
        expect((await destination.list(object.type)).records).toHaveLength(1);
        expect(destination.writes).toHaveLength(1);
        expect(source.writes).toHaveLength(0);
      });

      it('previews, creates only in the destination, links, suppresses echoes, and skips a repeat', async () => {
        const h = await buildHarness({ idMapInMemory: true });
        const source = h.connectors[from];
        const destination = h.connectors[to];
        const sourceId = (from === 'salesforce' ? h.sf : h.hs).seed(object.type, object.fields);

        const preview = await h.service.preview({ from, types: [object.type] });
        expect(preview.plans).toHaveLength(1);
        expect(preview.plans[0]!.action).toBe('create');
        expect(preview.plans[0]!.writes!.map((write) => write.system)).toEqual([to]);

        const outcome = await h.service.executeDirect(preview.runId, { wait: true });
        expect(outcome.execution.status).toBe('succeeded');
        expect(outcome.counts?.succeeded).toBe(1);
        expect((from === 'salesforce' ? h.sf : h.hs).writes).toHaveLength(0);
        expect((to === 'salesforce' ? h.sf : h.hs).writes).toHaveLength(1);

        const link = await h.idMap.bySource(from, sourceId, object.type);
        const targetId = link?.ids[to];
        expect(targetId).toBeTruthy();
        expect((await destination.list(object.type)).records).toHaveLength(1);
        expect((await destination.read(object.type, targetId!))?.fields[object.changedField])
          .toBe(object.fields[object.changedField]);

        await h.reconciler.reconcile((await destination.read(object.type, targetId!))!);
        expect((from === 'salesforce' ? h.sf : h.hs).writes).toHaveLength(0);

        const repeated = await h.service.preview({ from, types: [object.type] });
        expect(repeated.plans[0]!.action).toBe('skip');
        expect(repeated.plans[0]!.writes).toEqual([]);
        expect((await source.list(object.type)).records).toHaveLength(1);
      });

      it('matches an existing destination record and updates it without creating a twin', async () => {
        const h = await buildHarness({ idMapInMemory: true });
        const source = from === 'salesforce' ? h.sf : h.hs;
        const destination = to === 'salesforce' ? h.sf : h.hs;
        const sourceId = source.seed(object.type, { ...object.fields, [object.changedField]: object.firstEdit });
        const targetId = destination.seed(object.type, object.fields);
        destination.setModifiedAt(object.type, targetId, OLD);

        const preview = await h.service.preview({ from, types: [object.type] });
        expect(preview.plans).toHaveLength(1);
        expect(preview.plans[0]!.writes!.map((write) => write.system)).toEqual([to]);
        expect(preview.plans[0]!.writes![0]!.targetId).toBe(targetId);

        const outcome = await h.service.executeDirect(preview.runId, { wait: true });
        expect(outcome.execution.status).toBe('succeeded');
        expect(source.writes).toHaveLength(0);
        expect(destination.writes).toHaveLength(1);
        expect((await destination.list(object.type)).records).toHaveLength(1);
        expect((await destination.read(object.type, targetId))?.fields[object.changedField])
          .toBe(object.firstEdit);
        expect((await h.idMap.bySource(from, sourceId, object.type))?.ids[to]).toBe(targetId);
      });

      it('propagates a later edit from each side through the shared sync core', async () => {
        const h = await buildHarness({ idMapInMemory: true });
        const source = from === 'salesforce' ? h.sf : h.hs;
        const destination = to === 'salesforce' ? h.sf : h.hs;
        const sourceId = source.seed(object.type, object.fields);
        const preview = await h.service.preview({ from, types: [object.type] });
        await h.service.executeDirect(preview.runId, { wait: true });
        const targetId = (await h.idMap.bySource(from, sourceId, object.type))!.ids[to]!;

        destination.setModifiedAt(object.type, targetId, OLD);
        await source.upsert({
          canonicalId: '', type: object.type,
          fields: { [object.changedField]: object.firstEdit },
          meta: { source: from, sourceId, modifiedAt: new Date().toISOString() },
        }, sourceId);
        await h.reconciler.reconcile((await source.read(object.type, sourceId))!);
        expect((await destination.read(object.type, targetId))?.fields[object.changedField])
          .toBe(object.firstEdit);

        source.setModifiedAt(object.type, sourceId, OLD);
        await destination.upsert({
          canonicalId: '', type: object.type,
          fields: { [object.changedField]: object.secondEdit },
          meta: { source: to, sourceId: targetId, modifiedAt: new Date().toISOString() },
        }, targetId);
        await h.reconciler.reconcile((await destination.read(object.type, targetId))!);
        expect((await source.read(object.type, sourceId))?.fields[object.changedField])
          .toBe(object.secondEdit);
        expect((await source.list(object.type)).records).toHaveLength(1);
        expect((await destination.list(object.type)).records).toHaveLength(1);
      });

      it('blocks a destination natural key collision before previewing a write', async () => {
        const h = await buildHarness({ idMapInMemory: true });
        (from === 'salesforce' ? h.sf : h.hs).seed(object.type, object.fields);
        const destination = to === 'salesforce' ? h.sf : h.hs;
        destination.seed(object.type, object.fields);
        destination.seed(object.type, object.fields);

        const { checks } = await h.service.checks(from, [object.type]);
        expect(checks[0]!.ok).toBe(false);
        expect(checks[0]!.issues).toContainEqual(expect.objectContaining({
          severity: 'error', code: 'TARGET_NATURAL_KEY_DUPLICATES', system: to,
        }));
        expect(destination.writes).toHaveLength(0);
      });

      it('propagates an approved delete and prevents a replay from recreating the record', async () => {
        const h = await buildHarness({ idMapInMemory: true });
        const source = from === 'salesforce' ? h.sf : h.hs;
        const destination = to === 'salesforce' ? h.sf : h.hs;
        const sourceId = source.seed(object.type, object.fields);
        await h.reconciler.reconcile((await source.read(object.type, sourceId))!);
        const link = (await h.idMap.bySource(from, sourceId, object.type))!;
        const targetId = link.ids[to]!;
        const staleTarget = (await destination.read(object.type, targetId))!;
        const governance = new InMemoryGovernanceStore();
        const reconciler = new Reconciler(h.connectors, h.idMap, h.config, { governance });

        await source.remove(object.type, sourceId);
        await reconciler.propagateDelete(
          { system: from, type: object.type, sourceId, changeType: 'deleted', occurredAt: new Date().toISOString() },
          { policy: 'manual-review', approvedBy: 'operator' },
        );
        expect(await destination.read(object.type, targetId)).toBeNull();
        expect(await governance.activeTombstone(link.canonicalId)).toMatchObject({
          deletedSystem: from, targetSystem: to, approvedBy: 'operator',
        });
        await reconciler.reconcile(staleTarget);
        expect((await source.list(object.type)).records).toHaveLength(0);
        expect((await destination.list(object.type)).records).toHaveLength(0);
      });
    });
  }
}

for (const from of ['salesforce', 'hubspot'] as const) {
  const to: SystemId = from === 'salesforce' ? 'hubspot' : 'salesforce';
  it(`propagates a contact-company association from ${from} to ${to} after both records link`, async () => {
    const h = await buildHarness({ idMapInMemory: true });
    const source = from === 'salesforce' ? h.sf : h.hs;
    const destination = to === 'salesforce' ? h.sf : h.hs;
    const companyId = source.seed('company', { name: 'Associated Co', domain: 'associated.example' });
    const contactId = source.seed('contact', { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@associated.example' });
    source.link('contact', contactId, 'company', companyId);

    const preview = await h.service.preview({ from, types: ['company', 'contact'] });
    const outcome = await h.service.executeDirect(preview.runId, { wait: true });
    expect(outcome.execution.status).toBe('succeeded');
    const associations = new AssociationEngine(h.connectors, h.idMap, new InMemoryAssociationStore());
    const result = await associations.syncRecord((await source.read('contact', contactId))!);
    expect(result.synced).toBe(1);

    const targetCompanyId = (await h.idMap.bySource(from, companyId, 'company'))!.ids[to]!;
    const targetContactId = (await h.idMap.bySource(from, contactId, 'contact'))!.ids[to]!;
    expect(await destination.listAssociations('contact', targetContactId)).toEqual([
      expect.objectContaining({ toType: 'company', toId: targetCompanyId }),
    ]);
  });
}
