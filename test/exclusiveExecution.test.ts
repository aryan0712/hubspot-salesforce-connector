import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDefaultConfigContext } from '../src/core/configContext.js';
import { ExecutionRefusedError } from '../src/engine/migrationService.js';
import { PlanStateError, type MigrationPlan } from '../src/engine/migrationPlanStore.js';
import type { PostgresDatabase } from '../src/db/postgres.js';
import { startIsolatedPostgres, type IsolatedPostgres } from './helpers/postgres.js';
import { buildHarness, mockCrms, type Harness, type MockCrms } from './helpers/harness.js';

/**
 * R03 acceptance: two independent PostgreSQL clients (separate pools, modelling two app
 * processes against one CRM pair) submitting the same plan create exactly one execution
 * and one set of writes; double clicks, retries and repeats can neither rerun a plan nor
 * charge twice.
 */
let pg: IsolatedPostgres;
beforeAll(async () => {
  pg = await startIsolatedPostgres();
}, 180_000);
afterAll(async () => {
  await pg?.stop();
}, 30_000);

interface Processes {
  crms: MockCrms;
  a: Harness;
  b: Harness;
  tenantId: string;
  dbA: PostgresDatabase;
}

async function twoProcesses(): Promise<Processes> {
  const tenantId = await pg.ensureTenant(`r03-${crypto.randomUUID().slice(0, 8)}`);
  const configA = createDefaultConfigContext('process-a');
  const configB = createDefaultConfigContext('process-b');
  const crms = mockCrms(configA);
  const dbA = pg.connect();
  const dbB = pg.connect();
  const a = await buildHarness({ config: configA, crms, postgres: { db: dbA, tenantId } });
  const b = await buildHarness({ config: configB, crms, postgres: { db: dbB, tenantId } });
  return { crms, a, b, tenantId, dbA };
}

/** Seeds records, passes a one-record test, and freezes a full preview. */
async function approvedPlan(h: Harness, crms: MockCrms, records = 3): Promise<MigrationPlan> {
  const ids: string[] = [];
  for (let i = 0; i < records; i += 1) {
    ids.push(crms.sf.seed('contact', { firstName: `Person ${i}`, email: `person${i}-${crypto.randomUUID().slice(0, 6)}@example.com` }));
  }
  const plan = await h.plans.create({ name: 'R03 plan', source: 'salesforce', types: ['contact'] });
  const canary = await h.service.previewRecords({ from: 'salesforce', type: 'contact', sourceIds: [ids[0]!] });
  expect(await h.plans.saveCanaryPreview(plan.id, plan.revision, 'contact', ids[0]!, canary.runId)).toBe(true);
  const tested = await h.service.executeCanary(plan.id, canary.runId);
  expect(tested.verification?.passed).toBe(true);
  const preview = await h.service.preview({ from: 'salesforce', types: ['contact'] });
  expect(await h.plans.savePreview(plan.id, plan.revision, preview.runId)).toBe(true);
  return (await h.plans.get(plan.id))!;
}

async function executionCount(db: PostgresDatabase, tenantId: string, previewRunId: string): Promise<number> {
  const result = await db.tenant(tenantId, (client) =>
    client.query('SELECT 1 FROM migration_executions WHERE tenant_id = $1 AND preview_run_id = $2', [tenantId, previewRunId]),
  );
  return result.rowCount ?? 0;
}

async function usage(db: PostgresDatabase, tenantId: string): Promise<number> {
  const result = await db.tenant(tenantId, (client) =>
    client.query<{ quantity: string }>(
      `SELECT quantity::text FROM usage_counters WHERE tenant_id = $1 AND metric = 'records_migrated'`,
      [tenantId],
    ),
  );
  return Number(result.rows[0]?.quantity ?? 0);
}

