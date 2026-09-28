import type { CRMConnector } from '../core/connector.js';
import type { CanonicalType, FieldValue, SystemId } from '../core/types.js';
import type { ConfigContext } from '../core/configContext.js';
import { stableJson } from '../core/configContext.js';
import {
  ApprovalInvalidatedError,
  PreviewDriftError,
  type ApprovalContext,
  type MigrationEngine,
  type MigrationReport,
} from './migrationEngine.js';
import type { PreflightReport, PreflightService } from './preflight.js';
import type { ReconcilePlan } from './reconciler.js';
import type {
  ExecutionKind,
  ExecutionStore,
  MigrationExecution,
} from './executionStore.js';
import type {
  CanaryItemEvidence,
  CanaryVerification,
  MigrationPlan,
  MigrationPlanStore,
} from './migrationPlanStore.js';
import type { IdMapStore } from '../core/idMap.js';
import { logger } from '../logger.js';
import type { Reconciler } from './reconciler.js';
import type { ActivityLog } from '../observability/activity.js';
import { MigrationWorker, type MigrationWorkerOptions } from './migrationWorker.js';
import type { ExecutionCounts } from './executionStore.js';

/** Preflight blocked a preview or execution; the checks explain why. */
export class PreflightFailedError extends Error {
  constructor(readonly checks: PreflightReport[]) {
    super('preflight failed');
    this.name = 'PreflightFailedError';
  }
}

/** An execution request was refused by the atomic claim (R03). */
export class ExecutionRefusedError extends Error {
  constructor(
    readonly code: 'plan_not_found' | 'plan_state' | 'quota_exceeded' | 'execution_exists',
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ExecutionRefusedError';
  }
}

export interface ServicePreviewInput {
  from: SystemId;
  types: CanonicalType[];
  limitPerType?: number;
  createdBy?: string;
  runOptions?: Record<string, unknown>;
}

export interface ExecuteRequest {
  actorId?: string;
  /** Client-supplied key: a retried request returns the same execution. */
  idempotencyKey?: string;
  /**
   * Durable executions return as soon as they are enqueued; `wait: true` drives the worker
   * until this execution is idle before returning (CLI, tests).
   */
  wait?: boolean;
  /** Failed items tolerated before the run pauses for an operator (default 5%, min 10). */
  failureThreshold?: number;
}

export interface ExecutionOutcome {
  execution: MigrationExecution;
  /** Durable execution progress (R08). */
  counts?: ExecutionCounts;
  /** Present when this request performed the execution; absent for a returned duplicate. */
  report?: MigrationReport;
  /** True when an earlier request with the same idempotency key already produced it. */
  replayed: boolean;
  verification?: CanaryVerification;
}

export const RECORDS_MIGRATED = 'records_migrated';

/**
 * The single approved-plan path for CRM writes. Every confirmed migration -- the API,
 * the migration workspace, canaries and the CLI -- previews through here (preflight +
 * frozen plan bound to schema hashes) and executes an approved preview through here,
 * behind one atomic execution claim. There is no route that writes without a reviewed,
 * still-valid preview, and no preview that can be executed twice.
 */
export class MigrationService {
  /** Drives durable executions (R08); start() it in the worker process. */
  readonly worker: MigrationWorker;

  constructor(
    readonly engine: MigrationEngine,
    private readonly preflight: PreflightService,
    private readonly executions: ExecutionStore,
    private readonly plans: MigrationPlanStore,
    private readonly deps: {
      connectors: Record<SystemId, CRMConnector>;
      config: ConfigContext;
      idMap: IdMapStore;
      reconciler: Reconciler;
      activity?: ActivityLog;
      worker?: MigrationWorkerOptions;
    },
  ) {
    this.worker = new MigrationWorker(
      { executions, engine, reconciler: deps.reconciler, connectors: deps.connectors, activity: deps.activity },
      deps.worker,
    );
  }

