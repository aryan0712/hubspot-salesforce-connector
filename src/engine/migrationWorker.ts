import os from 'node:os';
import crypto from 'node:crypto';
import type { CRMConnector } from '../core/connector.js';
import { ConditionalWriteRejectedError } from '../core/connector.js';
import type { SystemId } from '../core/types.js';
import { CircuitOpenError } from '../core/httpPolicy.js';
import { logger } from '../logger.js';
import type { ActivityLog } from '../observability/activity.js';
import { friendlyErrorMessage } from '../core/vendorError.js';
import type {
  ExecutionCounts,
  ExecutionItem,
  ExecutionStore,
  MigrationExecution,
} from './executionStore.js';
import type { MigrationEngine, MigrationReport } from './migrationEngine.js';
import type { Reconciler } from './reconciler.js';
import { IdentityLockTimeoutError, isUncertainOutcome, UncertainWriteError } from './writeIntents.js';

export interface MigrationWorkerOptions {
  workerId?: string;
  /** Items leased per claim. */
  batchSize?: number;
  /** How long a lease lasts without a heartbeat before another worker may take the item. */
  leaseMs?: number;
  pollMs?: number;
  /** Persist progress counts at most this often (bounded write load). */
  progressEveryMs?: number;
}

/**
 * R08 -- the dedicated migration worker. HTTP only claims and enqueues an execution; this
 * worker drives it:
 *
 *  - leases queued items (FOR UPDATE SKIP LOCKED in PostgreSQL) in bounded batches, so a run
 *    of any size streams through without being held in memory;
 *  - verifies each item against its frozen plan immediately before writing and executes it
 *    under a deterministic operation id: a write that already happened (worker crash, lost
 *    HTTP connection, redeploy) is recognised from its write intent and never repeated;
 *  - heartbeats the lease while an item runs; a stale worker cannot complete an item whose
 *    lease another worker took over (completion is fenced on the lease owner);
 *  - pauses the run on an uncertain outcome, on vendor unavailability, or when failures
 *    exceed the run's threshold; honours pause/cancel between items; and settles the run as
 *    succeeded, partial, failed or cancelled once nothing is queued or running.
 */
export class MigrationWorker {
  readonly workerId: string;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private busy?: Promise<void>;
  private lastProgress = new Map<string, number>();

  constructor(
    private readonly deps: {
      executions: ExecutionStore;
      engine: MigrationEngine;
      reconciler: Reconciler;
      connectors: Record<SystemId, CRMConnector>;
      activity?: ActivityLog;
    },
    private readonly opts: MigrationWorkerOptions = {},
  ) {
    this.workerId = opts.workerId ?? `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 6)}`;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops claiming new items and waits for the current batch to settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.busy;
  }

  /** Wakes the loop now (e.g. right after an execution was enqueued). */
  kick(): void {
    if (!this.stopped) this.schedule(0);
  }

  /** Drives executions until nothing is claimable (tests, CLI, and the synchronous API mode). */
  async runUntilIdle(executionId?: string): Promise<void> {
    while ((await this.runOnce(executionId)) > 0) {
      // keep draining
    }
    await this.finalizeFinished(executionId);
  }

  /** Claims and processes one batch; returns how many items were processed. */
  async runOnce(executionId?: string): Promise<number> {
    const leaseMs = this.opts.leaseMs ?? 5 * 60_000;
    const items = await this.deps.executions.claimItems(this.workerId, this.opts.batchSize ?? 20, leaseMs, executionId);
    const executions = new Map<string, MigrationExecution | undefined>();
    for (const item of items) {
      if (!executions.has(item.executionId)) {
        executions.set(item.executionId, await this.deps.executions.get(item.executionId));
      }
      const execution = executions.get(item.executionId);
      if (!execution) continue;
      let status: string | undefined;
      await this.withHeartbeat(item, leaseMs, async () => {
        status = await this.processItem(execution, item);
      });
      await this.afterItem(execution, status);
    }
    // Only a short batch means the queue may be drained; avoid counting on every batch.
    if (items.length < (this.opts.batchSize ?? 20)) await this.finalizeFinished(executionId);
    return items.length;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.busy = this.tick();
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    let processed = 0;
    try {
      processed = await this.runOnce();
    } catch (err) {
      logger.error({ err, workerId: this.workerId }, 'migration worker cycle failed');
    } finally {
      this.schedule(processed > 0 ? 0 : this.opts.pollMs ?? 1000);
    }
  }

