import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalInvalidatedError,
  PreviewDriftError,
} from '../src/engine/migrationEngine.js';
import { IdentityConflictError } from '../src/engine/reconciler.js';
import { ConditionalWriteRejectedError } from '../src/core/connector.js';
import { buildHarness, NEW, OLD, type Harness } from './helpers/harness.js';

/**
 * R02 regressions: a directional migration writes only to the destination, executes the
 * exact reviewed payload, and refuses (without writing) when anything it was approved
 * against changed.
 */
let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});

const ada = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+1-111' };

describe('R02 destination-only migration', () => {
  it('never changes Salesforce when the matching HubSpot value is newer', async () => {
    const sfId = h.sf.seed('contact', ada);
    h.sf.setModifiedAt('contact', sfId, OLD);
    const hsId = h.hs.seed('contact', { ...ada, firstName: 'Augusta' });
    h.hs.setModifiedAt('contact', hsId, NEW);

    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    const plan = preview.plans[0]!;
    expect(plan.writes!.every((write) => write.system === 'hubspot')).toBe(true);
    expect(plan.conflict?.keptDestinationFields).toContain('firstName');

    await h.engine.executePreview(preview.runId);

    expect(h.sf.writes).toHaveLength(0);
    expect(h.sf.peek('contact', sfId, 'FirstName')).toBe('Ada');
    expect(h.hs.peek('contact', hsId, 'firstname')).toBe('Augusta');
    const link = await h.idMap.bySource('salesforce', sfId);
    expect(link?.ids.hubspot).toBe(hsId);
  });

  it('writes the source value to the destination when the source wins, still never back to the source', async () => {
    h.conflict.strategy = 'source-of-truth';
    h.conflict.sourceOfTruth = 'salesforce';
    const sfId = h.sf.seed('contact', ada);
    h.sf.setModifiedAt('contact', sfId, OLD);
    const hsId = h.hs.seed('contact', { ...ada, firstName: 'Augusta' });
    h.hs.setModifiedAt('contact', hsId, NEW);

    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    await h.engine.executePreview(preview.runId);

    expect(h.sf.writes).toHaveLength(0);
    expect(h.hs.peek('contact', hsId, 'firstname')).toBe('Ada');
  });

  it('executes exactly the reviewed native payload', async () => {
    h.sf.seed('contact', ada);
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    const reviewed = preview.plans[0]!.writes![0]!;
    await h.engine.executePreview(preview.runId);
    expect(h.hs.writes).toHaveLength(1);
    expect(h.hs.writes[0]!.payload).toEqual(reviewed.payload);
    expect(h.hs.writes[0]!.targetId).toBe(reviewed.targetId);
  });

  it('only sends the fields that change on an update', async () => {
    const sfId = h.sf.seed('contact', { ...ada, title: 'Mathematician' });
    h.sf.setModifiedAt('contact', sfId, NEW);
    const hsId = h.hs.seed('contact', ada);
    h.hs.setModifiedAt('contact', hsId, OLD);
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    expect(preview.plans[0]!.writes![0]).toMatchObject({
      operation: 'update',
      targetId: hsId,
      payload: { jobtitle: 'Mathematician' },
    });
    await h.engine.executePreview(preview.runId);
    expect(h.hs.writes.map((write) => write.payload)).toEqual([{ jobtitle: 'Mathematician' }]);
  });

  it('a skipped record produces zero CRM writes', async () => {
    const sfId = h.sf.seed('contact', ada);
    const hsId = h.hs.seed('contact', ada);
    // First execution links the pair (no field differs, so no write is needed at all).
    const first = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    expect(first.plans[0]).toMatchObject({ action: 'match', writes: [] });
    await h.engine.executePreview(first.runId);
    expect((await h.idMap.bySource('salesforce', sfId))?.ids.hubspot).toBe(hsId);

    const second = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    expect(second.plans[0]).toMatchObject({ action: 'skip', writes: [] });
    const report = await h.engine.executePreview(second.runId);
    expect(report.writes).toBe(0);
    expect(h.hs.writes).toHaveLength(0);
    expect(h.sf.writes).toHaveLength(0);
  });
});

