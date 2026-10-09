import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  contentHash,
  FileIdMapStore,
  hashMatches,
  legacyContentHash,
  NativeIdCollisionError,
  NaturalKeyCollisionError,
  newCanonicalId,
  type IdMapStore,
  type Link,
} from '../src/core/idMap.js';
import { IncompleteCandidateSetError } from '../src/core/connector.js';
import { createDefaultConfigContext } from '../src/core/configContext.js';
import { SalesforceConnector } from '../src/connectors/salesforce/salesforceConnector.js';
import { HubSpotConnector } from '../src/connectors/hubspot/hubspotConnector.js';
import { ReviewRequiredError, untrustedTimestamp } from '../src/engine/reconciler.js';
import { SyncEngine } from '../src/engine/syncEngine.js';
import { InMemorySyncEventStore } from '../src/engine/syncEventStore.js';
import { PostgresIdMapStore } from '../src/db/postgresIdMapStore.js';
import { startIsolatedPostgres, type IsolatedPostgres } from './helpers/postgres.js';
import { buildHarness, NEW, OLD, type Harness } from './helpers/harness.js';

/** R05 regressions: typed content hashes, exact identity matching and preserved ownership. */

describe('R05 content hashes', () => {
  it('uses typed serialization that cannot collide by concatenation', () => {
    expect(contentHash({ a: 'x|b=y' })).not.toBe(contentHash({ a: 'x', b: 'y' }));
    expect(contentHash({ a: null })).not.toBe(contentHash({ a: '' }));
    expect(contentHash({ a: null })).not.toBe(contentHash({}));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: '1' }));
    expect(contentHash({ a: false })).not.toBe(contentHash({ a: 'false' }));
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 'x' })).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  it('recognises legacy hashes only in their own format', () => {
    const fields = { email: 'ada@example.com', phone: null };
    expect(hashMatches(legacyContentHash(fields), fields)).toBe(true);
    expect(hashMatches(legacyContentHash(fields), { ...fields, phone: '+1' })).toBe(false);
    expect(hashMatches(contentHash(fields), fields)).toBe(true);
    expect(hashMatches(undefined, fields)).toBe(false);
  });
});

describe('R05 legacy hash upgrade never triggers writes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('suppresses an echo stored under a legacy hash and rebaselines it without writing', async () => {
    const sfId = h.sf.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });
    const hsId = h.hs.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });
    const sfRecord = (await h.sf.read('contact', sfId))!;
    const hsRecord = (await h.hs.read('contact', hsId))!;
    await h.idMap.upsertLink({
      canonicalId: newCanonicalId(),
      type: 'contact',
      ids: { salesforce: sfId, hubspot: hsId },
      hashes: { salesforce: legacyContentHash(sfRecord.fields), hubspot: legacyContentHash(hsRecord.fields) },
      modifiedAt: {},
      naturalKeys: ['email:ada@example.com'],
      updatedAt: '',
    });
    await h.reconciler.reconcile(hsRecord);
    await h.reconciler.reconcile(sfRecord);
    expect(h.sf.writes).toHaveLength(0);
    expect(h.hs.writes).toHaveLength(0);
    const link = await h.idMap.bySource('salesforce', sfId, 'contact');
    expect(link?.hashes.salesforce).toBe(contentHash(sfRecord.fields));
    expect(link?.hashes.hubspot).toBe(contentHash(hsRecord.fields));
  });

  it('does not treat an unchanged counterpart with a legacy hash as a conflict', async () => {
    const sfId = h.sf.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });
    const hsId = h.hs.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });
    const hsRecord = (await h.hs.read('contact', hsId))!;
    await h.idMap.upsertLink({
      canonicalId: newCanonicalId(),
      type: 'contact',
      ids: { salesforce: sfId, hubspot: hsId },
      hashes: { hubspot: legacyContentHash(hsRecord.fields) },
      modifiedAt: {},
      naturalKeys: ['email:ada@example.com'],
      updatedAt: '',
    });
    const edited = (await h.sf.read('contact', sfId))!;
    await h.sf.upsert({ ...edited, fields: { ...edited.fields, title: 'Mathematician' } }, sfId);
    await h.reconciler.reconcile((await h.sf.read('contact', sfId))!);
    // Only the real change is written; no conflict is recorded for the untouched side.
    expect(h.hs.writes.map((write) => write.payload)).toEqual([{ jobtitle: 'Mathematician' }]);
    expect(h.sf.writes).toHaveLength(0);
  });
});

