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
});