describe('R03 exclusive execution across processes', () => {
  it('two independent clients submitting the same plan create one execution and one set of writes', async () => {
    const { crms, a, b, tenantId, dbA } = await twoProcesses();
    const plan = await approvedPlan(a, crms);
    const writesBefore = crms.hs.writes.length;

    const results = await Promise.allSettled([a.service.executePlan(plan.id, { wait: true }), b.service.executePlan(plan.id, { wait: true })]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ExecutionRefusedError);
    expect(['execution_exists', 'plan_state']).toContain((rejected[0]!.reason as ExecutionRefusedError).code);
    expect(await executionCount(dbA, tenantId, plan.previewRunId!)).toBe(1);
    // The canary already wrote record 0; the full run writes the other two exactly once.
    expect(crms.hs.writes.length - writesBefore).toBe(2);
    expect((await crms.hs.list('contact')).records).toHaveLength(3);
    expect((await a.plans.get(plan.id))?.status).toBe('completed');
  });

  it('a double click in one process runs once', async () => {
    const { crms, a } = await twoProcesses();
    const plan = await approvedPlan(a, crms, 2);
    const writesBefore = crms.hs.writes.length;
    const results = await Promise.allSettled([a.service.executePlan(plan.id, { wait: true }), a.service.executePlan(plan.id, { wait: true })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(crms.hs.writes.length - writesBefore).toBe(1);
  });

  it('a retried request with the same idempotency key returns the same execution without writing or charging again', async () => {
    const { crms, a, b, tenantId, dbA } = await twoProcesses();
    const plan = await approvedPlan(a, crms);
    const first = await a.service.executePlan(plan.id, { idempotencyKey: 'click-1', wait: true });
    const writes = crms.hs.writes.length;
    const charged = await usage(dbA, tenantId);
    const retry = await b.service.executePlan(plan.id, { idempotencyKey: 'click-1', wait: true });
    expect(retry.replayed).toBe(true);
    expect(retry.execution.id).toBe(first.execution.id);
    expect(crms.hs.writes.length).toBe(writes);
    expect(await usage(dbA, tenantId)).toBe(charged);
  });

  it('repeating a completed plan without a new preview is refused', async () => {
    const { crms, a } = await twoProcesses();
    const plan = await approvedPlan(a, crms, 2);
    await a.service.executePlan(plan.id, { wait: true });
    const writes = crms.hs.writes.length;
    await expect(a.service.executePlan(plan.id, { wait: true })).rejects.toBeInstanceOf(ExecutionRefusedError);
    expect(crms.hs.writes.length).toBe(writes);
  });

  it('refuses edits to an executing plan', async () => {
    const { crms, a, b } = await twoProcesses();
    const plan = await approvedPlan(a, crms, 2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = crms.hs.write.bind(crms.hs);
    crms.hs.write = async (...args) => {
      await gate;
      return write(...args);
    };
    const running = a.service.executePlan(plan.id, { wait: true });
    for (let i = 0; i < 200 && (await b.plans.get(plan.id))?.status !== 'executing'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await b.plans.get(plan.id))?.status).toBe('executing');
    await expect(
      b.plans.update(plan.id, { name: 'edited', source: 'salesforce', types: ['contact', 'company'] }),
    ).rejects.toBeInstanceOf(PlanStateError);
    release();
    await running;
    expect((await b.plans.get(plan.id))?.status).toBe('completed');
  });

  it('a stale approval (plan edited after preview) cannot execute', async () => {
    const { crms, a } = await twoProcesses();
    const plan = await approvedPlan(a, crms, 2);
    await a.plans.update(plan.id, { name: 'edited', source: 'salesforce', types: ['contact'] });
    await expect(a.service.executePlan(plan.id, { wait: true })).rejects.toMatchObject({ code: 'plan_state' });
  });

  it('reserves quota atomically with the claim, so concurrent executions cannot overspend', async () => {
    const { crms, a, b, tenantId, dbA } = await twoProcesses();
    await dbA.tenant(tenantId, (client) =>
      client.query(
        `INSERT INTO subscriptions(tenant_id, plan, status, limits)
         VALUES ($1, 'pilot', 'active', '{"records_migrated": 3}'::jsonb)`,
        [tenantId],
      ),
    );
    const seed = () => crms.sf.seed('contact', { email: `q-${crypto.randomUUID().slice(0, 8)}@example.com` });
    // Two independent 2-record previews: each fits the limit of 3 alone, both together do not.
    const previewA = await a.service.previewRecords({ from: 'salesforce', type: 'contact', sourceIds: [seed(), seed()] });
    const previewB = await b.service.previewRecords({ from: 'salesforce', type: 'contact', sourceIds: [seed(), seed()] });
    const results = await Promise.allSettled([
      a.service.executeDirect(previewA.runId, { wait: true }),
      b.service.executeDirect(previewB.runId, { wait: true }),
    ]);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'quota_exceeded' });
    expect(crms.hs.writes).toHaveLength(2);
    // Settlement charged exactly what was written; the reservation did not linger.
    expect(await usage(dbA, tenantId)).toBe(2);
    const oneMore = await b.service.previewRecords({ from: 'salesforce', type: 'contact', sourceIds: [seed()] });
    await b.service.executeDirect(oneMore.runId, { wait: true });
    expect(await usage(dbA, tenantId)).toBe(3);
  });

  it('two processes racing a canary execute it once', async () => {
    const { crms, a, b } = await twoProcesses();
    const sourceId = crms.sf.seed('contact', { email: `canary-${crypto.randomUUID().slice(0, 6)}@example.com` });
    const plan = await a.plans.create({ name: 'canary race', source: 'salesforce', types: ['contact'] });
    const canary = await a.service.previewRecords({ from: 'salesforce', type: 'contact', sourceIds: [sourceId] });
    await a.plans.saveCanaryPreview(plan.id, plan.revision, 'contact', sourceId, canary.runId);
    const results = await Promise.allSettled([
      a.service.executeCanary(plan.id, canary.runId),
      b.service.executeCanary(plan.id, canary.runId),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(crms.hs.writes).toHaveLength(1);
  });

  it('a partially failed execution charges only what was written and releases the plan', async () => {
    const { crms, a, tenantId, dbA } = await twoProcesses();
    const plan = await approvedPlan(a, crms, 3);
    const charged = await usage(dbA, tenantId);
    const write = crms.hs.write.bind(crms.hs);
    let calls = 0;
    crms.hs.write = async (...args) => {
      calls += 1;
      if (calls === 2) {
        const { AxiosError } = await import('axios');
        const err = new AxiosError('Request failed with status code 400');
        err.response = { status: 400, statusText: 'Bad Request', headers: {}, config: {} as never, data: { message: 'INVALID_EMAIL' } };
        throw err;
      }
      return write(...args);
    };
    const outcome = await a.service.executePlan(plan.id, { wait: true });
    expect(outcome.execution.status).toBe('partial');
    expect(outcome.counts).toMatchObject({ succeeded: 1, failed: 1, skipped: 1, written: 1 });
    expect(await usage(dbA, tenantId)).toBe(charged + 1);
    const after = await a.plans.get(plan.id);
    expect(after?.status).toBe('failed');
    expect(after?.activeExecutionId).toBeUndefined();
  });
});
