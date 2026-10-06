import crypto from 'node:crypto';
import type { ApprovalContext } from './migrationEngine.js';
import type { ReconcilePlan } from './reconciler.js';
import type { InMemoryMigrationPlanStore, MigrationPlan } from './migrationPlanStore.js';

/**
 * R03 -- exclusive execution. Every CRM-writing execution of an approved preview is one
 * MigrationExecution. claim() is the single atomic gate: it verifies the plan is in an
 * eligible state, reserves quota, records the approval, and transitions the plan, all at
 * once. A preview can be claimed at most once, so concurrent submissions, double clicks,
 * request retries and post-completion repeats observe the existing execution.
 */
export type ExecutionKind = 'full' | 'canary' | 'batch' | 'direct';
export type ExecutionStatus =
  | 'running'
  /** No new items are claimed until resumed (operator request, uncertainty, or threshold). */
  | 'paused'
  /** Cancel requested: no new claims; in-flight items finish, then 'cancelled'. */
  | 'cancelling'
  | 'succeeded'
  /** Finished with some items failed and others written. */
  | 'partial'
  | 'failed'
  | 'cancelled';

/** Execution states that still hold the plan / reservation. */
export const ACTIVE_EXECUTION_STATUSES: ExecutionStatus[] = ['running', 'paused', 'cancelling'];

/** R08: one approved item of an execution, durably queued and leased to one worker. */
export type ExecutionItemStatus = 'queued' | 'running' | 'succeeded' | 'skipped' | 'failed' | 'uncertain' | 'cancelled';

export interface ExecutionItem {
  executionId: string;
  position: number;
  type: string;
  sourceId: string;
  plan: ReconcilePlan;
  status: ExecutionItemStatus;
  attempts: number;
  wrote: boolean;
  targetId?: string;
  error?: string;
  updatedAt: string;
}

export interface ExecutionCounts {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  skipped: number;
  failed: number;
  uncertain: number;
  cancelled: number;
  /** Items whose CRM write happened (what quota is charged for). */
  written: number;
}

export interface ItemResult {
  status: Exclude<ExecutionItemStatus, 'queued' | 'running'>;
  wrote?: boolean;
  targetId?: string;
  error?: string;
}

/** Reads a preview's frozen items page by page (never all at once). */
export type PlanPageLoader = (offset: number, limit: number) => Promise<ReconcilePlan[]>;

export interface MigrationExecution {
  id: string;
  kind: ExecutionKind;
  status: ExecutionStatus;
  previewRunId: string;
  executionRunId?: string;
  planId?: string;
  planRevision?: number;
  idempotencyKey?: string;
  actorId?: string;
  approval: ApprovalContext;
  /** Immutable copy of what was approved (plan draft fields), kept apart from later edits. */
  snapshot: Record<string, unknown>;
  approvedAt: string;
  pauseReason?: string;
  failureThreshold?: number;
  itemCount?: number;
  counts?: Partial<ExecutionCounts>;
  quotaMetric?: string;
  quotaReserved: number;
  quotaCharged?: number;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface ExecutionClaimInput {
  kind: ExecutionKind;
  previewRunId: string;
  planId?: string;
  planRevision?: number;
  idempotencyKey?: string;
  actorId?: string;
  approval: ApprovalContext;
  snapshot?: Record<string, unknown>;
  quota?: { metric: string; requested: number };
}

export type ClaimOutcome =
  | { status: 'claimed'; execution: MigrationExecution }
  /** Already claimed: `sameRequest` when the caller's idempotency key matches it. */
  | { status: 'existing'; execution: MigrationExecution; sameRequest: boolean }
  | {
      status: 'rejected';
      reason: 'plan_not_found' | 'plan_state' | 'quota_exceeded';
      detail?: Record<string, unknown>;
    };

export interface ExecutionSettlement {
  status: Exclude<ExecutionStatus, 'running'>;
  /** Records actually migrated (charged against quota); unused reservation is released. */
  charged: number;
  executionRunId?: string;
  error?: string;
}

export interface ExecutionStore {
  claim(input: ExecutionClaimInput): Promise<ClaimOutcome>;
  attachRun(id: string, executionRunId: string): Promise<void>;
  /** Fenced: only an active execution settles, and only the plan it holds is updated. */
  settle(id: string, settlement: ExecutionSettlement): Promise<boolean>;
  get(id: string): Promise<MigrationExecution | undefined>;
  byPreview(previewRunId: string): Promise<MigrationExecution | undefined>;
  list(limit?: number): Promise<MigrationExecution[]>;