describe('R02 approval invalidation', () => {
  it('a changed mapping invalidates the approval before any write', async () => {
    h.sf.seed('contact', ada);
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    h.config.configureFieldRules('hubspot', 'contact', [
      ...h.config.fieldRules('hubspot', 'contact').filter((rule) => rule.canonical !== 'phone'),
      { canonical: 'phone', native: 'mobilephone' },
    ]);
    await expect(h.engine.executePreview(preview.runId)).rejects.toMatchObject({
      name: 'ApprovalInvalidatedError',
      reason: 'configuration',
    });
    expect(h.hs.writes).toHaveLength(0);
  });

  it('a changed value translation or natural key invalidates the approval', async () => {
    h.sf.seed('contact', ada);
    const first = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    h.config.configureValueMappings([
      { type: 'contact', canonicalField: 'title', canonicalValue: 'ceo', hubspotValue: 'CEO' },
    ]);
    await expect(h.engine.executePreview(first.runId)).rejects.toBeInstanceOf(ApprovalInvalidatedError);
    const second = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    h.config.configureNaturalKeyFields('contact', ['email', 'lastName']);
    await expect(h.engine.executePreview(second.runId)).rejects.toBeInstanceOf(ApprovalInvalidatedError);
    expect(h.hs.writes).toHaveLength(0);
  });

  it('a changed conflict policy invalidates the approval', async () => {
    h.sf.seed('contact', ada);
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    h.conflict.strategy = 'field-merge';
    await expect(h.engine.executePreview(preview.runId)).rejects.toMatchObject({ reason: 'conflict_policy' });
    expect(h.hs.writes).toHaveLength(0);
  });

  it('a different connected account invalidates the approval', async () => {
    h.sf.seed('contact', ada);
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    h.hs.accountIdentity = async () => 'mock:hubspot:another-portal';
    await expect(h.engine.executePreview(preview.runId)).rejects.toMatchObject({ reason: 'account' });
    expect(h.hs.writes).toHaveLength(0);
  });

  it('a changed schema invalidates the approval (service path)', async () => {
    h.sf.seed('contact', ada);
    const preview = await h.service.preview({ from: 'salesforce', types: ['contact'] });
    const describe = h.hs.describe.bind(h.hs);
    h.hs.describe = async (type) => [
      ...(await describe(type)),
      { name: 'new_property', label: 'New', type: 'string' },
    ];
    await expect(h.service.executeDirect(preview.runId)).rejects.toMatchObject({ reason: 'schema' });
    expect(h.hs.writes).toHaveLength(0);
  });

  it('changed source or destination values stop execution before any write', async () => {
    const sfId = h.sf.seed('contact', ada);
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    const changed = (await h.sf.read('contact', sfId))!;
    await h.sf.upsert({ ...changed, fields: { ...changed.fields, firstName: 'Grace' } }, sfId);
    await expect(h.engine.executePreview(preview.runId)).rejects.toBeInstanceOf(PreviewDriftError);

    const hsId = h.hs.seed('contact', { ...ada, email: 'other@example.com' });
    const sf2 = h.sf.seed('contact', { ...ada, email: 'other@example.com', title: 'Engineer' });
    h.sf.setModifiedAt('contact', sf2, NEW);
    h.hs.setModifiedAt('contact', hsId, OLD);
    const second = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    await h.hs.upsert({ canonicalId: '', type: 'contact', fields: { phone: '+9' }, meta: { source: 'hubspot', sourceId: hsId, modifiedAt: NEW } }, hsId);
    const writesBefore = h.hs.writes.length;
    await expect(h.engine.executePreview(second.runId)).rejects.toBeInstanceOf(PreviewDriftError);
    expect(h.hs.writes.length).toBe(writesBefore);
  });

  it('a destination record that appears after review blocks a planned create', async () => {
    h.sf.seed('contact', ada);
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    expect(preview.plans[0]!.action).toBe('create');
    h.hs.seed('contact', ada);
    await expect(h.engine.executePreview(preview.runId)).rejects.toThrow(/appeared after review/);
    expect(h.hs.writes).toHaveLength(0);
  });

  it('refuses a preview that contains an ambiguous match', async () => {
    h.sf.seed('contact', ada);
    h.hs.seed('contact', ada);
    h.hs.seed('contact', ada);
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    await expect(h.engine.executePreview(preview.runId)).rejects.toThrow('ambiguous');
    expect(h.hs.writes).toHaveLength(0);
  });
});

