import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalObjectFor,
  canonicalObjectsFor,
  configureObjectMappings,
  resetObjectRegistry,
} from '../src/core/objectRegistry.js';
import { resolveCanonicalType } from '../src/engine/typeResolver.js';
import { defaultSyncConfig, type SyncConfig } from '../src/core/syncConfig.js';
import type { CRMConnector } from '../src/core/connector.js';

function fakeConnector(fields: Record<string, unknown> | null): CRMConnector {
  return {
    readNativeFields: async () => fields,
  } as unknown as CRMConnector;
}

describe('object registry: a native object shared by multiple canonical objects', () => {
  afterEach(() => resetObjectRegistry());

  it('returns every registration sharing a native object, not just the first', () => {
    configureObjectMappings([
      { canonicalObject: 'company', label: 'Company', salesforceObject: 'Account', hubspotObject: 'companies' },
      { canonicalObject: 'person_account', label: 'Person Account', salesforceObject: 'Account', hubspotObject: 'contacts' },
    ]);
    const matches = canonicalObjectsFor('salesforce', 'Account');
    expect(matches.map((m) => m.canonicalObject).sort()).toEqual(['company', 'person_account']);
    // Single-match helper stays consistent with the plural one.
    expect(canonicalObjectFor('hubspot', 'companies')).toBe('company');
  });

  it('resolves the single-candidate case without any lookup', async () => {
    configureObjectMappings([
      { canonicalObject: 'contact', label: 'Contact', salesforceObject: 'Contact', hubspotObject: 'contacts' },
    ]);
    const config = defaultSyncConfig('last-write-wins', 'salesforce', ['contact']);
    const type = await resolveCanonicalType('salesforce', 'Contact', 'sf-1', fakeConnector(null), config);
    expect(type).toBe('contact');
  });

  it('disambiguates by evaluating each candidate\'s structured condition against the record', async () => {
    configureObjectMappings([
      { canonicalObject: 'company', label: 'Company', salesforceObject: 'Account', hubspotObject: 'companies' },
      { canonicalObject: 'person_account', label: 'Person Account', salesforceObject: 'Account', hubspotObject: 'contacts' },
    ]);
    const config: SyncConfig = {
      ...defaultSyncConfig('last-write-wins', 'salesforce', ['company', 'person_account']),
      objects: {
        company: {
          enabled: true,
          direction: 'bidirectional',
          enrolledForSync: true,
          conditions: { salesforce: [{ field: 'IsPersonAccount', operator: 'eq', value: false }] },
        },
        person_account: {
          enabled: true,
          direction: 'bidirectional',
          enrolledForSync: true,
          conditions: { salesforce: [{ field: 'IsPersonAccount', operator: 'eq', value: true }] },
        },
      },
    } as SyncConfig;

    const personConnector = fakeConnector({ IsPersonAccount: true });
    expect(await resolveCanonicalType('salesforce', 'Account', 'sf-1', personConnector, config)).toBe('person_account');

    const companyConnector = fakeConnector({ IsPersonAccount: false });
    expect(await resolveCanonicalType('salesforce', 'Account', 'sf-2', companyConnector, config)).toBe('company');
  });

  it('drops the event when the record matches none of the candidates\' conditions', async () => {
    configureObjectMappings([
      { canonicalObject: 'company', label: 'Company', salesforceObject: 'Account', hubspotObject: 'companies' },
      { canonicalObject: 'person_account', label: 'Person Account', salesforceObject: 'Account', hubspotObject: 'contacts' },
    ]);
    const config: SyncConfig = {
      ...defaultSyncConfig('last-write-wins', 'salesforce', []),
      objects: {
        company: {
          enabled: true,
          direction: 'bidirectional',
          enrolledForSync: true,
          conditions: { salesforce: [{ field: 'IsPersonAccount', operator: 'eq', value: false }] },
        },
        person_account: {
          enabled: true,
          direction: 'bidirectional',
          enrolledForSync: true,
          conditions: { salesforce: [{ field: 'IsPersonAccount', operator: 'eq', value: true }] },
        },
      },
    } as SyncConfig;
    // A value that satisfies neither sibling's condition (misconfiguration, or a field the
    // record genuinely doesn't have) -- must be dropped, not guessed.
    const connector = fakeConnector({ IsPersonAccount: null });
    expect(await resolveCanonicalType('salesforce', 'Account', 'sf-3', connector, config)).toBeUndefined();
  });

  it('drops the event when no candidate has a condition to disambiguate with', async () => {
    configureObjectMappings([
      { canonicalObject: 'company', label: 'Company', salesforceObject: 'Account', hubspotObject: 'companies' },
      { canonicalObject: 'person_account', label: 'Person Account', salesforceObject: 'Account', hubspotObject: 'contacts' },
    ]);
    const config = defaultSyncConfig('last-write-wins', 'salesforce', ['company', 'person_account']);
    const connector = fakeConnector({ IsPersonAccount: false });
    expect(await resolveCanonicalType('salesforce', 'Account', 'sf-4', connector, config)).toBeUndefined();
  });
});