  async checks(from: SystemId, types: CanonicalType[]): Promise<{ checks: PreflightReport[]; schemaHashes: Record<string, string> }> {
    const checks = await Promise.all([...new Set(types)].map((type) => this.preflight.run(from, type)));
    return { checks, schemaHashes: schemaHashesFromChecks(checks) };
  }

  async preview(input: ServicePreviewInput): Promise<MigrationReport & { checks: PreflightReport[] }> {
    const { checks, schemaHashes } = await this.checks(input.from, input.types);
    if (checks.some((check) => !check.ok)) throw new PreflightFailedError(checks);
    const report = await this.engine.preview({ ...input, schemaHashes });
    return { ...report, checks };
  }

  async previewRecords(input: {
    from: SystemId;
    type: CanonicalType;
    sourceIds: string[];
    createdBy?: string;
    runOptions?: Record<string, unknown>;
    /** Validate every object in the plan scope, not just the canary's own object. */
    scopeTypes?: CanonicalType[];
  }): Promise<MigrationReport & { checks: PreflightReport[] }> {
    const { checks, schemaHashes } = await this.checks(input.from, input.scopeTypes ?? [input.type]);
    if (checks.some((check) => !check.ok)) throw new PreflightFailedError(checks);
    const report = await this.engine.previewRecords({ ...input, schemaHashes });
    return { ...report, checks };
  }

  /** Loads a preview's approval context, or throws when the run cannot be executed. */
  async approvalFor(previewRunId: string): Promise<ApprovalContext> {
    const run = await this.engine.store.get(previewRunId);
    if (!run || run.mode !== 'preview') throw new ApprovalInvalidatedError('state', 'preview run not found');
    const approval = run.options.approval as ApprovalContext | undefined;
    if (!approval) throw new ApprovalInvalidatedError('format', 'preview predates exact approved plans; preview again');
    return approval;
  }

  /**
   * Re-validates the schema, configuration, conflict policy and accounts a preview was
   * approved against. Item-level drift is checked by the engine during execution.
   */
  async assertExecutable(previewRunId: string): Promise<ApprovalContext> {
    const approval = await this.approvalFor(previewRunId);
    // A test preview validates the whole plan scope, so re-check every object it hashed.
    const scope = [
      ...new Set([
        ...approval.types,
        ...Object.keys(approval.schemaHashes ?? {}).map((key) => key.slice(key.indexOf(':') + 1)),
      ]),
    ];
    const { checks, schemaHashes } = await this.checks(approval.from, scope);
    if (checks.some((check) => !check.ok)) throw new PreflightFailedError(checks);
    if (approval.schemaHashes && stableJson(approval.schemaHashes) !== stableJson(schemaHashes)) {
      throw new ApprovalInvalidatedError('schema', 'a source or destination schema changed after review');
    }
    await this.engine.assertApprovalCurrent(approval);
    return approval;
  }

  /** Executes a standalone approved preview (API/CLI), at most once, as a durable job. */
  async executeDirect(previewRunId: string, request: ExecuteRequest = {}): Promise<ExecutionOutcome> {
    return this.claimAndEnqueue('direct', previewRunId, request);
  }

  /** Executes a plan's current approved full preview, at most once. */
  async executePlan(planId: string, request: ExecuteRequest = {}): Promise<ExecutionOutcome> {
    const plan = await this.plans.get(planId);
    if (!plan) throw new ExecutionRefusedError('plan_not_found', 'migration plan not found');
    if (!plan.previewRunId || plan.previewRevision !== plan.revision) {
      throw new ExecutionRefusedError('plan_state', 'a fresh preview of this plan revision is required');
    }
    const verification = plan.canary?.verification;
    if (!plan.canary?.verifiedAt || !verification?.passed || plan.canary.previewRevision !== plan.revision) {
      throw new ExecutionRefusedError('plan_state', 'a passing test of this plan revision is required');
    }
    const approval = await this.approvalFor(plan.previewRunId);
    if (verification.configFingerprint !== this.deps.config.fingerprint(plan.types)) {
      throw new ExecutionRefusedError('plan_state', 'the mapping changed after the test; test again');
    }
    const untested = plan.types.filter((type) => !verification.testedTypes.includes(type));
    if (untested.length) {
      throw new ExecutionRefusedError('plan_state', `test a record of every selected object first (untested: ${untested.join(', ')})`, { untested });
    }
    if (stableJson(verification.accounts) !== stableJson(approval.accounts)) {
      throw new ExecutionRefusedError('plan_state', 'the test ran against a different connected account');
    }
    return this.claimAndEnqueue('full', plan.previewRunId, request, plan);
  }

