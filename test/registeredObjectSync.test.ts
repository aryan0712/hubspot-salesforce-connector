import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/app.js';
import { buildHttpApp } from '../src/httpApp.js';
import type { MockConnector } from '../src/connectors/mock/mockConnector.js';
import { HubSpotConnector } from '../src/connectors/hubspot/hubspotConnector.js';
import type { ChangeEvent, SystemId } from '../src/core/types.js';

const active: App[] = [];
const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(active.splice(0).map(async (app) => {
    app.poller.stop();
    await app.inboxProcessor.stop();
    await app.sync.stop();
  }));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function appWithPairs() {
  const app = await createApp({ mock: true });
  active.push(app);
  await app.sync.stop();
  const sf = app.connectors.salesforce as MockConnector;
  const hs = app.connectors.hubspot as MockConnector;
  for (const pair of [
    { type: 'project', label: 'Project', sf: 'Project__c', hs: '2-12345', sfKey: 'External_Id__c', hsKey: 'external_id' },
    { type: 'ticket', label: 'Ticket', sf: 'Case', hs: 'tickets', sfKey: 'SuppliedEmail', hsKey: 'external_email' },
  ]) {
    await app.objectMappings!.create({ canonicalObject: pair.type, label: pair.label,
      salesforceObject: pair.sf, hubspotObject: pair.hs });
    await app.mappingStore.set('salesforce', pair.type, [
      { canonical: 'externalId', native: pair.sfKey }, { canonical: 'name', native: 'Subject' },
    ]);
    await app.mappingStore.set('hubspot', pair.type, [
      { canonical: 'externalId', native: pair.hsKey }, { canonical: 'name', native: 'subject' },
    ]);
    await app.objectMappings!.setNaturalKeyFields(pair.type, ['externalId']);
  }
  return { app, sf, hs };
}

async function enable(app: App, type: string, direction = 'bidirectional') {
  const config = app.syncConfig.get();
  config.objects[type] = { enabled: true, enrolledForSync: true,
    direction: direction as 'bidirectional' | 'salesforce_to_hubspot' | 'hubspot_to_salesforce' };
  config.polling[type] = { enabled: true, intervalMinutes: 30 };
  await app.syncConfig.update(config);
  app.sync.start();
}

function event(type: string, system: SystemId, sourceId: string, changeType: ChangeEvent['changeType'] = 'updated'): ChangeEvent {
  return { eventId: `${type}:${system}:${sourceId}:${Date.now()}:${Math.random()}`,
    type, system, sourceId, changeType, occurredAt: new Date().toISOString() };
}