describe('R05 exact company-domain matching', () => {
  it('normalizes HubSpot epoch deal dates and sends an unquoted Salesforce Date predicate', async () => {
    const config = createDefaultConfigContext('sf-deal-date');
    const sf = new SalesforceConnector(config);
    let soql = '';
    (sf as unknown as { http: unknown }).http = {
      get: async (url: string) => {
        soql = decodeURIComponent(url.slice(url.indexOf('q=') + 2));
        return {
          data: {
            done: true,
            records: [{ Id: '006A', LastModifiedDate: NEW, Name: 'Launch', CloseDate: '2026-06-01' }],
          },
        };
      },
    };
    const queryFor = (closeDate: string) => config.naturalKeyQuery({
      canonicalId: '', type: 'deal', fields: { name: 'Launch', closeDate },
      meta: { source: 'hubspot', sourceId: 'x', modifiedAt: NEW },
    })!;
    const dateQuery = queryFor('2026-06-01');
    const epochQuery = queryFor(String(Date.parse('2026-06-01T00:00:00.000Z')));
    expect(epochQuery.key).toBe(dateQuery.key);

    const matches = await sf.findByNaturalKey('deal', epochQuery);
    expect(soql).toContain('CloseDate = 2026-06-01');
    expect(soql).not.toContain("CloseDate = '2026-06-01'");
    expect(matches.map((record) => record.meta.sourceId)).toEqual(['006A']);
  });

  it('Salesforce verifies broad LIKE candidates against the exact domain', async () => {
    const config = createDefaultConfigContext('sf-domain');
    const sf = new SalesforceConnector(config);
    (sf as unknown as { http: unknown }).http = {
      get: async () => ({
        data: {
          done: true,
          records: [
            { Id: '001A', LastModifiedDate: NEW, Name: 'Not Example', Website: 'https://notexample.com' },
            { Id: '001B', LastModifiedDate: NEW, Name: 'Example', Website: 'www.example.com/about' },
            { Id: '001C', LastModifiedDate: NEW, Name: 'Sub', Website: 'shop.example.com' },
          ],
        },
      }),
    };
    const query = config.naturalKeyQuery({
      canonicalId: '', type: 'company', fields: { domain: 'example.com' },
      meta: { source: 'hubspot', sourceId: 'x', modifiedAt: NEW },
    })!;
    const matches = await sf.findByNaturalKey('company', query);
    expect(matches.map((record) => record.meta.sourceId)).toEqual(['001B']);
  });

  it('Salesforce treats a candidate list at the limit as incomplete', async () => {
    const config = createDefaultConfigContext('sf-limit');
    const sf = new SalesforceConnector(config);
    (sf as unknown as { http: unknown }).http = {
      get: async () => ({
        data: {
          done: true,
          records: Array.from({ length: 51 }, (_, i) => ({ Id: `003${i}`, LastModifiedDate: NEW, Email: 'dup@example.com' })),
        },
      }),
    };
    const query = config.naturalKeyQuery({
      canonicalId: '', type: 'contact', fields: { email: 'dup@example.com' },
      meta: { source: 'hubspot', sourceId: 'x', modifiedAt: NEW },
    })!;
    await expect(sf.findByNaturalKey('contact', query)).rejects.toBeInstanceOf(IncompleteCandidateSetError);
  });

  it('HubSpot treats a search whose total exceeds the page as incomplete', async () => {
    const config = createDefaultConfigContext('hs-limit');
    const hs = new HubSpotConnector(config);
    (hs as unknown as { http: unknown }).http = {
      post: async () => ({
        data: { total: 150, results: [{ id: '1', properties: { email: 'dup@example.com' } }] },
      }),
    };
    const query = config.naturalKeyQuery({
      canonicalId: '', type: 'contact', fields: { email: 'dup@example.com' },
      meta: { source: 'salesforce', sourceId: 'x', modifiedAt: NEW },
    })!;
    await expect(hs.findByNaturalKey('contact', query)).rejects.toBeInstanceOf(IncompleteCandidateSetError);
  });

  it('the reconciler never links example.com to notexample.com', async () => {
    const h = await buildHarness();
    h.sf.seed('company', { name: 'Example', domain: 'example.com' });
    h.hs.seed('company', { name: 'Not Example', domain: 'notexample.com' });
    // Even a connector with a sloppy search cannot make the reconciler accept it.
    const find = h.hs.findByNaturalKey.bind(h.hs);
    h.hs.findByNaturalKey = async (type) => (await h.hs.list(type)).records.concat(await find(type, {
      field: 'domain', value: 'x', key: 'domain:x', criteria: [],
    }));
    const preview = await h.engine.preview({ from: 'salesforce', types: ['company'] });
    expect(preview.plans[0]).toMatchObject({ action: 'create' });
  });

  it('an incomplete destination search sends the record to review instead of creating', async () => {
    const h = await buildHarness();
    h.sf.seed('contact', { email: 'dup@example.com' });
    h.hs.findByNaturalKey = async () => {
      throw new IncompleteCandidateSetError();
    };
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    expect(preview.plans[0]).toMatchObject({ action: 'review', writes: [] });
    await expect(h.engine.executePreview(preview.runId)).rejects.toThrow(/operator review/);
    expect(h.hs.writes).toHaveLength(0);
  });
});

