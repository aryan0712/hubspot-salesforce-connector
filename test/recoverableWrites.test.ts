import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultConfigContext } from '../src/core/configContext.js';
import { ReviewRequiredError } from '../src/engine/reconciler.js';
import { UncertainWriteError, type WriteIntentStore } from '../src/engine/writeIntents.js';
import { SyncEngine } from '../src/engine/syncEngine.js';
import { InMemorySyncEventStore } from '../src/engine/syncEventStore.js';
import { startIsolatedPostgres, type IsolatedPostgres } from './helpers/postgres.js';
import { buildHarness, mockCrms, NEW, OLD, type Harness, type MockCrms } from './helpers/harness.js';

/**
 * R06 acceptance: concurrent first-sync jobs produce one target and one stable link, and
 * faults before/after the CRM write and the link commit recover without duplicate creates
 * or identity reassignment. Workers use independent PostgreSQL clients and the mock CRM
 * models delayed search visibility (a new record is readable by id before search sees it).
 */
let pg: IsolatedPostgres;
beforeAll(async () => {
  pg = await startIsolatedPostgres();
}, 180_000);
afterAll(async () => {
  await pg?.stop();
}, 30_000);

async function workers(opts: { searchVisibilityMs?: number; vendorLagMs?: number } = {}): Promise<{
  crms: MockCrms;
  a: Harness;
  b: Harness;
}> {
  const tenantId = await pg.ensureTenant(`r06-${crypto.randomUUID().slice(0, 8)}`);
  const configA = createDefaultConfigContext('worker-a');
  const crms = mockCrms(configA);
  crms.hs.searchVisibilityMs = opts.vendorLagMs ?? 0;
  crms.sf.searchVisibilityMs = opts.vendorLagMs ?? 0;
  const a = await buildHarness({ config: configA, crms, postgres: { db: pg.connect(), tenantId }, searchVisibilityMs: opts.searchVisibilityMs });
  const b = await buildHarness({
    config: createDefaultConfigContext('worker-b'),
    crms,
    postgres: { db: pg.connect(), tenantId },
    searchVisibilityMs: opts.searchVisibilityMs,
  });
  return { crms, a, b };
}

const lostResponse = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
/** Waits until the (lagging) mock search index shows a record matching this email. */
async function untilSearchable(crms: MockCrms, email: string): Promise<void> {
  const query = { field: 'email', value: email, key: `email:${email}`, criteria: [{ field: 'email', value: email }] };
  for (let i = 0; i < 200; i += 1) {
    if ((await crms.hs.findByNaturalKey('contact', query)).length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('record never became searchable');
}

const unique = () => `${crypto.randomUUID().slice(0, 8)}@example.com`;

/** Fails the next CRM write of `crm` AFTER the vendor applied it (a lost response). */
function loseNextResponse(crms: MockCrms, system: 'hs' | 'sf' = 'hs'): void {
  const connector = crms[system];
  const write = connector.write.bind(connector);
  let armed = true;
  connector.write = async (...args) => {
    const result = await write(...args);
    if (armed) {
      armed = false;
      throw lostResponse();
    }
    return result;
  };
}

describe('R06 serialized linking', () => {
  it('concurrent first-sync jobs for one record create one target and one link', async () => {
    const { crms, a, b } = await workers({ vendorLagMs: 60_000 });
    const sfId = crms.sf.seed('contact', { firstName: 'Ada', email: unique() });
    const write = crms.hs.write.bind(crms.hs);
    crms.hs.write = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 50)); // widen the race window
      return write(...args);
    };
    const record = (await crms.sf.read('contact', sfId))!;
    await Promise.all([a.reconciler.reconcile(record), b.reconciler.reconcile(record)]);
    expect((await crms.hs.list('contact')).records).toHaveLength(1);
    const linkA = await a.idMap.bySource('salesforce', sfId, 'contact');
    const linkB = await b.idMap.bySource('salesforce', sfId, 'contact');
    expect(linkA?.canonicalId).toBe(linkB?.canonicalId);
    expect(linkA?.ids.hubspot).toBe((await crms.hs.list('contact')).records[0]!.meta.sourceId);
  });

  it('the two directions of one first sync serialize on the natural key', async () => {
    const { crms, a, b } = await workers();
    const email = unique();
    const sfId = crms.sf.seed('contact', { firstName: 'Ada', email });
    const hsId = crms.hs.seed('contact', { firstName: 'Ada', email });
    await Promise.all([
      a.reconciler.reconcile((await crms.sf.read('contact', sfId))!),
      b.reconciler.reconcile((await crms.hs.read('contact', hsId))!),
    ]);
    expect((await crms.hs.list('contact')).records).toHaveLength(1);
    expect((await crms.sf.list('contact')).records).toHaveLength(1);
    const link = await a.idMap.bySource('salesforce', sfId, 'contact');
    expect(link?.ids.hubspot).toBe(hsId);
    expect((await b.idMap.bySource('hubspot', hsId, 'contact'))?.canonicalId).toBe(link?.canonicalId);
  });
});

