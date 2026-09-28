import { beforeEach, describe, expect, it } from 'vitest';
import { valuesMatch } from '../src/engine/migrationService.js';
import type { MigrationPlan } from '../src/engine/migrationPlanStore.js';
import { buildHarness, NEW, OLD, type Harness } from './helpers/harness.js';

/**
 * R04 acceptance: a test run only unlocks full execution when every tested record was
 * read back and matched the reviewed result, and at least one record was a real write.
 * All-failed, empty, incorrect, unreadable and mixed batches leave execution locked.
 */
let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});

const person = (n: number) => ({ firstName: `Person ${n}`, lastName: 'Test', email: `person${n}@example.com` });

async function testPlan(types = ['contact']): Promise<MigrationPlan> {
  return h.plans.create({ name: 'R04 plan', source: 'salesforce', types });
}

async function runTest(plan: MigrationPlan, type: string, sourceIds: string[]) {
  const preview = await h.service.previewRecords({ from: 'salesforce', type, sourceIds, scopeTypes: plan.types });
  const marker = sourceIds.length === 1 ? sourceIds[0]! : `batch:${sourceIds.length}`;
  expect(await h.plans.saveCanaryPreview(plan.id, plan.revision, type, marker, preview.runId)).toBe(true);
  const outcome = await h.service.executeCanary(plan.id, preview.runId);
  return { preview, outcome, plan: (await h.plans.get(plan.id))! };
}

async function fullPreview(plan: MigrationPlan): Promise<void> {
  const preview = await h.service.preview({ from: 'salesforce', types: plan.types });
  expect(await h.plans.savePreview(plan.id, plan.revision, preview.runId)).toBe(true);
}