describe('R05 natural-key ownership', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('a second source record with the same key goes to review instead of taking over the identity', async () => {
    const first = h.sf.seed('contact', { firstName: 'Ada', email: 'shared@example.com' });
    await h.reconciler.reconcile((await h.sf.read('contact', first))!);
    const second = h.sf.seed('contact', { firstName: 'Grace', email: 'shared@example.com' });
    await expect(h.reconciler.reconcile((await h.sf.read('contact', second))!)).rejects.toBeInstanceOf(
      ReviewRequiredError,
    );
    const link = await h.idMap.byNaturalKey('contact', 'email:shared@example.com');
    expect(link?.ids.salesforce).toBe(first);
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    expect(preview.plans.find((plan) => plan.sourceId === second)).toMatchObject({ action: 'review' });
  });

  it('a changed email is retired so a record reusing it later is not linked to the old identity', async () => {
    const ada = h.sf.seed('contact', { firstName: 'Ada', email: 'old@example.com' });
    await h.reconciler.reconcile((await h.sf.read('contact', ada))!);
    const adaLink = (await h.idMap.bySource('salesforce', ada, 'contact'))!;
    const current = (await h.sf.read('contact', ada))!;
    await h.sf.upsert({ ...current, fields: { ...current.fields, email: 'new@example.com' } }, ada);
    await h.reconciler.reconcile((await h.sf.read('contact', ada))!);
    expect((await h.idMap.byNaturalKey('contact', 'email:new@example.com'))?.canonicalId).toBe(adaLink.canonicalId);
    expect(await h.idMap.byNaturalKey('contact', 'email:old@example.com')).toBeUndefined();
    expect((h.idMap as FileIdMapStore).retiredKeys(adaLink.canonicalId)).toContain('email:old@example.com');

    const grace = h.sf.seed('contact', { firstName: 'Grace', email: 'old@example.com' });
    await h.reconciler.reconcile((await h.sf.read('contact', grace))!);
    const graceLink = await h.idMap.bySource('salesforce', grace, 'contact');
    expect(graceLink?.canonicalId).not.toBe(adaLink.canonicalId);
    expect((await h.idMap.bySource('salesforce', ada, 'contact'))?.ids.hubspot).toBe(adaLink.ids.hubspot);
  });

  it('does not relink on a duplicate of one component of a composite key', async () => {
    const deal = { name: 'Renewal', closeDate: '2026-12-31', amount: 100 };
    const sfId = h.sf.seed('deal', { ...deal, amount: 200 });
    h.sf.setModifiedAt('deal', sfId, NEW);
    const hsId = h.hs.seed('deal', deal);
    h.hs.setModifiedAt('deal', hsId, OLD);
    await h.idMap.upsertLink({
      canonicalId: newCanonicalId(), type: 'deal', ids: { salesforce: sfId, hubspot: hsId },
      hashes: {}, modifiedAt: {}, naturalKeys: [], updatedAt: '',
    });
    const { AxiosError } = await import('axios');
    h.hs.write = async () => {
      const err = new AxiosError('Request failed with status code 400');
      err.response = {
        status: 400, statusText: 'Bad Request', headers: {}, config: {} as never,
        data: { message: `Cannot set PropertyValueCoordinates{portalId=1, objectTypeId=ObjectTypeId{legacyObjectType=DEAL}, propertyName=dealname, value=Renewal} on ${hsId}. other-deal already has that value.` },
      };
      throw err;
    };
    await expect(h.reconciler.reconcile((await h.sf.read('deal', sfId))!)).rejects.toThrow();
    expect((await h.idMap.bySource('salesforce', sfId, 'deal'))?.ids.hubspot).toBe(hsId);
  });

  it('routes review-required sync jobs to manual review, not retries', async () => {
    const first = h.sf.seed('contact', { email: 'shared@example.com' });
    await h.reconciler.reconcile((await h.sf.read('contact', first))!);
    const second = h.sf.seed('contact', { email: 'shared@example.com' });
    const store = new InMemorySyncEventStore();
    const sync = new SyncEngine(h.connectors, h.reconciler, store);
    await sync.enqueue([{ system: 'salesforce', type: 'contact', sourceId: second, changeType: 'created', occurredAt: NEW }]);
    await sync.drain();
    expect((await sync.stats()).manualReview).toBe(1);
  });
});

