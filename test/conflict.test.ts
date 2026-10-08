import { describe, it, expect } from 'vitest';
import { resolve } from '../src/core/conflict.js';
import type { CanonicalRecord, SystemId } from '../src/core/types.js';

const make = (system: SystemId, modifiedAt: string, fields: Record<string, string | null>): CanonicalRecord => ({
  canonicalId: 'c1',
  type: 'contact',
  fields,
  meta: { source: system, sourceId: `${system}-1`, modifiedAt },
});

const older = make('hubspot', '2026-01-01T00:00:00Z', { firstName: 'Robert', phone: '+1-old' });
const newer = make('salesforce', '2026-06-01T00:00:00Z', { firstName: 'Bob', phone: null });

describe('conflict.resolve', () => {
  it('returns the only present record when one side is missing', () => {
    expect(resolve(older, undefined).winner).toBe(older);
    expect(resolve(undefined, newer).reason).toBe('only-b');
  });

  it('last-write-wins picks the newer modifiedAt wholesale', () => {
    const r = resolve(older, newer, { strategy: 'last-write-wins' });
    expect(r.winner).toBe(newer);
    expect(r.winner.fields.firstName).toBe('Bob');
  });

  it('source-of-truth always picks the configured system', () => {
    expect(resolve(older, newer, { strategy: 'source-of-truth', sourceOfTruth: 'hubspot' }).winner).toBe(older);
    expect(resolve(older, newer, { strategy: 'source-of-truth', sourceOfTruth: 'salesforce' }).winner).toBe(newer);
  });

  it('field-merge takes newest per field but never clobbers data with null', () => {
    const r = resolve(older, newer, { strategy: 'field-merge' });
    // firstName: newer wins → Bob. phone: newer is null, so keep older non-null value.
    expect(r.winner.fields.firstName).toBe('Bob');
    expect(r.winner.fields.phone).toBe('+1-old');
  });

  it('field ownership overrides timestamps for governed fields', () => {
    const r = resolve(older, newer, {
      strategy: 'field-merge',
      fieldOwners: { firstName: 'hubspot' },
    });
    expect(r.winner.fields.firstName).toBe('Robert');
    expect(r.winner.fields.phone).toBe('+1-old');
  });

  it('source-of-truth strategy respects field-level ownership overrides', () => {
    const sfRecord = make('salesforce', '2026-06-01T00:00:00Z', {
      firstName: 'SF Name',
      phone: '+1-sf-phone',
      email: 'sf@example.com',
    });
    const hsRecord = make('hubspot', '2026-06-01T00:00:00Z', {
      firstName: 'HS Name',
      phone: '+1-hs-phone',
      email: 'hs@example.com',
    });
    const r = resolve(sfRecord, hsRecord, {
      strategy: 'source-of-truth',
      sourceOfTruth: 'hubspot',
      fieldOwners: { phone: 'salesforce' },
    });
    expect(r.winner.fields.firstName).toBe('HS Name');
    expect(r.winner.fields.email).toBe('hs@example.com');
    expect(r.winner.fields.phone).toBe('+1-sf-phone');
  });
});
