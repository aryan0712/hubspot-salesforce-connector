import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AxiosError } from 'axios';
import { createDefaultConfigContext } from '../src/core/configContext.js';
import type { MigrationPlan } from '../src/engine/migrationPlanStore.js';
import { startIsolatedPostgres, type IsolatedPostgres } from './helpers/postgres.js';
import { buildHarness, mockCrms, type Harness, type MockCrms } from './helpers/harness.js';

/**
 * R08 acceptance: executions are durable jobs. A worker killed mid-run is replaced without
 * repeating completed writes; a dropped HTTP connection does not abandon the run; pause,
 * resume and cancel keep accurate counts; uncertainty pauses; items are paged, not buffered.
 */
let pg: IsolatedPostgres;
beforeAll(async () => {
  pg = await startIsolatedPostgres();
}, 180_000);
afterAll(async () => {
  await pg?.stop();
}, 30_000);

async function processes(leaseMs = 60_000): Promise<{ crms: MockCrms; a: Harness; b: Harness }> {
  const tenantId = await pg.ensureTenant(`r08-${crypto.randomUUID().slice(0, 8)}`);
  const configA = createDefaultConfigContext('process-a');
  const crms = mockCrms(configA);
  const a = await buildHarness({ config: configA, crms, postgres: { db: pg.connect(), tenantId }, worker: { batchSize: 2, leaseMs } });
  const b = await buildHarness({
    config: createDefaultConfigContext('process-b'),
    crms,
    postgres: { db: pg.connect(), tenantId },
    worker: { batchSize: 2, leaseMs },
  });
  return { crms, a, b };
}

/** Seeds records, passes a one-record test, freezes a full preview. */
async function approvedPlan(h: Harness, crms: MockCrms, records: number): Promise<MigrationPlan> {
  const ids: string[] = [];
  for (let i = 0; i < records; i += 1) {
    ids.push(crms.sf.seed('contact', { firstName: `P${i}`, email: `p${i}-${crypto.randomUUID().slice(0, 6)}@example.com` }));
  }
  const plan = await h.plans.create({ name: 'R08', source: 'salesforce', types: ['contact'] });
  const canary = await h.service.previewRecords({ from: 'salesforce', type: 'contact', sourceIds: [ids[0]!] });
  await h.plans.saveCanaryPreview(plan.id, plan.revision, 'contact', ids[0]!, canary.runId);
  expect((await h.service.executeCanary(plan.id, canary.runId)).verification?.passed).toBe(true);
  const preview = await h.service.preview({ from: 'salesforce', types: ['contact'] });
  await h.plans.savePreview(plan.id, plan.revision, preview.runId);
  return (await h.plans.get(plan.id))!;
}

const creates = (crms: MockCrms) => crms.hs.writes.filter((write) => !write.targetId).length;

