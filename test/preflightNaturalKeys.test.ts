import { describe, expect, it } from 'vitest';
import type { CRMConnector } from '../src/core/connector.js';
import { createDefaultConfigContext } from '../src/core/configContext.js';
import type { SystemId } from '../src/core/types.js';
import { MockConnector } from '../src/connectors/mock/mockConnector.js';
import { PreflightService } from '../src/engine/preflight.js';
import { PreflightFailedError } from '../src/engine/migrationService.js';
import { buildHarness } from './helpers/harness.js';

describe('natural-key preflight profiling', () => {
  it('blocks a registered object with no writable mappings before a migration preview', async () => {
    const config = createDefaultConfigContext('empty-object');
    config.configureObjectMappings([
      ...config.listCanonicalObjects(),
      { canonicalObject: 'account_contact', label: 'Case contact', salesforceObject: 'Case', hubspotObject: 'contacts' },
    ]);
    const h = await buildHarness({ config, idMapInMemory: true });
    h.hs.seed('account_contact', { firstName: 'Ada' });

    const { checks } = await h.service.checks('hubspot', ['account_contact']);
    expect(checks[0]!.ok).toBe(false);
    expect(checks[0]!.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code))
      .toEqual(expect.arrayContaining([
        'SOURCE_MAPPING_EMPTY', 'TARGET_MAPPING_EMPTY', 'NO_WRITABLE_SHARED_FIELDS',
      ]));
    await expect(h.service.preview({ from: 'hubspot', types: ['account_contact'], limitPerType: 1 }))
      .rejects.toBeInstanceOf(PreflightFailedError);
    expect(h.sf.writes).toHaveLength(0);
    expect(h.hs.writes).toHaveLength(0);
  });

  it('warns about missing source identities and blocks duplicate destination identities', async () => {
    const config = createDefaultConfigContext('preflight-test');
    config.configureNaturalKeyFields('company', ['domain']);
    const salesforce = new MockConnector('salesforce', config);
    const hubspot = new MockConnector('hubspot', config);
    salesforce.seed('company', { name: 'No domain' });
    salesforce.seed('company', { name: 'Unique', domain: 'unique.test' });
    hubspot.seed('company', { name: 'First duplicate', domain: 'unique.test' });
    hubspot.seed('company', { name: 'Second duplicate', domain: 'unique.test' });
    const connectors: Record<SystemId, CRMConnector> = { salesforce, hubspot };

    const report = await new PreflightService(connectors, config).run('salesforce', 'company');

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NATURAL_KEY_MISSING_VALUES', severity: 'warning' }),
      expect.objectContaining({ code: 'TARGET_NATURAL_KEY_DUPLICATES', severity: 'error' }),
    ]));
    expect(report.ok).toBe(false);
  });

  it('does not block a selected-record preflight for unrelated destination duplicates', async () => {
    const h = await buildHarness({ idMapInMemory: true });
    const sourceId = h.sf.seed('company', { name: 'Selected source', domain: 'selected.test' });
    h.hs.seed('company', { name: 'Unrelated duplicate one', domain: 'other.test' });
    h.hs.seed('company', { name: 'Unrelated duplicate two', domain: 'other.test' });

    const preview = await h.service.previewRecords({ from: 'salesforce', type: 'company', sourceIds: [sourceId] });

    expect(preview.plans).toHaveLength(1);
    expect(preview.plans[0]!.action).toBe('create');
    expect(preview.checks[0]!.issues).not.toContainEqual(expect.objectContaining({ code: 'TARGET_NATURAL_KEY_DUPLICATES' }));
  });

  it('allows an unambiguous HubSpot record to preview toward Salesforce despite unrelated duplicate keys', async () => {
    const h = await buildHarness({ idMapInMemory: true });
    const sourceId = h.hs.seed('company', { name: 'Selected source', domain: 'selected.test' });
    h.sf.seed('company', { name: 'Unrelated duplicate one', domain: 'other.test' });
    h.sf.seed('company', { name: 'Unrelated duplicate two', domain: 'other.test' });

    const preview = await h.service.previewRecords({ from: 'hubspot', type: 'company', sourceIds: [sourceId] });

    expect(preview.plans).toHaveLength(1);
    expect(preview.plans[0]!.action).toBe('create');
    expect(preview.plans[0]!.writes!.map((write) => write.system)).toEqual(['salesforce']);
  });

  it('blocks a selected-record preflight when its exact destination key is duplicated', async () => {
    const h = await buildHarness({ idMapInMemory: true });
    const sourceId = h.sf.seed('company', { name: 'Selected source', domain: 'collision.test' });
    h.hs.seed('company', { name: 'Collision one', domain: 'collision.test' });
    h.hs.seed('company', { name: 'Collision two', domain: 'collision.test' });

    await expect(h.service.previewRecords({ from: 'salesforce', type: 'company', sourceIds: [sourceId] }))
      .rejects.toBeInstanceOf(PreflightFailedError);
  });

  it('blocks a HubSpot record when its exact Salesforce destination key is duplicated', async () => {
    const h = await buildHarness({ idMapInMemory: true });
    const sourceId = h.hs.seed('company', { name: 'Selected source', domain: 'collision.test' });
    h.sf.seed('company', { name: 'Collision one', domain: 'collision.test' });
    h.sf.seed('company', { name: 'Collision two', domain: 'collision.test' });

    await expect(h.service.previewRecords({ from: 'hubspot', type: 'company', sourceIds: [sourceId] }))
      .rejects.toBeInstanceOf(PreflightFailedError);
  });

  it('checks every canary scope schema without profiling unrelated destination duplicates', async () => {
    const h = await buildHarness({ idMapInMemory: true });
    const sourceId = h.sf.seed('contact', { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@selected.test' });
    h.sf.seed('company', { name: 'Selected Company', domain: 'selected.test' });
    h.hs.seed('company', { name: 'Unrelated duplicate one', domain: 'other.test' });
    h.hs.seed('company', { name: 'Unrelated duplicate two', domain: 'other.test' });

    const preview = await h.service.previewRecords({
      from: 'salesforce',
      type: 'contact',
      sourceIds: [sourceId],
      scopeTypes: ['company'],
    });

    expect(preview.checks.map((check) => check.type).sort()).toEqual(['company', 'contact']);
    expect(preview.checks.find((check) => check.type === 'company')!.issues)
      .not.toContainEqual(expect.objectContaining({ code: 'TARGET_NATURAL_KEY_DUPLICATES' }));
  });
});
