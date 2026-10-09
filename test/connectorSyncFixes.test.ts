import { describe, expect, it } from 'vitest';
import { createDefaultConfigContext } from '../src/core/configContext.js';
import { HubSpotConnector } from '../src/connectors/hubspot/hubspotConnector.js';
import { SalesforceConnector } from '../src/connectors/salesforce/salesforceConnector.js';
import type { NativeWebhookEvent } from '../src/core/connector.js';

describe('HubSpotConnector contact polling and webhook fixes', () => {
  it('polls contacts using lastmodifieddate instead of hs_lastmodifieddate', async () => {
    const config = createDefaultConfigContext('hs-polling-test');
    const hs = new HubSpotConnector(config);
    let capturedBody: Record<string, unknown> | undefined;

    (hs as unknown as { http: unknown }).http = {
      post: async (_url: string, body: Record<string, unknown>) => {
        capturedBody = body;
        return {
          data: {
            total: 1,
            results: [
              {
                id: 'hs-contact-1',
                properties: {
                  firstname: 'Alice',
                  email: 'alice@example.com',
                  lastmodifieddate: '2026-10-09T10:00:00.000Z',
                },
              },
            ],
          },
        };
      },
    };

    // list signature: (type, cursor, modifiedSince, condition)
    const res = await hs.list('contact', undefined, '2026-10-09T00:00:00.000Z');
    expect(res.records).toHaveLength(1);
    expect(res.records[0]!.fields.firstName).toBe('Alice');

    // Verify search payload used lastmodifieddate
    const filters = (capturedBody?.filterGroups as Array<{ filters: Array<{ propertyName: string }> }>)?.[0]?.filters;
    expect(filters?.[0]?.propertyName).toBe('lastmodifieddate');
    const sorts = (capturedBody?.sorts as Array<{ propertyName: string }>);
    expect(sorts?.[0]?.propertyName).toBe('lastmodifieddate');
  });

  it('polls companies using hs_lastmodifieddate', async () => {
    const config = createDefaultConfigContext('hs-polling-test');
    const hs = new HubSpotConnector(config);
    let capturedBody: Record<string, unknown> | undefined;

    (hs as unknown as { http: unknown }).http = {
      post: async (_url: string, body: Record<string, unknown>) => {
        capturedBody = body;
        return {
          data: {
            total: 1,
            results: [
              {
                id: 'hs-company-1',
                properties: {
                  name: 'Acme Corp',
                  domain: 'acme.com',
                  hs_lastmodifieddate: '2026-10-09T10:00:00.000Z',
                },
              },
            ],
          },
        };
      },
    };

    const res = await hs.list('company', undefined, '2026-10-09T00:00:00.000Z');
    expect(res.records).toHaveLength(1);
    expect(res.records[0]!.fields.name).toBe('Acme Corp');

    // Verify search payload used hs_lastmodifieddate
    const filters = (capturedBody?.filterGroups as Array<{ filters: Array<{ propertyName: string }> }>)?.[0]?.filters;
    expect(filters?.[0]?.propertyName).toBe('hs_lastmodifieddate');
    const sorts = (capturedBody?.sorts as Array<{ propertyName: string }>);
    expect(sorts?.[0]?.propertyName).toBe('hs_lastmodifieddate');
  });

  it('resolves webhook events for ticket object type IDs and names', async () => {
    const config = createDefaultConfigContext('hs-webhook-test');
    config.publish((draft) => {
      draft.objects.set('ticket', {
        canonicalObject: 'ticket',
        label: 'Ticket',
        salesforceObject: 'Case',
        hubspotObject: 'tickets',
      });
    });

    const hs = new HubSpotConnector(config);

    const numericEvent: NativeWebhookEvent = {
      system: 'hubspot',
      deliveryId: 'evt-1',
      nativeObject: '0-5',
      sourceId: 'ticket-123',
      occurredAt: '2026-10-09T10:00:00.000Z',
      changeType: 'created',
    };

    const directEvent: NativeWebhookEvent = {
      system: 'hubspot',
      deliveryId: 'evt-2',
      nativeObject: 'tickets',
      sourceId: 'ticket-456',
      occurredAt: '2026-10-09T10:00:00.000Z',
      changeType: 'created',
    };

    const resolvedNumeric = await hs.resolveWebhookEvent(numericEvent);
    expect(resolvedNumeric).not.toBeNull();
    expect(resolvedNumeric?.type).toBe('ticket');

    const resolvedDirect = await hs.resolveWebhookEvent(directEvent);
    expect(resolvedDirect).not.toBeNull();
    expect(resolvedDirect?.type).toBe('ticket');
  });
});