describe('R04 canary verification', () => {
  it('a passing test stores expected/actual evidence and unlocks full execution', async () => {
    const id = h.sf.seed('contact', person(1));
    const plan = await testPlan();
    const { outcome, plan: after } = await runTest(plan, 'contact', [id]);
    expect(outcome.verification).toMatchObject({ passed: true, representativeWrite: true, testedTypes: ['contact'] });
    const evidence = outcome.verification!.items[0]!;
    expect(evidence.wrote).toBe(true);
    expect(evidence.expected).toMatchObject({ firstName: 'Person 1', email: 'person1@example.com' });
    expect(evidence.actual).toMatchObject({ firstName: 'Person 1', email: 'person1@example.com' });
    expect(evidence.mismatches).toEqual([]);
    expect(after.canary?.verifiedAt).toBeTruthy();
    expect(after.canary?.verification?.passed).toBe(true);
    await fullPreview(after);
    await expect(h.service.executePlan(plan.id)).resolves.toMatchObject({ replayed: false });
  });

  it('an all-failed batch leaves execution locked', async () => {
    const ids = [h.sf.seed('contact', person(1)), h.sf.seed('contact', person(2))];
    h.hs.write = async () => {
      throw new Error('INVALID_EMAIL_ADDRESS');
    };
    const plan = await testPlan();
    const { outcome, plan: after } = await runTest(plan, 'contact', ids);
    expect(outcome.verification?.passed).toBe(false);
    expect(outcome.verification?.reasons.join(' ')).toMatch(/INVALID_EMAIL_ADDRESS/);
    expect(after.canary?.verifiedAt).toBeUndefined();
    await fullPreview(after);
    await expect(h.service.executePlan(plan.id)).rejects.toMatchObject({ code: 'plan_state' });
  });

  it('an empty batch leaves execution locked', async () => {
    const plan = await testPlan();
    const { outcome, plan: after } = await runTest(plan, 'contact', []);
    expect(outcome.verification?.passed).toBe(false);
    expect(outcome.verification?.reasons.join(' ')).toMatch(/zero records/);
    expect(after.canary?.verifiedAt).toBeUndefined();
  });

  it('a mixed-success batch leaves execution locked', async () => {
    const ids = [h.sf.seed('contact', person(1)), h.sf.seed('contact', person(2))];
    const write = h.hs.write.bind(h.hs);
    let calls = 0;
    h.hs.write = async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('rate limited');
      return write(...args);
    };
    const plan = await testPlan();
    const { outcome, plan: after } = await runTest(plan, 'contact', ids);
    expect(outcome.verification?.passed).toBe(false);
    expect(outcome.verification?.items.filter((item) => item.wrote)).toHaveLength(1);
    expect(after.canary?.verifiedAt).toBeUndefined();
  });

  it('an existing-but-incorrect destination fails verification', async () => {
    const id = h.sf.seed('contact', person(1));
    // The destination silently drops a property (e.g. a read-only or mis-typed field).
    const write = h.hs.write.bind(h.hs);
    h.hs.write = async (type, payload, targetId, options) => {
      const { lastname: _dropped, ...rest } = payload;
      return write(type, rest, targetId, options);
    };
    const plan = await testPlan();
    const { outcome } = await runTest(plan, 'contact', [id]);
    expect(outcome.verification?.passed).toBe(false);
    expect(outcome.verification?.items[0]?.mismatches.map((mismatch) => mismatch.field)).toContain('lastName');
  });

  it('a failed read-back fails verification', async () => {
    const id = h.sf.seed('contact', person(1));
    const plan = await testPlan();
    const preview = await h.service.previewRecords({ from: 'salesforce', type: 'contact', sourceIds: [id] });
    await h.plans.saveCanaryPreview(plan.id, plan.revision, 'contact', id, preview.runId);
    const read = h.hs.read.bind(h.hs);
    let armed = false;
    const write = h.hs.write.bind(h.hs);
    h.hs.write = async (...args) => {
      const result = await write(...args);
      armed = true;
      return result;
    };
    h.hs.read = async (...args) => {
      if (armed) throw new Error('read timeout');
      return read(...args);
    };
    const outcome = await h.service.executeCanary(plan.id, preview.runId);
    expect(outcome.verification?.passed).toBe(false);
    expect(outcome.verification?.reasons.join(' ')).toMatch(/read-back failed/);
  });

  it('a skipped existing record is not labeled a successful write test', async () => {
    const id = h.sf.seed('contact', person(1));
    h.hs.seed('contact', person(1));
    const plan = await testPlan();
    const { outcome, plan: after } = await runTest(plan, 'contact', [id]);
    expect(outcome.verification?.representativeWrite).toBe(false);
    expect(outcome.verification?.passed).toBe(false);
    expect(outcome.verification?.reasons.join(' ')).toMatch(/no record was actually written/);
    expect(after.canary?.verifiedAt).toBeUndefined();
  });

  it('changing the tested configuration invalidates the verification', async () => {
    const id = h.sf.seed('contact', person(1));
    h.sf.seed('contact', person(2));
    const plan = await testPlan();
    const { plan: after } = await runTest(plan, 'contact', [id]);
    await fullPreview(after);
    h.config.configureFieldRules('hubspot', 'contact', [
      ...h.config.fieldRules('hubspot', 'contact').filter((rule) => rule.canonical !== 'phone'),
      { canonical: 'phone', native: 'mobilephone' },
    ]);
    const writes = h.hs.writes.length;
    await expect(h.service.executePlan(plan.id)).rejects.toMatchObject({ code: 'plan_state' });
    expect(h.hs.writes.length).toBe(writes);
  });

  it('a multi-object plan needs a passing write test for every selected object', async () => {
    const contactId = h.sf.seed('contact', person(1));
    const companyId = h.sf.seed('company', { name: 'Analytical Engines', domain: 'analytical.test' });
    const plan = await testPlan(['contact', 'company']);
    await runTest(plan, 'contact', [contactId]);
    await fullPreview((await h.plans.get(plan.id))!);
    await expect(h.service.executePlan(plan.id)).rejects.toMatchObject({
      code: 'plan_state',
      detail: expect.anything(),
    });
    const { outcome } = await runTest((await h.plans.get(plan.id))!, 'company', [companyId]);
    expect(outcome.verification?.testedTypes.sort()).toEqual(['company', 'contact']);
    await fullPreview((await h.plans.get(plan.id))!);
    await expect(h.service.executePlan(plan.id)).resolves.toMatchObject({ replayed: false });
  });

  it('drift between test preview and execution fails the test without writing', async () => {
    const id = h.sf.seed('contact', { ...person(1), title: 'Engineer' });
    h.sf.setModifiedAt('contact', id, NEW);
    const plan = await testPlan();
    const preview = await h.service.previewRecords({ from: 'salesforce', type: 'contact', sourceIds: [id] });
    await h.plans.saveCanaryPreview(plan.id, plan.revision, 'contact', id, preview.runId);
    const current = (await h.sf.read('contact', id))!;
    await h.sf.upsert({ ...current, fields: { ...current.fields, title: 'Manager' } }, id);
    h.sf.setModifiedAt('contact', id, OLD);
    const outcome = await h.service.executeCanary(plan.id, preview.runId);
    expect(outcome.verification?.passed).toBe(false);
    expect(outcome.verification?.reasons.join(' ')).toMatch(/changed after review/);
    expect(h.hs.writes).toHaveLength(0);
  });
});

describe('R04 read-back normalization rules', () => {
  it('compares blanks, whitespace, numbers, booleans and instants as documented', () => {
    expect(valuesMatch(null, '')).toBe(true);
    expect(valuesMatch(undefined, null)).toBe(true);
    expect(valuesMatch('Ada ', 'Ada')).toBe(true);
    expect(valuesMatch(5, '5.0')).toBe(true);
    expect(valuesMatch(true, 'true')).toBe(true);
    expect(valuesMatch('2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(valuesMatch('Ada', 'ada')).toBe(false);
    expect(valuesMatch('', 'x')).toBe(false);
    expect(valuesMatch(5, 6)).toBe(false);
  });
});