  // ---- R08 durable item queue
  /** Copies the preview's frozen items into this execution's queue; returns the count. */
  enqueueItems(executionId: string, previewRunId: string, loadPage: PlanPageLoader, failureThreshold?: number): Promise<number>;
  /** Leases up to `limit` queued (or lease-expired) items of running executions. */
  claimItems(workerId: string, limit: number, leaseMs: number, executionId?: string): Promise<ExecutionItem[]>;
  /** Fenced on the lease owner: a stale worker cannot complete another worker's item. */
  completeItem(executionId: string, position: number, workerId: string, result: ItemResult): Promise<boolean>;
  extendLease(executionId: string, position: number, workerId: string, leaseMs: number): Promise<boolean>;
  counts(executionId: string): Promise<ExecutionCounts>;
  /** Keyset-paginated items (by position), optionally filtered by status. */
  items(executionId: string, opts?: { after?: number; limit?: number; status?: ExecutionItemStatus }): Promise<ExecutionItem[]>;
  /** Conditional status change (e.g. running → paused); false when not in an allowed state. */
  transition(id: string, from: ExecutionStatus[], to: ExecutionStatus, reason?: string): Promise<boolean>;
  cancelQueued(executionId: string): Promise<number>;
  /** Puts eligible items (e.g. failed/uncertain) back in the queue for a safe retry. */
  requeue(executionId: string, statuses: ExecutionItemStatus[]): Promise<number>;
  recordProgress(executionId: string, counts: ExecutionCounts): Promise<void>;
  /** Executions a worker should drive (running or cancelling). */
  active(): Promise<MigrationExecution[]>;
}

export function emptyCounts(): ExecutionCounts {
  return { total: 0, queued: 0, running: 0, succeeded: 0, skipped: 0, failed: 0, uncertain: 0, cancelled: 0, written: 0 };
}

/** Why a plan cannot start this kind of execution right now (undefined when eligible). */
export function planIneligibility(
  plan: MigrationPlan,
  input: Pick<ExecutionClaimInput, 'kind' | 'previewRunId' | 'planRevision'>,
): string | undefined {
  if (plan.status === 'executing' || plan.activeExecutionId) return 'plan is already executing';
  if (input.planRevision !== plan.revision) return 'plan changed after review';
  if (input.kind === 'full') {
    if (plan.status !== 'previewed') return `plan is ${plan.status}, not previewed`;
    if (plan.previewRunId !== input.previewRunId || plan.previewRevision !== plan.revision) {
      return 'this preview is not the plan\'s current approved preview';
    }
    if (!plan.canary?.verifiedAt || plan.canary.previewRevision !== plan.revision) {
      return 'a verified test for this revision is required';
    }
    return undefined;
  }
  if (!plan.canary || plan.canary.previewRunId !== input.previewRunId || plan.canary.previewRevision !== plan.revision) {
    return 'this preview is not the plan\'s current test preview';
  }
  if (plan.canary.executionRunId) return 'this test preview was already executed';
  return undefined;
}

export class InMemoryExecutionStore implements ExecutionStore {
  private executions = new Map<string, MigrationExecution>();
  private usage = new Map<string, number>();

  constructor(
    private readonly plans?: InMemoryMigrationPlanStore,
    private readonly limits: Record<string, number> = {},
  ) {}