describe('SalesforceConnector payload sanitization and read fixes', () => {
  it('omits invalid or null OwnerId on create, and omits null fields on create', async () => {
    const config = createDefaultConfigContext('sf-write-test');
    const sf = new SalesforceConnector(config);
    let capturedBody: Record<string, unknown> | undefined;

    (sf as unknown as { http: unknown }).http = {
      post: async (_url: string, body: Record<string, unknown>) => {
        capturedBody = body;
        return { data: { id: '003CreatedId' } };
      },
    };

    const canonicalRecord = {
      canonicalId: 'can-1',
      type: 'contact' as const,
      fields: {
        firstName: 'Alice',
        lastName: 'Smith',
        email: 'alice@example.com',
        phone: null,
      },
      meta: { source: 'hubspot' as const, sourceId: 'hs-1', modifiedAt: '2026-10-09T10:00:00.000Z' },
    };

    const result = await sf.upsert(canonicalRecord);
    expect(result.operation).toBe('created');
    expect(result.targetId).toBe('003CreatedId');
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.FirstName).toBe('Alice');
    expect(capturedBody!.LastName).toBe('Smith');
    expect('Phone' in capturedBody!).toBe(false);
    expect('OwnerId' in capturedBody!).toBe(false);
  });

  it('preserves valid 15- or 18-character Salesforce OwnerId on create', async () => {
    const config = createDefaultConfigContext('sf-write-test');
    const sf = new SalesforceConnector(config);
    let capturedBody: Record<string, unknown> | undefined;

    (sf as unknown as { http: unknown }).http = {
      post: async (_url: string, body: Record<string, unknown>) => {
        capturedBody = body;
        return { data: { id: '003CreatedId' } };
      },
    };

    const canonicalRecord = {
      canonicalId: 'can-1',
      type: 'contact' as const,
      fields: {
        firstName: 'Alice',
        lastName: 'Smith',
        email: 'alice@example.com',
        ownerId: '005Dn0000021abcXYZ',
      },
      meta: { source: 'hubspot' as const, sourceId: 'hs-1', modifiedAt: '2026-10-09T10:00:00.000Z' },
    };

    await sf.upsert(canonicalRecord);
    expect(capturedBody!.OwnerId).toBe('005Dn0000021abcXYZ');
  });

  it('preserves null fields on update to clear values, but omits invalid OwnerId', async () => {
    const config = createDefaultConfigContext('sf-write-test');
    const sf = new SalesforceConnector(config);
    let capturedBody: Record<string, unknown> | undefined;

    (sf as unknown as { http: unknown }).http = {
      patch: async (_url: string, body: Record<string, unknown>) => {
        capturedBody = body;
        return { data: {} };
      },
    };

    const canonicalRecord = {
      canonicalId: 'can-1',
      type: 'contact' as const,
      fields: {
        firstName: 'Alice',
        lastName: 'Smith',
        phone: null,
        ownerId: null,
      },
      meta: { source: 'hubspot' as const, sourceId: 'hs-1', modifiedAt: '2026-10-09T10:00:00.000Z' },
    };

    const result = await sf.upsert(canonicalRecord, '003ExistingId');
    expect(result.operation).toBe('updated');
    // On update, Phone: null should be kept to clear the field
    expect(capturedBody!.Phone).toBeNull();
    // But OwnerId: null should still be omitted to prevent MALFORMED_ID
    expect('OwnerId' in capturedBody!).toBe(false);
  });

  it('queries via SOQL when dotted relationship fields exist in config', async () => {
    const config = createDefaultConfigContext('sf-read-test');
    // contact already has Account.Name in default mapping
    const sf = new SalesforceConnector(config);
    let queriedUrl = '';

    (sf as unknown as { http: unknown }).http = {
      get: async (url: string) => {
        queriedUrl = url;
        return {
          data: {
            done: true,
            records: [
              {
                Id: '003TestContact',
                LastModifiedDate: '2026-10-09T10:00:00.000Z',
                FirstName: 'Alice',
                LastName: 'Smith',
                Email: 'alice@example.com',
                Account: { Name: 'Acme Inc' },
              },
            ],
          },
        };
      },
    };

    const record = await sf.read('contact', '003TestContact');
    expect(record).not.toBeNull();
    expect(record?.fields.companyName).toBe('Acme Inc');
    expect(queriedUrl).toContain('/query?q=');
    expect(queriedUrl).toContain('Account.Name');
  });
});