describe('R02 uncertainty stops execution', () => {
  it('stops at the first failed write; later records are never written', async () => {
    h.sf.seed('contact', { ...ada, email: 'one@example.com' });
    h.sf.seed('contact', { ...ada, email: 'two@example.com' });
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    const write = h.hs.write.bind(h.hs);
    let calls = 0;
    h.hs.write = async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return write(...args);
    };
    await expect(h.engine.executePreview(preview.runId)).rejects.toThrow('socket hang up');
    expect(calls).toBe(1);
    expect((await h.hs.list('contact')).records).toHaveLength(0);
    const runs = await h.runs.list();
    expect(runs[0]).toMatchObject({ mode: 'execute', status: 'failed' });
  });

  it('does not retarget an approved write when the link changed after review', async () => {
    const sfId = h.sf.seed('contact', { ...ada, title: 'Mathematician' });
    h.sf.setModifiedAt('contact', sfId, NEW);
    const hsId = h.hs.seed('contact', ada);
    h.hs.setModifiedAt('contact', hsId, OLD);
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    // Another process links the source to a different destination record after review.
    await h.idMap.upsertLink({
      canonicalId: 'other-link',
      type: 'contact',
      ids: { salesforce: sfId, hubspot: 'hubspot-someone-else' },
      hashes: {},
      modifiedAt: {},
      naturalKeys: [],
      updatedAt: new Date().toISOString(),
    });
    await expect(h.engine.executePreview(preview.runId)).rejects.toBeInstanceOf(IdentityConflictError);
    expect(h.hs.writes).toHaveLength(0);
  });

  it('sends conditional updates so a change between check and write is rejected', async () => {
    const sfId = h.sf.seed('contact', { ...ada, title: 'Mathematician' });
    h.sf.setModifiedAt('contact', sfId, NEW);
    const hsId = h.hs.seed('contact', ada);
    h.hs.setModifiedAt('contact', hsId, OLD);
    const preview = await h.engine.preview({ from: 'salesforce', types: ['contact'] });
    expect(preview.plans[0]!.writes![0]!.expectedModifiedAt).toBe(OLD);
    // Someone edits the destination after the final re-check but before the write lands.
    const write = h.hs.write.bind(h.hs);
    h.hs.write = async (type, payload, targetId, options) => {
      h.hs.setModifiedAt('contact', hsId, NEW);
      return write(type, payload, targetId, options);
    };
    await expect(h.engine.executePreview(preview.runId)).rejects.toBeInstanceOf(ConditionalWriteRejectedError);
    expect(h.hs.peek('contact', hsId, 'jobtitle')).not.toBe('Mathematician');
  });

  it('refuses a legacy preview that has no frozen plan', async () => {
    const runId = await h.runs.begin({ source: 'salesforce', types: ['contact'], mode: 'preview', options: {} });
    await h.runs.recordPlan(runId, {
      type: 'contact',
      from: 'salesforce',
      to: 'hubspot',
      sourceId: 'x',
      action: 'create',
      fieldDiff: [],
      warnings: [],
    });
    await h.runs.complete(runId, {
      runId,
      perType: {},
      mode: 'preview',
      plans: [],
      startedAt: '',
      finishedAt: '',
    });
    await expect(h.engine.executePreview(runId)).rejects.toMatchObject({ reason: 'format' });
  });
});

describe('R02 preview is the default', () => {
  it('run() without dryRun only previews', async () => {
    h.sf.seed('contact', ada);
    const report = await h.engine.run({ from: 'salesforce', types: ['contact'] });
    expect(report.mode).toBe('preview');
    expect(h.hs.writes).toHaveLength(0);
  });
});