  /** The body never awaits, so two concurrent claims cannot interleave. */
  async claim(input: ExecutionClaimInput): Promise<ClaimOutcome> {
    const byKey = input.idempotencyKey
      ? [...this.executions.values()].find((execution) => execution.idempotencyKey === input.idempotencyKey)
      : undefined;
    if (byKey) return { status: 'existing', execution: structuredClone(byKey), sameRequest: true };
    const byPreview = [...this.executions.values()].find((execution) => execution.previewRunId === input.previewRunId);
    if (byPreview) return { status: 'existing', execution: structuredClone(byPreview), sameRequest: false };
    if (input.planId) {
      const live = this.plans?.peek(input.planId);
      if (!live) return { status: 'rejected', reason: 'plan_not_found' };
      const why = planIneligibility(live, input);
      if (why) return { status: 'rejected', reason: 'plan_state', detail: { message: why } };
    }
    if (input.quota) {
      const limit = this.limits[input.quota.metric];
      const reserved = [...this.executions.values()]
        .filter((execution) => ACTIVE_EXECUTION_STATUSES.includes(execution.status) && execution.quotaMetric === input.quota!.metric)
        .reduce((sum, execution) => sum + execution.quotaReserved, 0);
      const used = this.usage.get(input.quota.metric) ?? 0;
      if (limit !== undefined && used + reserved + input.quota.requested > limit) {
        return {
          status: 'rejected',
          reason: 'quota_exceeded',
          detail: { used, reserved, requested: input.quota.requested, limit },
        };
      }
    }
    const now = new Date().toISOString();
    const execution: MigrationExecution = {
      id: crypto.randomUUID(),
      kind: input.kind,
      status: 'running',
      previewRunId: input.previewRunId,
      planId: input.planId,
      planRevision: input.planRevision,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
      approval: structuredClone(input.approval),
      snapshot: structuredClone(input.snapshot ?? {}),
      approvedAt: now,
      quotaMetric: input.quota?.metric,
      quotaReserved: input.quota?.requested ?? 0,
      createdAt: now,
    };
    this.executions.set(execution.id, execution);
    if (input.planId) this.plans?.holdForExecution(input.planId, execution.id, input.kind === 'full');
    return { status: 'claimed', execution: structuredClone(execution) };
  }

  async attachRun(id: string, executionRunId: string): Promise<void> {
    const execution = this.executions.get(id);
    if (execution) execution.executionRunId = executionRunId;
  }

  async settle(id: string, settlement: ExecutionSettlement): Promise<boolean> {
    const execution = this.executions.get(id);
    if (!execution || !ACTIVE_EXECUTION_STATUSES.includes(execution.status)) return false;
    execution.status = settlement.status;
    execution.quotaCharged = settlement.charged;
    execution.error = settlement.error;
    execution.executionRunId = settlement.executionRunId ?? execution.executionRunId;
    execution.finishedAt = new Date().toISOString();
    if (execution.quotaMetric) {
      this.usage.set(execution.quotaMetric, (this.usage.get(execution.quotaMetric) ?? 0) + settlement.charged);
    }
    if (execution.planId) {
      this.plans?.releaseExecution(
        execution.planId,
        execution.id,
        execution.kind === 'full' ? (settlement.status === 'succeeded' ? 'completed' : 'failed') : undefined,
        execution.executionRunId,
      );
    }
    return true;
  }

  async get(id: string): Promise<MigrationExecution | undefined> {
    const execution = this.executions.get(id);
    return execution ? structuredClone(execution) : undefined;
  }

  async byPreview(previewRunId: string): Promise<MigrationExecution | undefined> {
    const execution = [...this.executions.values()].find((item) => item.previewRunId === previewRunId);
    return execution ? structuredClone(execution) : undefined;
  }

  async list(limit = 50): Promise<MigrationExecution[]> {
    return [...this.executions.values()].slice(-limit).reverse().map((execution) => structuredClone(execution));
  }

  private queue = new Map<string, ExecutionItem[]>();
  private leases = new Map<string, { owner: string; expiresAt: number }>();
  /** First position that may still be queued (keeps claims linear on large runs). */
  private cursor = new Map<string, number>();

  async enqueueItems(executionId: string, _previewRunId: string, loadPage: PlanPageLoader, failureThreshold?: number): Promise<number> {
    const items: ExecutionItem[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await loadPage(offset, 500);
      for (const plan of page) {
        items.push({
          executionId,
          position: items.length,
          type: plan.type,
          sourceId: plan.sourceId,
          plan: structuredClone(plan),
          status: 'queued',
          attempts: 0,
          wrote: false,
          updatedAt: new Date().toISOString(),
        });
      }
      if (page.length < 500) break;
    }
    this.queue.set(executionId, items);
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.itemCount = items.length;
      execution.failureThreshold = failureThreshold;
    }
    return items.length;
  }

