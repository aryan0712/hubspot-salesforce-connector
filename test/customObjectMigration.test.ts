import { describe, expect, it } from 'vitest';
import axios from 'axios';
import { createDefaultConfigContext } from '../src/core/configContext.js';
import { PreflightService } from '../src/engine/preflight.js';
import { MockConnector } from '../src/connectors/mock/mockConnector.js';
import { HubSpotConnector } from '../src/connectors/hubspot/hubspotConnector.js';
import { buildHarness } from './helpers/harness.js';

function projectConfig() {
  const config = createDefaultConfigContext('project');
  config.registerObjectMapping({
    canonicalObject: 'project', label: 'Project',
    salesforceObject: 'Project__c', hubspotObject: '2-12345',
  });
  config.configureFieldRules('salesforce', 'project', [
    { canonical: 'externalId', native: 'External_Id__c' },
    { canonical: 'name', native: 'Name' },
  ]);
  config.configureFieldRules('hubspot', 'project', [
    { canonical: 'externalId', native: 'external_id' },
    { canonical: 'name', native: 'project_name' },
  ]);
  config.configureNaturalKeyFields('project', ['externalId']);
  return config;
}

describe('registered custom-object migration', () => {
  it('runs a reviewed canary, reads it back, and executes the remaining records once', async () => {
    const h = await buildHarness({ config: projectConfig(), idMapInMemory: true });
    const first = h.sf.seed('project', { externalId: 'PRJ-1', name: 'First' });
    h.sf.seed('project', { externalId: 'PRJ-2', name: 'Second' });
    const catalog = await h.sf.listObjects();
    expect(catalog).toContainEqual(expect.objectContaining({ id: 'Project__c', canonicalType: 'project' }));
    const plan = await h.plans.create({ name: 'Project migration', source: 'salesforce', types: ['project'], limitPerType: 2 });
    const canary = await h.service.previewRecords({ from: 'salesforce', type: 'project', sourceIds: [first] });
    expect(canary.plans[0]!.action).toBe('create');
    expect(await h.plans.saveCanaryPreview(plan.id, plan.revision, 'project', first, canary.runId)).toBe(true);
    const tested = await h.service.executeCanary(plan.id, canary.runId);
    expect(tested.verification).toMatchObject({ passed: true, representativeWrite: true, testedTypes: ['project'] });
    const preview = await h.service.preview({ from: 'salesforce', types: ['project'], limitPerType: 2 });
    expect(await h.plans.savePreview(plan.id, plan.revision, preview.runId)).toBe(true);
    const outcome = await h.service.executePlan(plan.id, { wait: true, idempotencyKey: 'project-full-1' });
    expect(outcome.execution.status).toBe('succeeded');
    expect(h.hs.writes).toHaveLength(2);
    const replay = await h.service.executePlan(plan.id, { wait: true, idempotencyKey: 'project-full-1' });
    expect(replay.replayed).toBe(true);
    expect(h.hs.writes).toHaveLength(2);
  });

  it('previews and writes the reverse direction through the same mapping core', async () => {
    const h = await buildHarness({ config: projectConfig(), idMapInMemory: true });
    const id = h.hs.seed('project', { externalId: 'PRJ-3', name: 'Third' });
    const preview = await h.service.previewRecords({ from: 'hubspot', type: 'project', sourceIds: [id] });
    expect(preview.plans[0]!.writes?.[0]?.system).toBe('salesforce');
    const outcome = await h.service.executeDirect(preview.runId, { wait: true });
    expect(outcome.execution.status).toBe('succeeded');
    expect(h.sf.writes[0]?.payload).toMatchObject({ External_Id__c: 'PRJ-3', Name: 'Third' });
  });

  it('blocks a missing key, a missing record key, and a duplicate destination key', async () => {
    const config = projectConfig();
    config.clearNaturalKeyFields('project');
    const h = await buildHarness({ config, idMapInMemory: true });
    expect((await h.service.checks('salesforce', ['project'])).checks[0]!.issues)
      .toContainEqual(expect.objectContaining({ code: 'NATURAL_KEY_MISSING', severity: 'error' }));
    config.configureNaturalKeyFields('project', ['externalId']);
    const missing = h.sf.seed('project', { name: 'Missing key' });
    expect((await h.service.checks('salesforce', ['project'])).checks[0]!.issues)
      .toContainEqual(expect.objectContaining({ code: 'NATURAL_KEY_MISSING_VALUES', severity: 'error' }));
    await expect(h.service.previewRecords({ from: 'salesforce', type: 'project', sourceIds: [missing] })).rejects.toThrow();
    h.sf.seed('project', { externalId: 'PRJ-4', name: 'Source' });
    h.hs.seed('project', { externalId: 'PRJ-4', name: 'Target A' });
    h.hs.seed('project', { externalId: 'PRJ-4', name: 'Target B' });
    expect((await h.service.checks('salesforce', ['project'])).checks[0]!.issues)
      .toContainEqual(expect.objectContaining({ code: 'TARGET_NATURAL_KEY_DUPLICATES', severity: 'error' }));
  });

  it('keeps live custom-object execution closed and rejects unsafe identifiers', async () => {
    const config = projectConfig();
    const connectors = {
      salesforce: new MockConnector('salesforce', config),
      hubspot: new MockConnector('hubspot', config),
    };
    const report = await new PreflightService(connectors, config).run('salesforce', 'project');
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'CUSTOM_OBJECT_EXECUTION_DISABLED' }));
    expect(() => config.registerObjectMapping({
      canonicalObject: 'bad', label: 'Bad', salesforceObject: 'Project__c WHERE Name != null',
    })).toThrow(/invalid Salesforce object/);
    expect(() => config.configureFieldRules('salesforce', 'project', [
      { canonical: 'name', native: 'Name FROM Account' },
    ])).toThrow(/invalid native field/);
    const retargeted = createDefaultConfigContext('retargeted');
    retargeted.registerObjectMapping({ canonicalObject: 'contact', label: 'Contact',
      salesforceObject: 'Project__c', hubspotObject: '2-12345' });
    const retargetedConnectors = {
      salesforce: new MockConnector('salesforce', retargeted),
      hubspot: new MockConnector('hubspot', retargeted),
    };
    const retargetedReport = await new PreflightService(retargetedConnectors, retargeted)
      .run('salesforce', 'contact');
    expect(retargetedReport.issues).toContainEqual(
      expect.objectContaining({ code: 'CUSTOM_OBJECT_EXECUTION_DISABLED' }));
  });

  it('rejects unmapped enum values and calculated fields before preview', async () => {
    const config = projectConfig();
    config.configureFieldRules('salesforce', 'project', [
      ...config.fieldRules('salesforce', 'project'),
      { canonical: 'state', native: 'State__c' },
      { canonical: 'startDate', native: 'Start_Date__c' },
    ]);
    config.configureFieldRules('hubspot', 'project', [
      ...config.fieldRules('hubspot', 'project'),
      { canonical: 'state', native: 'state' },
      { canonical: 'startDate', native: 'start_at' },
    ]);
    const h = await buildHarness({ config, idMapInMemory: true });
    h.sf.defineNativeObject({
      object: { id: 'Project__c', label: 'Project', pluralLabel: 'Projects', custom: true,
        queryable: true, createable: true, updateable: true, deletable: false },
      fields: [
        { name: 'External_Id__c', label: 'External ID', type: 'string' },
        { name: 'Name', label: 'Name', type: 'string', calculated: true },
        { name: 'State__c', label: 'State', type: 'picklist', options: [
          { value: 'new', label: 'New' }, { value: 'done', label: 'Done' },
        ] },
        { name: 'Start_Date__c', label: 'Start date', type: 'date' },
      ], relationships: [],
    });
    h.hs.defineNativeObject({
      object: { id: '2-12345', label: 'Project', pluralLabel: 'Projects', custom: true,
        queryable: true, createable: true, updateable: true, deletable: false },
      fields: [
        { name: 'external_id', label: 'External ID', type: 'string' },
        { name: 'project_name', label: 'Name', type: 'string' },
        { name: 'state', label: 'State', type: 'enumeration', options: [{ value: 'new', label: 'New' }] },
        { name: 'start_at', label: 'Start at', type: 'datetime' },
      ], relationships: [],
    });
    const report = (await h.service.checks('salesforce', ['project'])).checks[0]!;
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSUPPORTED_SOURCE_FIELD', field: 'Name' }),
      expect.objectContaining({ code: 'ENUM_VALUE_UNMAPPED', field: 'state' }),
      expect.objectContaining({ code: 'FIELD_TYPE_MISMATCH', field: 'startDate', severity: 'error' }),
    ]));
  });

  it('rejects malformed custom scalar transforms without logging their values', () => {
    const config = projectConfig();
    config.configureFieldRules('salesforce', 'project', [
      ...config.fieldRules('salesforce', 'project'),
      { canonical: 'budget', native: 'Budget__c', toCanonical: 'number' },
      { canonical: 'active', native: 'Active__c', toCanonical: 'boolean' },
      { canonical: 'startDate', native: 'Start_Date__c', toCanonical: 'date-only' },
    ]);
    expect(() => config.toCanonicalFields('salesforce', 'project', { Budget__c: '0:0' }))
      .toThrow('invalid numeric value in Budget__c');
    expect(() => config.toCanonicalFields('salesforce', 'project', { Active__c: 'maybe' }))
      .toThrow('invalid boolean value in Active__c');
    expect(() => config.toCanonicalFields('salesforce', 'project', { Start_Date__c: '2026-02-30' }))
      .toThrow('invalid date value in Start_Date__c');
    expect(config.toCanonicalFields('salesforce', 'project', { Budget__c: '', Active__c: '' }))
      .toMatchObject({ budget: null, active: null });
  });

  it('finds a source collision beyond the sampled page and refuses the preview', async () => {
    const h = await buildHarness({ config: projectConfig(), idMapInMemory: true });
    for (let i = 0; i < 101; i += 1) h.sf.seed('project', { externalId: `PRJ-${i}`, name: `Project ${i}` });
    h.sf.seed('project', { externalId: 'PRJ-0', name: 'Duplicate later' });
    const preview = await h.service.preview({ from: 'salesforce', types: ['project'], limitPerType: 102 });
    expect(preview.plans.filter((plan) => plan.action === 'error')).toHaveLength(1);
    await expect(h.service.executeDirect(preview.runId)).rejects.toThrow(/could not be planned/);
    expect(h.hs.writes).toHaveLength(0);
    await expect(h.service.preview({ from: 'salesforce', types: ['project'], limitPerType: 501 }))
      .rejects.toThrow(/limit of 1/);
  });

  it('reports missing HubSpot custom-schema scope while keeping built-in objects usable', async () => {
    const connector = new HubSpotConnector(projectConfig());
    const forbidden = new axios.AxiosError('missing scopes', 'ERR_BAD_REQUEST', undefined, undefined,
      { status: 403, data: { category: 'MISSING_SCOPES' } } as never);
    (connector as unknown as { http: { get: (url: string) => Promise<{ data: unknown }> } }).http = {
      get: async (url) => {
        if (url === '/crm/v3/schemas') throw forbidden;
        return { data: { results: [] } };
      },
    };
    const catalog = await connector.listObjects();
    expect(catalog.some((object) => object.id === 'contacts')).toBe(true);
    expect(catalog).toContainEqual(expect.objectContaining({ id: '0-421', label: 'Appointment' }));
    expect(catalog).toContainEqual(expect.objectContaining({ id: '0-101', createable: false }));
    expect(connector.catalogWarnings()).toEqual([expect.stringContaining('crm.schemas.custom.read')]);
    expect((await connector.describeObject('contacts')).object.id).toBe('contacts');
    await expect(connector.describeObject('2-12345')).rejects.toMatchObject({ code: 'hubspot_custom_schema_unavailable' });
  });
});