describe('R08 durable migration execution', () => {
  it('returns promptly and completes in the worker even if the HTTP caller disconnects', async () => {
    const { crms, a } = await processes();
    const plan = await approvedPlan(a, crms, 5);
    const writesBefore = crms.hs.writes.length;
    const started = await a.service.executePlan(plan.id); // no wait: like a request that returns 202
    expect(started.execution.status).toBe('running');
    expect(crms.hs.writes.length).toBe(writesBefore);
    await a.service.worker.runUntilIdle(started.execution.id);
    const done = await a.service.execution(started.execution.id);
    expect(done).toMatchObject({ status: 'succeeded', progress: { total: 5, succeeded: 4, skipped: 1, written: 4 } });
    expect((await crms.hs.list('contact')).records).toHaveLength(5);
  });

  it('a worker killed after partial execution is replaced without repeating completed writes', async () => {
    const { crms, a, b } = await processes(200);
    const plan = await approvedPlan(a, crms, 7);
    const { execution } = await a.service.executePlan(plan.id);
    await a.service.worker.runOnce(execution.id); // worker A completes one batch...
    // ...then claims another batch and "dies": its leases are never completed.
    const orphaned = await a.executions.claimItems('dead-worker', 2, 200, execution.id);
    expect(orphaned).toHaveLength(2);
    const writesAtCrash = creates(crms);
    await new Promise((resolve) => setTimeout(resolve, 250)); // leases expire
    await b.service.worker.runUntilIdle(execution.id);
    const done = await b.service.execution(execution.id);
    expect(done?.status).toBe('succeeded');
    expect((await crms.hs.list('contact')).records).toHaveLength(7);
    // 7 records: 1 written by the canary, 6 by the run -- each exactly once.
    expect(creates(crms)).toBe(7);
    expect(creates(crms)).toBeGreaterThan(writesAtCrash);
  });

  it('a write that happened just before the worker died is recognised, not repeated', async () => {
    const { crms, a, b } = await processes(200);
    const plan = await approvedPlan(a, crms, 3);
    const { execution } = await a.service.executePlan(plan.id);
    // Worker A writes the next item, then crashes before recording the item as complete.
    const complete = a.executions.completeItem.bind(a.executions);
    let completions = 0;
    a.executions.completeItem = async (...args) => {
      completions += 1;
      // Item 0 (the already-tested record) completes; item 1 is written, then the process dies.
      if (completions > 1) throw new Error('process killed');
      return complete(...args);
    };
    await a.service.worker.runOnce(execution.id).catch(() => undefined);
    a.executions.completeItem = complete;
    const createsAfterCrash = creates(crms);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await b.service.worker.runUntilIdle(execution.id);
    expect((await b.service.execution(execution.id))?.status).toBe('succeeded');
    expect((await crms.hs.list('contact')).records).toHaveLength(3);
    expect(creates(crms)).toBe(3);
    expect(createsAfterCrash).toBeGreaterThan(1);
  });

  it('pause and resume preserve counts', async () => {
    const { crms, a } = await processes();
    const plan = await approvedPlan(a, crms, 7);
    const { execution } = await a.service.executePlan(plan.id);
    await a.service.worker.runOnce(execution.id);
    expect(await a.service.pause(execution.id)).toBe(true);
    expect(await a.service.worker.runOnce(execution.id)).toBe(0); // paused: nothing claimed
    const paused = await a.service.execution(execution.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.progress.queued).toBe(5);
    expect(await a.service.resume(execution.id)).toBe(true);
    await a.service.worker.runUntilIdle(execution.id);
    expect(await a.service.execution(execution.id)).toMatchObject({
      status: 'succeeded',
      progress: { total: 7, succeeded: 6, skipped: 1, queued: 0 },
    });
  });

  it('cancel stops new work, keeps what was written, and settles as cancelled', async () => {
    const { crms, a } = await processes();
    const plan = await approvedPlan(a, crms, 7);
    const { execution } = await a.service.executePlan(plan.id);
    await a.service.worker.runOnce(execution.id);
    const written = creates(crms);
    expect(await a.service.cancel(execution.id)).toBe(true);
    const cancelled = await a.service.execution(execution.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.progress).toMatchObject({ total: 7, cancelled: 5 });
    expect(creates(crms)).toBe(written);
    expect((await a.plans.get(plan.id))?.activeExecutionId).toBeUndefined();
  });

  it('an uncertain outcome pauses the run; resuming recovers it without a duplicate', async () => {
    const { crms, a } = await processes();
    const plan = await approvedPlan(a, crms, 4);
    const { execution } = await a.service.executePlan(plan.id);
    const write = crms.hs.write.bind(crms.hs);
    let armed = true;
    crms.hs.write = async (...args) => {
      const result = await write(...args);
      if (armed) {
        armed = false;
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return result;
    };
    await a.service.worker.runUntilIdle(execution.id);
    const paused = await a.service.execution(execution.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.progress.uncertain).toBe(1);
    expect(await a.service.resume(execution.id)).toBe(true);
    await a.service.worker.runUntilIdle(execution.id);
    expect((await a.service.execution(execution.id))?.status).toBe('succeeded');
    expect((await crms.hs.list('contact')).records).toHaveLength(4);
  });

  it('pauses when failures exceed the threshold and reports partial success at the end', async () => {
    const { crms, a } = await processes();
    const plan = await approvedPlan(a, crms, 6);
    const { execution } = await a.service.executePlan(plan.id, { failureThreshold: 1 });
    crms.hs.write = async () => {
      const err = new AxiosError('Request failed with status code 400');
      err.response = { status: 400, statusText: 'Bad Request', headers: {}, config: {} as never, data: {} };
      throw err;
    };
    await a.service.worker.runUntilIdle(execution.id);
    const paused = await a.service.execution(execution.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.pauseReason).toMatch(/failure threshold/);
    expect(paused?.progress.failed).toBeGreaterThan(1);
    expect(await a.service.cancel(execution.id)).toBe(true);
    expect((await a.service.execution(execution.id))?.status).toBe('cancelled');
  });

  it('pages execution items by position instead of loading the whole run', async () => {
    const { crms, a } = await processes();
    const plan = await approvedPlan(a, crms, 5);
    const { execution } = await a.service.executePlan(plan.id, { wait: true });
    const first = await a.executions.items(execution.id, { limit: 2 });
    const second = await a.executions.items(execution.id, { after: first.at(-1)!.position, limit: 2 });
    const rest = await a.executions.items(execution.id, { after: second.at(-1)!.position, limit: 10 });
    expect([...first, ...second, ...rest].map((item) => item.position)).toEqual([0, 1, 2, 3, 4]);
    expect(await a.executions.items(execution.id, { status: 'skipped' })).toHaveLength(1);
  });
});