  async claimItems(workerId: string, limit: number, leaseMs: number, executionId?: string): Promise<ExecutionItem[]> {
    const now = Date.now();
    const claimed: ExecutionItem[] = [];
    for (const [id, items] of this.queue) {
      if (executionId && id !== executionId) continue;
      if (this.executions.get(id)?.status !== 'running') continue;
      // Queued items are handed out in position order from a cursor; expired leases are
      // picked up by a full scan only when nothing queued is left.
      let start = this.cursor.get(id) ?? 0;
      while (start < items.length && items[start]!.status !== 'queued') start += 1;
      this.cursor.set(id, start);
      const scan = start < items.length ? items.slice(start) : items;
      for (const item of scan) {
        if (claimed.length >= limit) break;
        const lease = this.leases.get(`${id}:${item.position}`);
        const expired = item.status === 'running' && (!lease || lease.expiresAt < now);
        if (item.status !== 'queued' && !expired) continue;
        item.status = 'running';
        item.attempts += 1;
        item.updatedAt = new Date().toISOString();
        this.leases.set(`${id}:${item.position}`, { owner: workerId, expiresAt: now + leaseMs });
        claimed.push(structuredClone(item));
      }
    }
    return claimed;
  }

  async completeItem(executionId: string, position: number, workerId: string, result: ItemResult): Promise<boolean> {
    const item = this.queue.get(executionId)?.[position];
    const lease = this.leases.get(`${executionId}:${position}`);
    if (!item || item.status !== 'running' || lease?.owner !== workerId) return false;
    item.status = result.status;
    item.wrote = Boolean(result.wrote);
    item.targetId = result.targetId ?? item.targetId;
    item.error = result.error;
    item.updatedAt = new Date().toISOString();
    this.leases.delete(`${executionId}:${position}`);
    return true;
  }

  async extendLease(executionId: string, position: number, workerId: string, leaseMs: number): Promise<boolean> {
    const lease = this.leases.get(`${executionId}:${position}`);
    if (lease?.owner !== workerId) return false;
    lease.expiresAt = Date.now() + leaseMs;
    return true;
  }

  async counts(executionId: string): Promise<ExecutionCounts> {
    const counts = emptyCounts();
    for (const item of this.queue.get(executionId) ?? []) {
      counts.total += 1;
      counts[item.status] += 1;
      if (item.wrote) counts.written += 1;
    }
    return counts;
  }

  async items(
    executionId: string,
    opts: { after?: number; limit?: number; status?: ExecutionItemStatus } = {},
  ): Promise<ExecutionItem[]> {
    return (this.queue.get(executionId) ?? [])
      .filter((item) => item.position > (opts.after ?? -1) && (!opts.status || item.status === opts.status))
      .slice(0, opts.limit ?? 100)
      .map((item) => structuredClone(item));
  }

  async transition(id: string, from: ExecutionStatus[], to: ExecutionStatus, reason?: string): Promise<boolean> {
    const execution = this.executions.get(id);
    if (!execution || !from.includes(execution.status)) return false;
    execution.status = to;
    execution.pauseReason = to === 'paused' ? reason : undefined;
    return true;
  }

  async cancelQueued(executionId: string): Promise<number> {
    let count = 0;
    for (const item of this.queue.get(executionId) ?? []) {
      if (item.status !== 'queued') continue;
      item.status = 'cancelled';
      count += 1;
    }
    return count;
  }

  async requeue(executionId: string, statuses: ExecutionItemStatus[]): Promise<number> {
    let count = 0;
    for (const item of this.queue.get(executionId) ?? []) {
      if (!statuses.includes(item.status)) continue;
      item.status = 'queued';
      item.error = undefined;
      count += 1;
    }
    this.cursor.set(executionId, 0);
    return count;
  }

  async recordProgress(executionId: string, counts: ExecutionCounts): Promise<void> {
    const execution = this.executions.get(executionId);
    if (execution) execution.counts = { ...counts };
  }

  async active(): Promise<MigrationExecution[]> {
    return [...this.executions.values()]
      .filter((execution) => execution.status === 'running' || execution.status === 'cancelling')
      .map((execution) => structuredClone(execution));
  }

  /** Test/demo helper: usage charged so far for a metric. */
  charged(metric: string): number {
    return this.usage.get(metric) ?? 0;
  }
}