describe('R06 fault injection and recovery', () => {
  it('a CRM write followed by a failed link commit is recovered, not repeated', async () => {
    const { crms, a, b } = await workers();
    const sfId = crms.sf.seed('contact', { firstName: 'Ada', email: unique() });
    const upsert = a.idMap.upsertLink.bind(a.idMap);
    a.idMap.upsertLink = async () => {
      throw new Error('database connection lost');
    };
    await expect(a.reconciler.reconcile((await crms.sf.read('contact', sfId))!)).rejects.toThrow('database connection lost');
    a.idMap.upsertLink = upsert;
    const [intent] = await b.intents.unresolvedForSource('contact', 'salesforce', sfId);
    expect(intent).toMatchObject({ status: 'applied', operation: 'create' });

    await b.reconciler.reconcile((await crms.sf.read('contact', sfId))!);
    expect((await crms.hs.list('contact')).records).toHaveLength(1);
    expect((await b.idMap.bySource('salesforce', sfId, 'contact'))?.ids.hubspot).toBe(intent!.targetId);
    expect(await b.intents.unresolvedForSource('contact', 'salesforce', sfId)).toEqual([]);
  });

  it('a CRM write whose confirmation was never recorded is found by lookup once search catches up', async () => {
    const { crms, a, b } = await workers({ searchVisibilityMs: 60_000, vendorLagMs: 1_500 });
    const email = unique();
    const sfId = crms.sf.seed('contact', { firstName: 'Ada', email });
    const update = a.intents.update.bind(a.intents) as WriteIntentStore['update'];
    a.intents.update = async (operationId, patch) => {
      if (patch.status === 'applied') throw new Error('database write failed');
      return update(operationId, patch);
    };
    await expect(a.reconciler.reconcile((await crms.sf.read('contact', sfId))!)).rejects.toThrow('database write failed');
    const [intent] = await b.intents.unresolvedForSource('contact', 'salesforce', sfId);
    expect(intent?.status).toBe('pending');

    // Search does not show the new record yet: the worker waits instead of creating again.
    await expect(b.reconciler.reconcile((await crms.sf.read('contact', sfId))!)).rejects.toBeInstanceOf(UncertainWriteError);
    expect((await crms.hs.list('contact')).records).toHaveLength(1);

    await untilSearchable(crms, email);
    await b.reconciler.reconcile((await crms.sf.read('contact', sfId))!);
    const records = (await crms.hs.list('contact')).records;
    expect(records).toHaveLength(1);
    expect((await b.idMap.bySource('salesforce', sfId, 'contact'))?.ids.hubspot).toBe(records[0]!.meta.sourceId);
  });

  it('a lost create response is recovered without a duplicate', async () => {
    const { crms, a, b } = await workers({ searchVisibilityMs: 60_000, vendorLagMs: 1_500 });
    const email = unique();
    const sfId = crms.sf.seed('contact', { firstName: 'Ada', email });
    loseNextResponse(crms);
    await expect(a.reconciler.reconcile((await crms.sf.read('contact', sfId))!)).rejects.toBeInstanceOf(UncertainWriteError);
    expect((await a.intents.unresolvedForSource('contact', 'salesforce', sfId))[0]?.status).toBe('uncertain');
    // Until search shows the created record, a retry waits rather than creating again.
    await expect(b.reconciler.reconcile((await crms.sf.read('contact', sfId))!)).rejects.toBeInstanceOf(UncertainWriteError);
    await untilSearchable(crms, email);
    await b.reconciler.reconcile((await crms.sf.read('contact', sfId))!);
    expect((await crms.hs.list('contact')).records).toHaveLength(1);
  });

  it('a create that never happened is abandoned after the visibility window and retried once', async () => {
    const { crms, a } = await workers({ searchVisibilityMs: 50 });
    const sfId = crms.sf.seed('contact', { firstName: 'Ada', email: unique() });
    const write = crms.hs.write.bind(crms.hs);
    let fail = true;
    crms.hs.write = async (...args) => {
      if (fail) {
        fail = false;
        throw lostResponse(); // lost before the vendor applied anything
      }
      return write(...args);
    };
    await expect(a.reconciler.reconcile((await crms.sf.read('contact', sfId))!)).rejects.toBeInstanceOf(UncertainWriteError);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await a.reconciler.reconcile((await crms.sf.read('contact', sfId))!);
    expect((await crms.hs.list('contact')).records).toHaveLength(1);
  });

  it('a definite vendor rejection before the write is abandoned and retried normally', async () => {
    const { crms, a } = await workers();
    const sfId = crms.sf.seed('contact', { firstName: 'Ada', email: unique() });
    const write = crms.hs.write.bind(crms.hs);
    let fail = true;
    crms.hs.write = async (...args) => {
      if (fail) {
        fail = false;
        const { AxiosError } = await import('axios');
        const err = new AxiosError('Request failed with status code 400');
        err.response = { status: 400, statusText: 'Bad Request', headers: {}, config: {} as never, data: {} };
        throw err;
      }
      return write(...args);
    };
    await expect(a.reconciler.reconcile((await crms.sf.read('contact', sfId))!)).rejects.toThrow('400');
    expect(await a.intents.unresolvedForSource('contact', 'salesforce', sfId)).toEqual([]);
    await a.reconciler.reconcile((await crms.sf.read('contact', sfId))!);
    expect((await crms.hs.list('contact')).records).toHaveLength(1);
  });

  it('an inconclusive outcome (no natural key to look up) is held for manual review', async () => {
    const { crms, a } = await workers();
    const sfId = crms.sf.seed('contact', { firstName: 'No Email' });
    loseNextResponse(crms);
    await expect(a.reconciler.reconcile((await crms.sf.read('contact', sfId))!)).rejects.toBeInstanceOf(UncertainWriteError);
    await expect(a.reconciler.reconcile((await crms.sf.read('contact', sfId))!)).rejects.toBeInstanceOf(ReviewRequiredError);
    expect((await crms.hs.list('contact')).records).toHaveLength(1);
    const sync = new SyncEngine(a.connectors, a.reconciler, new InMemorySyncEventStore());
    await sync.enqueue([{ system: 'salesforce', type: 'contact', sourceId: sfId, changeType: 'updated', occurredAt: NEW }]);
    await sync.drain();
    expect((await sync.stats()).manualReview).toBe(1);
    expect((await crms.hs.list('contact')).records).toHaveLength(1);
  });

  it('a failed source write-back is recovered and converges', async () => {
    const { crms, a, b } = await workers();
    const email = unique();
    const sfId = crms.sf.seed('contact', { firstName: 'Ada', title: 'Engineer', email });
    await a.reconciler.reconcile((await crms.sf.read('contact', sfId))!);
    const hsId = (await a.idMap.bySource('salesforce', sfId, 'contact'))!.ids.hubspot!;
    // HubSpot changes (newer) and Salesforce changes (older): last-write-wins picks HubSpot,
    // so the merged value must be written back to Salesforce.
    const hsCurrent = (await crms.hs.read('contact', hsId))!;
    await crms.hs.upsert({ ...hsCurrent, fields: { ...hsCurrent.fields, title: 'Director' } }, hsId);
    crms.hs.setModifiedAt('contact', hsId, NEW);
    const sfCurrent = (await crms.sf.read('contact', sfId))!;
    await crms.sf.upsert({ ...sfCurrent, fields: { ...sfCurrent.fields, firstName: 'Augusta' } }, sfId);
    crms.sf.setModifiedAt('contact', sfId, OLD);
    loseNextResponse(crms, 'sf');
    await expect(a.reconciler.reconcile((await crms.sf.read('contact', sfId))!)).rejects.toBeInstanceOf(UncertainWriteError);
    await b.reconciler.reconcile((await crms.sf.read('contact', sfId))!);
    expect(crms.sf.peek('contact', sfId, 'Title')).toBe('Director');
    expect(crms.hs.peek('contact', hsId, 'jobtitle')).toBe('Director');
    expect(await b.intents.unresolvedForSource('contact', 'salesforce', sfId)).toEqual([]);
    expect((await crms.hs.list('contact')).records).toHaveLength(1);
  });

  it('a migration item interrupted after its write is not written again by a later attempt', async () => {
    const { crms, a } = await workers();
    const sfId = crms.sf.seed('contact', { firstName: 'Ada', email: unique() });
    const preview = await a.engine.preview({ from: 'salesforce', types: ['contact'] });
    const plan = preview.plans.find((item) => item.sourceId === sfId)!;
    const record = (await crms.sf.read('contact', sfId))!;
    const policy = a.reconciler.migrationPolicy(preview.approval!.conflict);
    const upsert = a.idMap.upsertLink.bind(a.idMap);
    a.idMap.upsertLink = async () => {
      throw new Error('worker crashed');
    };
    await expect(a.reconciler.apply(plan, record, policy, { operationId: 'mig:test-item' })).rejects.toThrow('worker crashed');
    a.idMap.upsertLink = upsert;
    const resumed = await a.reconciler.apply(plan, record, policy, { operationId: 'mig:test-item' });
    expect(resumed.warnings).toContain('recovered from an earlier attempt');
    expect((await crms.hs.list('contact')).records).toHaveLength(1);
    const again = await a.reconciler.apply(plan, record, policy, { operationId: 'mig:test-item' });
    expect(again.warnings).toContain('already applied by an earlier attempt');
    expect(crms.hs.writes).toHaveLength(1);
  });
});