async function http(app: App) {
  const built = await buildHttpApp(app, { runtime: {
    production: false, authRequired: false, demoRoutes: false,
    publicBaseUrl: 'http://127.0.0.1:3000', multiTenant: false,
  } });
  const server = built.server.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (body: unknown) => fetch(`${base}/api/sync/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function issues(response: Response): Promise<unknown[]> {
  return (await response.json() as { issues: unknown[] }).issues;
}

describe('sync for registered standard and custom pairs', () => {
  it('resolves non-core HubSpot standard webhook IDs through the registered pair', async () => {
    const { app } = await appWithPairs();
    await app.objectMappings!.create({ canonicalObject: 'appointment', label: 'Appointment',
      salesforceObject: 'Appointment__c', hubspotObject: '0-421' });
    const connector = new HubSpotConnector(app.config);
    const resolved = await connector.resolveWebhookEvent({
      system: 'hubspot', deliveryId: 'ticket-webhook', nativeObject: '0-5',
      sourceId: '123', changeType: 'updated', occurredAt: new Date().toISOString(),
    });
    expect(resolved).toMatchObject({ type: 'ticket', sourceId: '123', system: 'hubspot' });
    const custom = await connector.resolveWebhookEvent({
      system: 'hubspot', deliveryId: 'project-webhook', nativeObject: '2-12345',
      sourceId: '456', changeType: 'created', occurredAt: new Date().toISOString(),
    });
    expect(custom).toMatchObject({ type: 'project', sourceId: '456', system: 'hubspot' });
    const additional = await connector.resolveWebhookEvent({
      system: 'hubspot', deliveryId: 'appointment-webhook', nativeObject: '0-421',
      sourceId: '789', changeType: 'updated', occurredAt: new Date().toISOString(),
    });
    expect(additional).toMatchObject({ type: 'appointment', sourceId: '789', system: 'hubspot' });
  });

  it('starts new pairs paused and activates each direction only after read-only preflight', async () => {
    const { app, sf } = await appWithPairs();
    expect(app.syncConfig.get().objects.project).toBeUndefined();
    expect(app.syncConfig.get().objects.ticket).toBeUndefined();
    const patch = await http(app);
    const settings = (type: string) => ({ conflictStrategy: 'last-write-wins', sourceOfTruth: 'salesforce',
      objects: { [type]: { enabled: true, enrolledForSync: true, direction: 'bidirectional' } } });
    sf.defineNativeObject({
      object: { id: 'Project__c', label: 'Project', pluralLabel: 'Projects', custom: true,
        queryable: true, createable: true, updateable: true, deletable: true },
      fields: [{ name: 'External_Id__c', label: 'ID', type: 'string' },
        { name: 'Subject', label: 'Subject', type: 'string', readOnly: true }], relationships: [],
    });
    const rejected = await patch(settings('project'));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: 'sync_preflight_failed', type: 'project' });
    expect(app.syncConfig.get().objects.project).toBeUndefined();
    sf.defineNativeObject({
      object: { id: 'Project__c', label: 'Project', pluralLabel: 'Projects', custom: true,
        queryable: true, createable: true, updateable: true, deletable: true },
      fields: [{ name: 'External_Id__c', label: 'ID', type: 'string' },
        { name: 'Subject', label: 'Subject', type: 'string' }], relationships: [],
    });
    expect((await patch(settings('project'))).status).toBe(200);
    expect((await patch(settings('ticket'))).status).toBe(200);
    expect(app.syncConfig.get().objects.project?.enabled).toBe(true);
    expect(app.syncConfig.get().objects.ticket?.enabled).toBe(true);
  });

  it('refuses activation for missing, duplicate source, or duplicate destination keys', async () => {
    const { app, sf, hs } = await appWithPairs();
    const patch = await http(app);
    const settings = { conflictStrategy: 'last-write-wins', sourceOfTruth: 'salesforce',
      objects: { project: { enabled: true, enrolledForSync: true, direction: 'salesforce_to_hubspot' } } };
    app.config.clearNaturalKeyFields('project');
    const noKey = await patch(settings);
    expect(await issues(noKey)).toContainEqual(expect.objectContaining({ code: 'NATURAL_KEY_MISSING' }));
    app.config.configureNaturalKeyFields('project', ['externalId']);
    sf.seed('project', { externalId: 'P-duplicate', name: 'A' });
    const sourceB = sf.seed('project', { externalId: 'P-duplicate', name: 'B' });
    const duplicateSource = await patch(settings);
    expect(await issues(duplicateSource)).toContainEqual(
      expect.objectContaining({ code: 'SOURCE_NATURAL_KEY_DUPLICATES' }),
    );
    await sf.remove('project', sourceB);
    hs.seed('project', { externalId: 'P-duplicate', name: 'C' });
    hs.seed('project', { externalId: 'P-duplicate', name: 'D' });
    const duplicateTarget = await patch(settings);
    expect(await issues(duplicateTarget)).toContainEqual(
      expect.objectContaining({ code: 'TARGET_NATURAL_KEY_DUPLICATES' }),
    );
    expect(app.syncConfig.get().objects.project).toBeUndefined();
  });

  it('permits a readable one-way source and blocks reversing into that read-only object', async () => {
    const { app, sf } = await appWithPairs();
    sf.defineNativeObject({
      object: { id: 'Project__c', label: 'Project', pluralLabel: 'Projects', custom: true,
        queryable: true, createable: false, updateable: false, deletable: false },
      fields: [{ name: 'External_Id__c', label: 'ID', type: 'string' },
        { name: 'Subject', label: 'Subject', type: 'string' }], relationships: [],
    });
    const patch = await http(app);
    const settings = (direction: string) => ({ conflictStrategy: 'last-write-wins', sourceOfTruth: 'salesforce',
      objects: { project: { enabled: true, enrolledForSync: true, direction } } });
    expect((await patch(settings('salesforce_to_hubspot'))).status).toBe(200);
    const reverse = await patch(settings('bidirectional'));
    expect(reverse.status).toBe(409);
    expect(await issues(reverse)).toContainEqual(expect.objectContaining({ code: 'OBJECT_CAPABILITY_MISSING' }));
    expect(app.syncConfig.get().objects.project?.direction).toBe('salesforce_to_hubspot');
  });

  it('requires valid structured conditions when two sync pairs share a native object', async () => {
    const { app, sf } = await appWithPairs();
    await app.objectMappings!.create({ canonicalObject: 'project_copy', label: 'Project copy',
      salesforceObject: 'Project__c', hubspotObject: '2-67890' });
    await app.mappingStore.set('salesforce', 'project_copy', [
      { canonical: 'externalId', native: 'External_Id__c' }, { canonical: 'name', native: 'Subject' },
    ]);
    await app.mappingStore.set('hubspot', 'project_copy', [
      { canonical: 'externalId', native: 'external_id' }, { canonical: 'name', native: 'subject' },
    ]);
    await app.objectMappings!.setNaturalKeyFields('project_copy', ['externalId']);
    sf.defineNativeObject({
      object: { id: 'Project__c', label: 'Project', pluralLabel: 'Projects', custom: true,
        queryable: true, createable: true, updateable: true, deletable: true },
      fields: [{ name: 'External_Id__c', label: 'ID', type: 'string' },
        { name: 'Subject', label: 'Subject', type: 'string' },
        { name: 'Record_Type__c', label: 'Record type', type: 'string' }], relationships: [],
    });
    const patch = await http(app);
    const configured = (conditions?: Record<string, unknown>) => ({
      enabled: true, enrolledForSync: true, direction: 'salesforce_to_hubspot', ...conditions,
    });
    const payload = (objects: Record<string, unknown>) => ({
      conflictStrategy: 'last-write-wins', sourceOfTruth: 'salesforce', objects,
    });
    expect((await patch(payload({ project: configured() }))).status).toBe(200);
    const ambiguous = await patch(payload({ project_copy: configured() }));
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ error: 'ambiguous_sync_object_routing' });
    const invalid = await patch(payload({
      project: configured({ conditions: { salesforce: [{ field: 'Missing__c', operator: 'eq', value: 'A' }] } }),
      project_copy: configured({ conditions: { salesforce: [{ field: 'Record_Type__c', operator: 'eq', value: 'B' }] } }),
    }));
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({ error: 'sync_condition_field_missing' });
    const valid = await patch(payload({
      project: configured({ conditions: { salesforce: [{ field: 'Record_Type__c', operator: 'eq', value: 'A' }] } }),
      project_copy: configured({ conditions: { salesforce: [{ field: 'Record_Type__c', operator: 'eq', value: 'B' }] } }),
    }));
    expect(valid.status).toBe(200);
  });

  it('syncs custom and additional standard objects both ways through polling and webhook jobs', async () => {
    const { app, sf, hs } = await appWithPairs();
    await enable(app, 'project');
    const config = app.syncConfig.get();
    config.objects.ticket = { enabled: true, enrolledForSync: true, direction: 'bidirectional' };
    await app.syncConfig.update(config);
    const projectId = sf.seed('project', { externalId: 'P-1', name: 'Alpha' });
    const ticketId = sf.seed('ticket', { externalId: 'T-1', name: 'Issue' });
    await app.sync.enqueue([event('project', 'salesforce', projectId), event('ticket', 'salesforce', ticketId)]);
    await app.sync.drain();
    expect((await hs.list('project')).records).toHaveLength(1);
    expect((await hs.list('ticket')).records).toHaveLength(1);
    const reverse = hs.seed('project', { externalId: 'P-2', name: 'Beta' });
    await app.sync.enqueue([event('project', 'hubspot', reverse)]);
    await app.sync.drain();
    expect((await sf.list('project')).records).toHaveLength(2);
    await app.poller.runOnce('project');
    await app.poller.runOnce('ticket');
    await app.sync.drain();
    expect((await sf.list('project')).records).toHaveLength(2);
    expect((await hs.list('project')).records).toHaveLength(2);
    expect((await hs.list('ticket')).records).toHaveLength(1);
  });

  it('matches an existing destination and does not create a twin on replay', async () => {
    const { app, sf, hs } = await appWithPairs();
    await enable(app, 'project');
    const sourceId = sf.seed('project', { externalId: 'P-3', name: 'Same' });
    hs.seed('project', { externalId: 'P-3', name: 'Same' });
    await app.sync.enqueue([event('project', 'salesforce', sourceId)]);
    await app.sync.drain();
    await app.sync.enqueue([event('project', 'salesforce', sourceId)]);
    await app.sync.drain();
    expect((await hs.list('project')).records).toHaveLength(1);
    expect((await app.idMap.bySource('salesforce', sourceId, 'project'))?.ids.hubspot).toBeTruthy();
  });

  it('sends a custom record with no shared key to manual review before writing', async () => {
    const { app, sf, hs } = await appWithPairs();
    await enable(app, 'project');
    const id = sf.seed('project', { name: 'Missing key' });
    await app.sync.enqueue([event('project', 'salesforce', id)]);
    await app.sync.drain();
    expect((await app.sync.stats()).manualReview).toBe(1);
    expect(hs.writes).toHaveLength(0);
  });

  it('stops ambiguous destination matches for manual review', async () => {
    const { app, sf, hs } = await appWithPairs();
    await enable(app, 'project');
    const id = sf.seed('project', { externalId: 'P-duplicate', name: 'Source' });
    hs.seed('project', { externalId: 'P-duplicate', name: 'First match' });
    hs.seed('project', { externalId: 'P-duplicate', name: 'Second match' });
    await app.sync.enqueue([event('project', 'salesforce', id)]);
    await app.sync.drain();
    expect((await app.sync.stats()).manualReview).toBe(1);
    expect(hs.writes).toHaveLength(0);
    expect((await hs.list('project')).records).toHaveLength(2);
  });

  it('rechecks changed mappings before another custom record can write', async () => {
    const { app, sf, hs } = await appWithPairs();
    hs.defineNativeObject({
      object: { id: '2-12345', label: 'Project', pluralLabel: 'Projects', custom: true,
        queryable: true, createable: true, updateable: true, deletable: true },
      fields: [{ name: 'external_id', label: 'ID', type: 'string' },
        { name: 'subject', label: 'Subject', type: 'string' }], relationships: [],
    });
    await enable(app, 'project');
    const first = sf.seed('project', { externalId: 'P-before', name: 'Before' });
    await app.sync.enqueue([event('project', 'salesforce', first)]);
    await app.sync.drain();
    expect(hs.writes).toHaveLength(1);
    app.config.configureFieldRules('hubspot', 'project', [
      { canonical: 'externalId', native: 'external_id' },
      { canonical: 'name', native: 'removed_target_field' },
    ]);
    const second = sf.seed('project', { externalId: 'P-after', name: 'After' });
    await app.sync.enqueue([event('project', 'salesforce', second)]);
    await app.sync.drain();
    expect((await app.sync.stats()).manualReview).toBe(1);
    expect(hs.writes).toHaveLength(1);
  });

  it('retries a custom relationship after its related record becomes linked', async () => {
    const { app, sf, hs } = await appWithPairs();
    await enable(app, 'project');
    const projectId = sf.seed('project', { externalId: 'P-associated', name: 'Linked project' });
    const contactId = sf.seed('contact', { email: 'related@example.com', firstName: 'Related' });
    sf.link('project', projectId, 'contact', contactId);
    await app.sync.enqueue([event('project', 'salesforce', projectId)]);
    await app.sync.drain();
    expect(await app.associations.listPending(10, 'pending')).toHaveLength(1);
    await app.sync.enqueue([event('contact', 'salesforce', contactId)]);
    await app.sync.drain();
    expect(await app.associations.listPending(10, 'pending')).toHaveLength(0);
    const hsProjectId = (await app.idMap.bySource('salesforce', projectId, 'project'))?.ids.hubspot;
    const hsContactId = (await app.idMap.bySource('salesforce', contactId, 'contact'))?.ids.hubspot;
    expect(await hs.listAssociations('project', hsProjectId!)).toContainEqual(
      expect.objectContaining({ toType: 'contact', toId: hsContactId }),
    );
  });

  it('keeps paused custom events, discards events from the prohibited direction, and reviews deletions', async () => {
    const { app, sf, hs } = await appWithPairs();
    await enable(app, 'project', 'salesforce_to_hubspot');
    const hsId = hs.seed('project', { externalId: 'P-4', name: 'Reverse' });
    await app.sync.enqueue([event('project', 'hubspot', hsId)]);
    await app.sync.drain();
    expect(sf.writes).toHaveLength(0);
    const config = app.syncConfig.get();
    config.objects.project!.enabled = false;
    await app.syncConfig.update(config);
    const sfId = sf.seed('project', { externalId: 'P-5', name: 'Forward' });
    const [jobId] = await app.sync.enqueue([event('project', 'salesforce', sfId)]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await app.sync.store.get(jobId!))?.deferredReason).toContain('paused');
    expect(hs.writes).toHaveLength(0);
    config.objects.project!.enabled = true;
    await app.syncConfig.update(config);
    await app.sync.replay(jobId!);
    await app.sync.drain();
    expect(hs.writes).toHaveLength(1);
    await app.sync.enqueue([event('project', 'salesforce', sfId, 'deleted')]);
    await app.sync.drain();
    expect((await app.sync.stats()).manualReview).toBe(1);
    expect((await hs.list('project')).records).toHaveLength(2);
  });
});
