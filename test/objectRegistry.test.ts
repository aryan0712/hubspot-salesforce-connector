import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigContext } from '../src/core/configContext.js';
import { resolveCanonicalType } from '../src/engine/typeResolver.js';
import { defaultSyncConfig, type SyncConfig } from '../src/core/syncConfig.js';
import type { CRMConnector } from '../src/core/connector.js';

function fakeConnector(fields: Record<string, unknown> | null): CRMConnector {
  return {
    readNativeFields: async () => fields,
  } as unknown as CRMConnector;
}

describe('object registry: a native object shared by multiple canonical objects', () => {
  let registry: ConfigContext;
  beforeEach(() => {
    registry = new ConfigContext('registry-test');
  });

  it('returns every registration sharing a native object, not just the first', () => {
    registry.configureObjectMappings([
      { canonicalObject: 'company', label: 'Company', salesforceObject: 'Account', hubspotObject: 'companies' },
      { canonicalObject: 'person_account', label: 'Person Account', salesforceObject: 'Account', hubspotObject: 'contacts' },
    ]);
    const matches = registry.canonicalObjectsFor('salesforce', 'Account');
    expect(matches.map((m) => m.canonicalObject).sort()).toEqual(['company', 'person_account']);
    // Single-match helper stays consistent with the plural one.
    expect(registry.canonicalObjectFor('hubspot', 'companies')).toBe('company');
  });

  it('resolves the single-candidate case without any lookup', async () => {
    registry.configureObjectMappings([
      { canonicalObject: 'contact', label: 'Contact', salesforceObject: 'Contact', hubspotObject: 'contacts' },
    ]);
    const config = defaultSyncConfig('last-write-wins', 'salesforce', ['contact']);
    const type = await resolveCanonicalType('salesforce', 'Contact', 'sf-1', fakeConnector(null), config, registry);
    expect(type).toBe('contact');
  });

  it('disambiguates by evaluating each candidate\'s structured condition against the record', async () => {
    registry.configureObjectMappings([
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
    expect(await resolveCanonicalType('salesforce', 'Account', 'sf-1', personConnector, config, registry)).toBe('person_account');

    const companyConnector = fakeConnector({ IsPersonAccount: false });
    expect(await resolveCanonicalType('salesforce', 'Account', 'sf-2', companyConnector, config, registry)).toBe('company');
  });

  it('drops the event when the record matches none of the candidates\' conditions', async () => {
    registry.configureObjectMappings([
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
    expect(await resolveCanonicalType('salesforce', 'Account', 'sf-3', connector, config, registry)).toBeUndefined();
  });

  it('drops the event when no candidate has a condition to disambiguate with', async () => {
    registry.configureObjectMappings([
      { canonicalObject: 'company', label: 'Company', salesforceObject: 'Account', hubspotObject: 'companies' },
      { canonicalObject: 'person_account', label: 'Person Account', salesforceObject: 'Account', hubspotObject: 'contacts' },
    ]);
    const config = defaultSyncConfig('last-write-wins', 'salesforce', ['company', 'person_account']);
    const connector = fakeConnector({ IsPersonAccount: false });
    expect(await resolveCanonicalType('salesforce', 'Account', 'sf-4', connector, config, registry)).toBeUndefined();
  });
});
