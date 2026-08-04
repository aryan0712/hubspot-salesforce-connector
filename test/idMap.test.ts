import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  configureNaturalKeyFields,
  contentHash,
  naturalKey,
  FileIdMapStore,
  isAllowedNaturalKeyField,
  newCanonicalId,
  type Link,
} from '../src/core/idMap.js';
import type { CanonicalRecord } from '../src/core/types.js';

const rec = (over: Partial<CanonicalRecord> = {}): CanonicalRecord => ({
  canonicalId: '',
  type: 'contact',
  fields: { firstName: 'Ada', email: 'ada@analytical.co' },
  meta: { source: 'salesforce', sourceId: 'sf-1', modifiedAt: '2026-01-01T00:00:00Z' },
  ...over,
});

describe('contentHash', () => {
  it('is stable regardless of key order', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });
  it('changes when a value changes', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
  it('treats null and empty consistently', () => {
    expect(contentHash({ a: null })).toBe(contentHash({ a: null }));
  });
});

describe('naturalKey', () => {
  it('uses email for contacts (lower-cased)', () => {
    expect(naturalKey(rec({ fields: { email: 'ADA@x.co' } }))).toBe('email:ada@x.co');
  });
  it('uses domain for companies', () => {
    expect(naturalKey(rec({ type: 'company', fields: { domain: 'acme.com' } }))).toBe('domain:acme.com');
  });
  it('returns undefined when the key field is missing', () => {
    expect(naturalKey(rec({ fields: { firstName: 'Ada' } }))).toBeUndefined();
  });
  it('uses a compound key for deals to avoid name-only false matches', () => {
    expect(
      naturalKey(
        rec({
          type: 'deal',
          fields: { name: 'Renewal', closeDate: '2026-12-31' },
        }),
      ),
    ).toBe('name:renewal|closeDate:2026-12-31');
    expect(naturalKey(rec({ type: 'deal', fields: { name: 'Renewal' } }))).toBeUndefined();
  });
});

describe('FileIdMapStore', () => {
  const tmp = () => path.join(os.tmpdir(), `idmap-test-${crypto.randomUUID()}.json`);

  it('round-trips a link by source id across systems', async () => {
    const store = new FileIdMapStore(tmp());
    await store.init();
    const link: Link = {
      canonicalId: newCanonicalId(),
      type: 'contact',
      ids: { salesforce: 'sf-1', hubspot: 'hs-9' },
      hashes: {},
      modifiedAt: {},
      updatedAt: new Date().toISOString(),
    };
    await store.upsertLink(link);
    expect((await store.bySource('salesforce', 'sf-1'))?.canonicalId).toBe(link.canonicalId);
    expect((await store.bySource('hubspot', 'hs-9'))?.canonicalId).toBe(link.canonicalId);
    expect(await store.bySource('hubspot', 'nope')).toBeUndefined();
  });

  it('resolves a link by natural key once indexed', async () => {
    const store = new FileIdMapStore(tmp());
    await store.init();
    const cid = newCanonicalId();
    store.indexNaturalKey('contact', 'email:ada@x.co', cid);
    await store.upsertLink({
      canonicalId: cid, type: 'contact', ids: { salesforce: 'sf-1' }, hashes: {}, modifiedAt: {}, updatedAt: '',
    });
    expect((await store.byNaturalKey('contact', 'email:ada@x.co'))?.canonicalId).toBe(cid);
  });

  it('rebuilds the natural-key index after a restart', async () => {
    const file = tmp();
    const first = new FileIdMapStore(file);
    await first.init();
    const cid = newCanonicalId();
    await first.upsertLink({
      canonicalId: cid,
      type: 'contact',
      ids: { salesforce: 'sf-1' },
      hashes: {},
      modifiedAt: {},
      naturalKeys: ['email:ada@x.co'],
      updatedAt: '',
    });
    const restarted = new FileIdMapStore(file);
    await restarted.init();
    expect((await restarted.byNaturalKey('contact', 'email:ada@x.co'))?.canonicalId).toBe(cid);
  });
});

describe('natural-key safety', () => {
  it('allows stable identities and rejects mutable system metadata', () => {
    expect(isAllowedNaturalKeyField('contact', 'email')).toBe(true);
    expect(isAllowedNaturalKeyField('company', 'domain')).toBe(true);
    expect(isAllowedNaturalKeyField('company', 'customerExternalId')).toBe(true);
    expect(isAllowedNaturalKeyField('company', 'LastModifiedDate')).toBe(false);
    expect(isAllowedNaturalKeyField('company', 'LastActivityDate')).toBe(false);
    expect(isAllowedNaturalKeyField('company', 'Description')).toBe(false);
    expect(isAllowedNaturalKeyField('company', 'Type')).toBe(false);
    expect(isAllowedNaturalKeyField('company', 'AnnualRevenue')).toBe(false);
    expect(() => configureNaturalKeyFields('company', ['LastModifiedDate'])).toThrow(
      'unsafe natural-key field',
    );
    configureNaturalKeyFields('company', ['domain']);
  });
});