  /**
   * R08: claim the preview (R03), then copy its frozen items into the durable queue and
   * return. The worker executes them; the HTTP request never holds the run open.
   */
  private async claimAndEnqueue(
    kind: ExecutionKind,
    previewRunId: string,
    request: ExecuteRequest,
    plan?: MigrationPlan,
  ): Promise<ExecutionOutcome> {
    const approval = await this.assertExecutable(previewRunId);
    const { count } = await this.engine.assertPreviewExecutable(previewRunId);
    const claim = await this.executions.claim({
      kind,
      previewRunId,
      planId: plan?.id,
      planRevision: plan?.revision,
      idempotencyKey: request.idempotencyKey,
      actorId: request.actorId,
      approval,
      snapshot: plan
        ? {
            name: plan.name,
            source: plan.source,
            types: plan.types,
            limitPerType: plan.limitPerType ?? null,
            config: plan.config,
            revision: plan.revision,
          }
        : { from: approval.from, types: approval.types },
      quota: { metric: RECORDS_MIGRATED, requested: count },
    });
    if (claim.status === 'existing') {
      if (claim.sameRequest) {
        return { execution: claim.execution, replayed: true, counts: await this.executions.counts(claim.execution.id) };
      }
      throw new ExecutionRefusedError('execution_exists', 'this approved preview was already executed', {
        execution: claim.execution,
      });
    }
    if (claim.status === 'rejected') {
      throw new ExecutionRefusedError(
        claim.reason,
        claim.reason === 'quota_exceeded' ? 'plan limit exceeded' : String(claim.detail?.message ?? claim.reason),
        claim.detail ?? {},
      );
    }
    const execution = claim.execution;
    try {
      const runId = await this.engine.store.begin({
        source: approval.from,
        types: approval.types,
        mode: 'execute',
        options: { previewRunId, executionId: execution.id, kind, frozen: true, durable: true, approval },
        createdBy: request.actorId,
      });
      await this.executions.attachRun(execution.id, runId);
      const threshold = request.failureThreshold ?? Math.max(10, Math.ceil(count * 0.05));
      await this.executions.enqueueItems(
        execution.id,
        previewRunId,
        (offset, limit) => this.engine.store.plans(previewRunId, limit, offset),
        threshold,
      );
    } catch (err) {
      await this.executions.settle(execution.id, {
        status: 'failed',
        charged: 0,
        error: `could not enqueue: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
    if (request.wait) await this.worker.runUntilIdle(execution.id);
    else this.worker.kick();
    const current = (await this.executions.get(execution.id)) ?? execution;
    return { execution: current, replayed: false, counts: await this.executions.counts(execution.id) };
  }

  async execution(id: string): Promise<(MigrationExecution & { progress: ExecutionCounts }) | undefined> {
    const execution = await this.executions.get(id);
    return execution ? { ...execution, progress: await this.executions.counts(id) } : undefined;
  }

  /** Stops new claims; items already running finish. */
  async pause(id: string, reason = 'paused by operator'): Promise<boolean> {
    return this.executions.transition(id, ['running'], 'paused', reason);
  }

  /**
   * Resumes a paused run. Items whose outcome was uncertain are re-queued: their write
   * intents are recovered first, so a write that already happened is never repeated.
   */
  async resume(id: string, opts: { retryFailed?: boolean } = {}): Promise<boolean> {
    const execution = await this.executions.get(id);
    if (!execution || execution.status !== 'paused') return false;
    await this.executions.requeue(id, opts.retryFailed ? ['uncertain', 'failed'] : ['uncertain']);
    const resumed = await this.executions.transition(id, ['paused'], 'running');
    if (resumed) this.worker.kick();
    return resumed;
  }

  /**
   * Cancels: no new items are claimed and queued items are marked cancelled; items already
   * running finish and are reconciled. Nothing already written is rolled back.
   */
  async cancel(id: string): Promise<boolean> {
    const moved = await this.executions.transition(id, ['running', 'paused'], 'cancelling');
    if (!moved) return false;
    await this.executions.cancelQueued(id);
    await this.worker.runUntilIdle(id);
    return true;
  }

  /**
   * Executes a plan's frozen test preview (one record or a batch) under a claim, then reads
   * every destination record back and compares it with the reviewed result. The test only
   * unlocks a full run when every item verified and at least one item was a real write.
   */
  async executeCanary(
    planId: string,
    previewRunId: string,
    request: ExecuteRequest = {},
  ): Promise<ExecutionOutcome> {
    const plan = await this.plans.get(planId);
    if (!plan) throw new ExecutionRefusedError('plan_not_found', 'migration plan not found');
    if (!plan.canary || plan.canary.previewRunId !== previewRunId || plan.canary.previewRevision !== plan.revision) {
      throw new ExecutionRefusedError('plan_state', 'a fresh test preview of this plan revision is required');
    }
    const kind: ExecutionKind = plan.canary.sourceId.startsWith('batch:') ? 'batch' : 'canary';
    const frozen = await this.engine.store.plans(previewRunId, 1_000);
    const outcome = await this.claimAndRun(kind, previewRunId, request, plan, true);
    if (!outcome.report && !outcome.error) return outcome;
    const approval = await this.approvalFor(previewRunId);
    const verification = await this.verifyCanary(plan, previewRunId, approval, frozen, outcome);
    await this.plans.finishCanary(
      plan.id,
      plan.revision,
      previewRunId,
      outcome.execution.executionRunId ?? '',
      verification,
    );
    return { ...outcome, verification };
  }

  private async claimAndRun(
    kind: ExecutionKind,
    previewRunId: string,
    request: ExecuteRequest,
    plan?: MigrationPlan,
    captureFailure = false,
  ): Promise<ExecutionOutcome & { error?: unknown; applied?: ReconcilePlan[] }> {
    const approval = await this.assertExecutable(previewRunId);
    const previewRun = await this.engine.store.get(previewRunId);
    const requested = Object.values(previewRun?.report?.perType ?? {}).reduce((sum, stats) => sum + stats.read, 0);
    const claim = await this.executions.claim({
      kind,
      previewRunId,
      planId: plan?.id,
      planRevision: plan?.revision,
      idempotencyKey: request.idempotencyKey,
      actorId: request.actorId,
      approval,
      snapshot: plan
        ? {
            name: plan.name,
            source: plan.source,
            types: plan.types,
            limitPerType: plan.limitPerType ?? null,
            config: plan.config,
            revision: plan.revision,
          }
        : { from: approval.from, types: approval.types },
      quota: { metric: RECORDS_MIGRATED, requested },
    });
    if (claim.status === 'existing') {
      if (claim.sameRequest) return { execution: claim.execution, replayed: true };
      throw new ExecutionRefusedError('execution_exists', 'this approved preview was already executed', {
        execution: claim.execution,
      });
    }
    if (claim.status === 'rejected') {
      throw new ExecutionRefusedError(
        claim.reason,
        claim.reason === 'quota_exceeded' ? 'plan limit exceeded' : String(claim.detail?.message ?? claim.reason),
        claim.detail ?? {},
      );
    }

    const execution = claim.execution;
    let written = 0;
    let executionRunId: string | undefined;
    const applied: ReconcilePlan[] = [];
    try {
      const report = await this.engine.executePreview(previewRunId, {
        createdBy: request.actorId,
        runOptions: { executionId: execution.id, kind },
        onRunStarted: async (runId) => {
          executionRunId = runId;
          await this.executions.attachRun(execution.id, runId);
        },
        onItem: (item, wrote) => {
          applied.push(item);
          if (wrote) written += 1;
        },
      });
      await this.executions.settle(execution.id, {
        status: 'succeeded',
        charged: written,
        executionRunId: report.runId,
      });
      return {
        execution: { ...execution, status: 'succeeded', executionRunId: report.runId, quotaCharged: written },
        report,
        replayed: false,
        applied,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.executions
        .settle(execution.id, { status: 'failed', charged: written, error: message, executionRunId })
        .catch((settleErr) => logger.error({ err: settleErr, executionId: execution.id }, 'execution settlement failed'));
      if (!captureFailure) throw err;
      return {
        execution: { ...execution, status: 'failed', executionRunId, quotaCharged: written, error: message },
        replayed: false,
        error: err,
        applied,
      };
    }
  }

  /**
   * R04 read-back: each item's destination is re-read and every expected mapped, writable
   * value compared under the documented normalization (see valuesMatch). Fails on zero
   * processed records, any record error or drift, a missing destination, a mismatch, an
   * incomplete read-back, or when nothing was actually written.
   */
  private async verifyCanary(
    plan: MigrationPlan,
    previewRunId: string,
    approval: ApprovalContext,
    frozen: ReconcilePlan[],
    outcome: ExecutionOutcome & { error?: unknown; applied?: ReconcilePlan[] },
  ): Promise<CanaryVerification> {
    const reasons: string[] = [];
    const items: CanaryItemEvidence[] = [];
    const appliedBySource = new Map((outcome.applied ?? []).map((item) => [`${item.type}:${item.sourceId}`, item]));
    if (!frozen.length) reasons.push('the test processed zero records');
    if (outcome.error) {
      reasons.push(
        outcome.error instanceof PreviewDriftError
          ? `a record changed after review (${outcome.error.message})`
          : `the test stopped on an error: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
      );
    }
    for (const item of frozen) {
      const applied = appliedBySource.get(`${item.type}:${item.sourceId}`);
      const evidence: CanaryItemEvidence = {
        type: item.type,
        sourceId: item.sourceId,
        action: applied?.action ?? item.action,
        wrote: Boolean(applied && applied.action !== 'error' && applied.writes?.length),
        expected: this.expectedDestinationValues(item),
        mismatches: [],
      };
      items.push(evidence);
      if (item.action === 'ambiguous') {
        evidence.error = 'ambiguous destination match';
        reasons.push(`${item.type} ${item.sourceId}: ambiguous destination match`);
        continue;
      }
      if (!applied || applied.action === 'error') {
        evidence.error = applied?.warnings.at(-1) ?? 'not executed';
        reasons.push(`${item.type} ${item.sourceId}: ${evidence.error}`);
        continue;
      }
      const targetId =
        applied.targetId ??
        (await this.deps.idMap.bySource(item.from, item.sourceId, item.type))?.ids[item.to];
      evidence.targetId = targetId;
      if (!targetId) {
        evidence.error = 'no destination record is linked';
        reasons.push(`${item.type} ${item.sourceId}: no destination record is linked`);
        continue;
      }
      try {
        const target = await this.deps.connectors[item.to].read(item.type, targetId);
        if (!target) {
          evidence.error = 'destination record not found on read-back';
          reasons.push(`${item.type} ${item.sourceId}: destination ${targetId} not found`);
          continue;
        }
        evidence.actual = Object.fromEntries(Object.keys(evidence.expected).map((field) => [field, target.fields[field] ?? null]));
        for (const [field, expected] of Object.entries(evidence.expected)) {
          const actual = target.fields[field];
          if (!valuesMatch(expected, actual)) evidence.mismatches.push({ field, expected, actual });
        }
        if (evidence.mismatches.length) {
          reasons.push(
            `${item.type} ${item.sourceId}: ${evidence.mismatches.map((mismatch) => mismatch.field).join(', ')} did not match`,
          );
        }
      } catch (err) {
        evidence.error = `read-back failed: ${err instanceof Error ? err.message : String(err)}`;
        reasons.push(`${item.type} ${item.sourceId}: ${evidence.error}`);
      }
    }
    const representativeWrite = items.some((item) => item.wrote && !item.error && !item.mismatches.length);
    if (!representativeWrite && !reasons.length) {
      reasons.push('no record was actually written; choose a record that needs a create or update to test the write path');
    }
    const passed = reasons.length === 0;
    const planFingerprint = this.deps.config.fingerprint(plan.types);
    const testedTypes = passed ? [...new Set(items.filter((item) => item.wrote).map((item) => item.type))] : [];
    // Earlier passing tests of other objects under the same configuration and accounts
    // still count toward "every selected object tested".
    const previous = plan.canary?.verification;
    if (
      passed &&
      previous?.passed &&
      previous.configFingerprint === planFingerprint &&
      stableJson(previous.accounts) === stableJson(approval.accounts)
    ) {
      for (const type of previous.testedTypes) if (!testedTypes.includes(type)) testedTypes.push(type);
    }
    return {
      passed,
      reasons,
      checkedAt: new Date().toISOString(),
      previewRunId,
      executionRunId: outcome.execution.executionRunId,
      configFingerprint: planFingerprint,
      accounts: approval.accounts,
      testedTypes,
      representativeWrite,
      items,
    };
  }

  /** Destination values the reviewed plan promised: the write's fields, or (for a skip) the kept values. */
  private expectedDestinationValues(item: ReconcilePlan): Record<string, FieldValue> {
    const writable = new Set(
      this.deps.config.fieldRules(item.to, item.type)
        .filter((rule) => !rule.readOnly && !rule.native.includes('.'))
        .map((rule) => rule.canonical),
    );
    const write = item.writes?.find((candidate) => candidate.system === item.to);
    const source = write ? write.fields : item.resultFields ?? {};
    return Object.fromEntries(Object.entries(source).filter(([field]) => writable.has(field)));
  }
}

/**
 * Documented comparison rules for read-back verification (vendor normalization):
 *  - null, undefined and '' are equal (both CRMs report an unset property as empty/absent);
 *  - strings compare after trimming surrounding whitespace;
 *  - numbers compare numerically, including numeric strings ('5' vs 5, '5.0' vs 5);
 *  - booleans compare with their 'true'/'false' string forms;
 *  - ISO date-times compare as instants ('2026-01-01T00:00:00Z' vs '…00.000Z').
 * Anything else must match exactly.
 */
export function valuesMatch(expected: FieldValue | undefined, actual: FieldValue | undefined): boolean {
  const blank = (value: FieldValue | undefined) => value === null || value === undefined || value === '';
  if (blank(expected) || blank(actual)) return blank(expected) && blank(actual);
  if (typeof expected === 'boolean' || typeof actual === 'boolean') {
    return String(expected).toLowerCase() === String(actual).toLowerCase();
  }
  const a = String(expected).trim();
  const b = String(actual).trim();
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  if (isoPattern.test(a) && isoPattern.test(b)) {
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    return Number.isFinite(ta) && ta === tb;
  }
  return false;
}

export function schemaHashesFromChecks(checks: PreflightReport[]): Record<string, string> {
  return Object.fromEntries(
    checks.flatMap((check) =>
      Object.entries(check.schemas).map(([system, schema]) => [
        `${system}:${check.type}`,
        schema?.hash ?? '',
      ]),
    ),
  );
}
