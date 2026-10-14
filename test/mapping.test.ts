import { describe, it, expect } from 'vitest';
import { createDefaultConfigContext } from '../src/core/configContext.js';

const config = createDefaultConfigContext('mapping-test');

describe('field mapping', () => {
  it('translates a Salesforce Contact into canonical fields', () => {
    const native = {
      FirstName: 'Ada',
      LastName: 'Lovelace',
      Email: 'ada@analytical.co',
      Phone: '+1-111',
      Title: 'Mathematician',
      Account: { Name: 'Analytical Engine Co' },
    };
    const c = config.toCanonicalFields('salesforce', 'contact', native);
    expect(c).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@analytical.co',
      phone: '+1-111',
      title: 'Mathematician',
      companyName: 'Analytical Engine Co', // resolved via dotted path Account.Name
    });
  });

  it('translates canonical fields into HubSpot properties', () => {
    const native = config.fromCanonicalFields('hubspot', 'contact', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@analytical.co',
      title: 'Mathematician',
    });
    expect(native).toEqual({
      firstname: 'Ada',
      lastname: 'Lovelace',
      email: 'ada@analytical.co',
      jobtitle: 'Mathematician',
    });
  });

  it('does not write read-only or dotted-path fields back to a system', () => {
    // companyName maps to Account.Name (dotted + readOnly) in Salesforce → never written.
    const native = config.fromCanonicalFields('salesforce', 'contact', {
      firstName: 'Ada',
      companyName: 'Should Not Appear',
    });
    expect(native).toEqual({ FirstName: 'Ada' });
    expect(native).not.toHaveProperty('Account.Name');
  });

  it('normalizes company website to a bare domain for cross-system matching', () => {
    const a = config.toCanonicalFields('salesforce', 'company', { Website: 'https://www.Acme.com/path' });
    const b = config.toCanonicalFields('hubspot', 'company', { domain: 'acme.com' });
    expect(a.domain).toBe('acme.com');
    expect(a.domain).toBe(b.domain);
  });

  it('coerces missing native values to null, not undefined', () => {
    const c = config.toCanonicalFields('hubspot', 'contact', { firstname: 'Ada' });
    expect(c.lastName).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(c, 'lastName')).toBe(true);
  });

  it('nativeFields lists the projection to request from each API', () => {
    expect(config.nativeFields('hubspot', 'deal')).toContain('dealname');
    expect(config.nativeFields('salesforce', 'deal')).toContain('StageName');
  });

  it('supports literal text and picklist values as source rules without querying or writing them as native field names', () => {
    const customConfig = createDefaultConfigContext('literal-test');
    customConfig.configureFieldRules('salesforce', 'contact', [
      ...customConfig.fieldRules('salesforce', 'contact'),
      { canonical: 'leadSource', native: 'literal:Warm' },
      { canonical: 'campaignTag', native: '"2026 Website"' },
    ]);
    customConfig.configureFieldRules('hubspot', 'contact', [
      ...customConfig.fieldRules('hubspot', 'contact'),
      { canonical: 'leadSource', native: 'hs_lead_status' },
      { canonical: 'campaignTag', native: 'campaign_tag' },
    ]);

    expect(customConfig.nativeFields('salesforce', 'contact')).not.toContain('literal:Warm');
    expect(customConfig.nativeFields('salesforce', 'contact')).not.toContain('"2026 Website"');
    expect(customConfig.nativeField('salesforce', 'contact', 'leadSource')).toBeUndefined();

    const canonical = customConfig.toCanonicalFields('salesforce', 'contact', {
      FirstName: 'Ada',
      Email: 'ada@analytical.co',
    });
    expect(canonical.leadSource).toBe('Warm');
    expect(canonical.campaignTag).toBe('2026 Website');

    const hsPayload = customConfig.fromCanonicalFields('hubspot', 'contact', canonical);
    expect(hsPayload.hs_lead_status).toBe('Warm');
    expect(hsPayload.campaign_tag).toBe('2026 Website');

    const sfPayload = customConfig.fromCanonicalFields('salesforce', 'contact', canonical);
    expect(sfPayload).not.toHaveProperty('literal:Warm');
    expect(sfPayload).not.toHaveProperty('"2026 Website"');
  });

  it('translates alternate picklist values bidirectionally between Salesforce and HubSpot (e.g. Active ⇄ Contact Active)', () => {
    const customConfig = createDefaultConfigContext('picklist-value-test');
    customConfig.configureFieldRules('salesforce', 'contact', [
      ...customConfig.fieldRules('salesforce', 'contact'),
      { canonical: 'status', native: 'Status' },
    ]);
    customConfig.configureFieldRules('hubspot', 'contact', [
      ...customConfig.fieldRules('hubspot', 'contact'),
      { canonical: 'status', native: 'hs_lead_status' },
    ]);
    customConfig.configureValueMappings([
      {
        type: 'contact',
        canonicalField: 'status',
        canonicalValue: 'Active',
        salesforceValue: 'Active',
        hubspotValue: 'Contact Active',
      },
      {
        type: 'contact',
        canonicalField: 'status',
        canonicalValue: 'Deactivated',
        salesforceValue: 'Deactivated',
        hubspotValue: 'Discontinued',
      },
    ]);

    // 1. Salesforce -> Canonical -> HubSpot
    const sfRecord = { FirstName: 'Alice', Status: 'Active' };
    const canonicalFromSf = customConfig.toCanonicalFields('salesforce', 'contact', sfRecord);
    expect(canonicalFromSf.status).toBe('Active');

    const hsPayload = customConfig.fromCanonicalFields('hubspot', 'contact', canonicalFromSf);
    expect(hsPayload.hs_lead_status).toBe('Contact Active');

    // 2. HubSpot -> Canonical -> Salesforce
    const hsRecord = { firstname: 'Alice', hs_lead_status: 'Contact Active' };
    const canonicalFromHs = customConfig.toCanonicalFields('hubspot', 'contact', hsRecord);
    expect(canonicalFromHs.status).toBe('Active');

    const sfPayload = customConfig.fromCanonicalFields('salesforce', 'contact', canonicalFromHs);
    expect(sfPayload.Status).toBe('Active');

    // 3. Second alternate mapping: Deactivated ⇄ Discontinued
    const sfDeactivated = { FirstName: 'Bob', Status: 'Deactivated' };
    const canDeact = customConfig.toCanonicalFields('salesforce', 'contact', sfDeactivated);
    expect(canDeact.status).toBe('Deactivated');
    const hsDiscontinued = customConfig.fromCanonicalFields('hubspot', 'contact', canDeact);
    expect(hsDiscontinued.hs_lead_status).toBe('Discontinued');

    const hsDeactPayload = { firstname: 'Bob', hs_lead_status: 'Discontinued' };
    const canHsDeact = customConfig.toCanonicalFields('hubspot', 'contact', hsDeactPayload);
    expect(canHsDeact.status).toBe('Deactivated');
    const sfDeactPayload = customConfig.fromCanonicalFields('salesforce', 'contact', canHsDeact);
    expect(sfDeactPayload.Status).toBe('Deactivated');

    // 4. Case-insensitivity support
    const sfLower = customConfig.toCanonicalFields('salesforce', 'contact', { Status: 'active' });
    expect(sfLower.status).toBe('Active');
    const hsFromLower = customConfig.fromCanonicalFields('hubspot', 'contact', { status: 'active' });
    expect(hsFromLower.hs_lead_status).toBe('Contact Active');

    // 5. Unmapped value falls through untouched
    const sfUnknown = customConfig.toCanonicalFields('salesforce', 'contact', { Status: 'SomeOtherStatus' });
    expect(sfUnknown.status).toBe('SomeOtherStatus');
    const hsUnknown = customConfig.fromCanonicalFields('hubspot', 'contact', sfUnknown);
    expect(hsUnknown.hs_lead_status).toBe('SomeOtherStatus');

    // 6. Semicolon delimited multi-select options
    const multiSf = customConfig.toCanonicalFields('salesforce', 'contact', { Status: 'Active;Deactivated' });
    expect(multiSf.status).toBe('Active;Deactivated');
    const multiHs = customConfig.fromCanonicalFields('hubspot', 'contact', multiSf);
    expect(multiHs.hs_lead_status).toBe('Contact Active;Discontinued');
  });
});