describe('R05 vendor timestamps', () => {
  it('distrusts missing or future timestamps for timestamp-based strategies only', () => {
    const record = (modifiedAt: string) => ({
      canonicalId: '', type: 'contact', fields: {}, meta: { source: 'salesforce' as const, sourceId: '1', modifiedAt },
    });
    expect(untrustedTimestamp(record('not-a-date'), record(NEW), 'last-write-wins')).toMatch(/no valid/);
    expect(untrustedTimestamp(record('2999-01-01T00:00:00Z'), record(NEW), 'field-merge')).toMatch(/future/);
    expect(untrustedTimestamp(record('not-a-date'), record(NEW), 'source-of-truth')).toBeUndefined();
    expect(untrustedTimestamp(record(OLD), record(NEW), 'last-write-wins')).toBeUndefined();
  });

  it('a migration difference with an untrustworthy timestamp is sent to review', async () => {
    const h = await buildHarness();
    const sfId = h.sf.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });
    h.sf.setModifiedAt('contact', sfId, '2999-01-01T00:00:00.000Z');
    h.hs.seed('contact', { firstName: 'Augusta', email: 'ada@example.com' });
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    expect(preview.plans[0]).toMatchObject({ action: 'review', writes: [] });
  });
});

function linkOf(type: string, ids: Link['ids'], keys: string[] = []): Link {
  return { canonicalId: newCanonicalId(), type, ids, hashes: {}, modifiedAt: {}, naturalKeys: keys, updatedAt: '' };
}

async function storeContract(name: string, makeStore: () => Promise<IdMapStore>) {
  describe(`R05 id map identity rules (${name})`, () => {
    it('keeps overlapping native ids of different object types apart', async () => {
      const store = await makeStore();
      const contact = linkOf('contact', { hubspot: '123' });
      const company = linkOf('company', { hubspot: '123' });
      await store.upsertLink(contact);
      await store.upsertLink(company);
      expect((await store.bySource('hubspot', '123', 'contact'))?.canonicalId).toBe(contact.canonicalId);
      expect((await store.bySource('hubspot', '123', 'company'))?.canonicalId).toBe(company.canonicalId);
      await expect(store.upsertLink(linkOf('contact', { hubspot: '123' }))).rejects.toBeInstanceOf(NativeIdCollisionError);
    });

    it('refuses to reassign a natural key that another link owns', async () => {
      const store = await makeStore();
      const key = `email:${crypto.randomUUID()}@example.com`;
      const owner = linkOf('contact', { salesforce: crypto.randomUUID() }, [key]);
      await store.upsertLink(owner);
      await expect(store.upsertLink(linkOf('contact', { salesforce: crypto.randomUUID() }, [key]))).rejects.toBeInstanceOf(
        NaturalKeyCollisionError,
      );
      expect((await store.byNaturalKey('contact', key))?.canonicalId).toBe(owner.canonicalId);
    });

    it('retires a dropped key so it can later identify another record', async () => {
      const store = await makeStore();
      const oldKey = `email:${crypto.randomUUID()}@example.com`;
      const newKey = `email:${crypto.randomUUID()}@example.com`;
      const link = linkOf('contact', { salesforce: crypto.randomUUID() }, [oldKey]);
      await store.upsertLink(link);
      await store.upsertLink({ ...link, naturalKeys: [newKey] });
      expect(await store.byNaturalKey('contact', oldKey)).toBeUndefined();
      expect((await store.byNaturalKey('contact', newKey))?.canonicalId).toBe(link.canonicalId);
      const reuse = linkOf('contact', { salesforce: crypto.randomUUID() }, [oldKey]);
      await store.upsertLink(reuse);
      expect((await store.byNaturalKey('contact', oldKey))?.canonicalId).toBe(reuse.canonicalId);
    });
  });
}

void storeContract('file', async () => {
  const store = new FileIdMapStore(path.join(os.tmpdir(), `idmap-r05-${crypto.randomUUID()}.json`));
  await store.init();
  return store;
});

let pg: IsolatedPostgres | undefined;
let tenantId = '';
beforeAll(async () => {
  pg = await startIsolatedPostgres();
  tenantId = await pg.ensureTenant('r05');
}, 180_000);
afterAll(async () => {
  await pg?.stop();
}, 30_000);

void storeContract('postgres', async () => new PostgresIdMapStore(pg!.database, tenantId));