  private async withHeartbeat(item: ExecutionItem, leaseMs: number, fn: () => Promise<void>): Promise<void> {
    const beat = setInterval(() => {
      void this.deps.executions
        .extendLease(item.executionId, item.position, this.workerId, leaseMs)
        .catch((err) => logger.warn({ err, item: item.position }, 'lease heartbeat failed'));
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    beat.unref?.();
    try {
      await fn();
    } finally {
      clearInterval(beat);
    }
  }

  /** Processes one item and returns the status it was completed with. */
  private async processItem(execution: MigrationExecution, item: ExecutionItem): Promise<string> {
    const plan = item.plan;
    let finalStatus = 'failed';
    const complete = async (result: Parameters<ExecutionStore['completeItem']>[3]) => {
      finalStatus = result.status;
      return this.deps.executions.completeItem(item.executionId, item.position, this.workerId, result);
    };

    if (!plan.writes?.length && !plan.link) {
      await complete({ status: 'skipped', targetId: plan.targetId });
      return finalStatus;
    }
    const operationId = `mig:${execution.previewRunId}:${plan.type}:${plan.sourceId}`;
    try {
      const prior = await this.deps.reconciler.priorAttempt(operationId);
      if (prior === 'committed') {
        await complete({ status: 'succeeded', wrote: Boolean(plan.writes?.length), targetId: plan.targetId });
        return finalStatus;
      }
      // A first attempt re-verifies inputs; a resumed one lets intent recovery decide.
      const record = prior === 'unresolved'
        ? await this.deps.connectors[plan.from].read(plan.type, plan.sourceId)
        : await this.deps.engine.verifyItem(plan);
      if (!record) throw new Error(`${plan.type} ${plan.sourceId} no longer exists`);
      const policy = this.deps.reconciler.migrationPolicy(execution.approval.conflict);
      const applied = await this.deps.reconciler.apply(plan, record, policy, { operationId });
      const recovered = applied.warnings.some((warning) => /earlier attempt/.test(warning));
      await complete({
        status: 'succeeded',
        wrote: Boolean(applied.writes?.length) || recovered,
        targetId: applied.targetId,
      });
    } catch (err) {
      const uncertain =
        err instanceof UncertainWriteError ||
        err instanceof CircuitOpenError ||
        err instanceof IdentityLockTimeoutError ||
        isUncertainOutcome(err);
      const message = err instanceof ConditionalWriteRejectedError
        ? 'destination changed after review'
        : friendlyErrorMessage(err, plan.to === 'salesforce' ? 'Salesforce' : 'HubSpot');
      await complete({ status: uncertain ? 'uncertain' : 'failed', error: message });
      if (uncertain) {
        // Uncertainty stops the run: nothing else is written until it is resolved.
        await this.deps.executions.transition(execution.id, ['running'], 'paused', `uncertain outcome: ${message}`);
        this.deps.activity?.record({ kind: 'error', message: `Migration paused: ${message}` });
      }
      logger.warn({ executionId: execution.id, position: item.position, err: message }, 'migration item did not complete');
    }
    return finalStatus;
  }

  /**
   * Bounded bookkeeping: counts are aggregated only when an item failed (threshold check)
   * or when the progress interval elapsed -- never per item on large runs.
   */
  private async afterItem(execution: MigrationExecution, status: string | undefined): Promise<void> {
    const now = Date.now();
    const last = this.lastProgress.get(execution.id) ?? 0;
    const progressDue = now - last >= (this.opts.progressEveryMs ?? 2000);
    if (!progressDue && status !== 'failed') return;
    const counts = await this.deps.executions.counts(execution.id);
    if (progressDue) {
      this.lastProgress.set(execution.id, now);
      await this.deps.executions.recordProgress(execution.id, counts);
    }
    const threshold = execution.failureThreshold;
    if (status === 'failed' && threshold !== undefined && counts.failed > threshold) {
      if (await this.deps.executions.transition(execution.id, ['running'], 'paused', `failure threshold reached (${counts.failed} failed)`)) {
        this.deps.activity?.record({ kind: 'error', message: `Migration paused after ${counts.failed} failed records` });
      }
    }
  }

  /** Settles executions that have nothing left queued or running. */
  private async finalizeFinished(executionId?: string): Promise<void> {
    const candidates = executionId
      ? [await this.deps.executions.get(executionId)].filter((execution): execution is MigrationExecution => Boolean(execution))
      : await this.deps.executions.active();
    for (const execution of candidates) {
      if (execution.status !== 'running' && execution.status !== 'cancelling') continue;
      const counts = await this.deps.executions.counts(execution.id);
      if (counts.queued > 0 || counts.running > 0) continue;
      await this.deps.executions.recordProgress(execution.id, counts);
      if (execution.status === 'running' && counts.uncertain > 0) {
        await this.deps.executions.transition(execution.id, ['running'], 'paused', 'uncertain outcomes need recovery');
        continue;
      }
      const status = execution.status === 'cancelling'
        ? 'cancelled'
        : counts.failed === 0 && counts.uncertain === 0
          ? 'succeeded'
          : counts.succeeded > 0
            ? 'partial'
            : 'failed';
      const report = summaryReport(execution, counts);
      if (execution.executionRunId) {
        if (status === 'failed') await this.deps.engine.store.fail(execution.executionRunId, `${counts.failed} records failed`);
        else await this.deps.engine.store.complete(execution.executionRunId, report);
      }
      const settled = await this.deps.executions.settle(execution.id, {
        status,
        charged: counts.written,
        executionRunId: execution.executionRunId,
        error: status === 'succeeded' ? undefined : `${counts.failed} failed, ${counts.cancelled} cancelled`,
      });
      if (settled) {
        this.deps.activity?.incMigrated(counts.written);
        this.deps.activity?.record({
          kind: 'migrate',
          message: `Migration ${execution.id.slice(0, 8)} ${status}: ${counts.succeeded} succeeded, ${counts.skipped} skipped, ${counts.failed} failed, ${counts.cancelled} cancelled`,
        });
      }
    }
  }
}

function summaryReport(execution: MigrationExecution, counts: ExecutionCounts): MigrationReport {
  return {
    runId: execution.executionRunId ?? execution.id,
    perType: Object.fromEntries(
      execution.approval.types.map((type) => [type, { read: 0, reconciled: 0, errors: 0, actions: {} }]),
    ),
    mode: 'execute',
    plans: [],
    startedAt: execution.createdAt,
    finishedAt: new Date().toISOString(),
    writes: counts.written,
    counts,
  } as MigrationReport;
}
