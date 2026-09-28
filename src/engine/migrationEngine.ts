import type { CRMConnector } from '../core/connector.js';
import type { CanonicalRecord, CanonicalType, SystemId } from '../core/types.js';
import { contentHash } from '../core/idMap.js';
import type { ResolveOptions } from '../core/conflict.js';
import {
  IdentityConflictError,
  type Reconciler,
  type ReconcilePlan,
} from './reconciler.js';
import { logger } from '../logger.js';
import type { ActivityLog } from '../observability/activity.js';
import { InMemoryMigrationStore, type MigrationStore } from './migrationStore.js';
import { friendlyErrorMessage } from '../core/vendorError.js';
import type { ConfigContext } from '../core/configContext.js';
import { stableJson } from '../core/configContext.js';

export interface MigrationOptions {
  types: CanonicalType[];
  /** Source system to read FROM during the bulk backfill. */
  from: SystemId;
  /** Stop after N records per type (useful for dry runs). */
  limitPerType?: number;
  /**
   * Preview is the default. `dryRun: false` previews and then executes that frozen preview
   * in one call -- the same approved-plan path, with no interval for drift. Only trusted
   * local flows (tests, the mock demo) use it; operator-facing flows preview, review, and
   * then call executePreview() with the reviewed run id.
   */
  dryRun?: boolean;
  /** Extra run metadata (plan id/revision, canary markers). */
  runOptions?: Record<string, unknown>;
  createdBy?: string;
  /** Source/destination schema hashes validated for this preview (bound to the approval). */
  schemaHashes?: Record<string, string>;
}

export interface MigrationRecordPreviewOptions {
  from: SystemId;
  type: CanonicalType;
  sourceId: string;
  runOptions?: Record<string, unknown>;
  createdBy?: string;
  schemaHashes?: Record<string, string>;
}

export interface MigrationRecordsPreviewOptions {
  from: SystemId;
  type: CanonicalType;
  sourceIds: string[];
  runOptions?: Record<string, unknown>;
  createdBy?: string;
  schemaHashes?: Record<string, string>;
}

export interface MigrationReport {
  runId: string;
  perType: Record<
    string,
    {
      read: number;
      reconciled: number;
      errors: number;
      actions: Record<string, number>;
    }
  >;
  mode: 'preview' | 'execute';
  plans: ReconcilePlan[];
  startedAt: string;
  finishedAt: string;
  /** Present on previews: what an execution of this preview is bound to. */
  approval?: ApprovalContext;
  /** Number of CRM writes an execution performed. */
  writes?: number;
  /** Per-status item counts of a durable execution (R08). */
  counts?: import('./executionStore.js').ExecutionCounts;
  /** True when `plans` holds only the first PREVIEW_RESPONSE_PLAN_LIMIT items (see items API). */
  plansTruncated?: boolean;
}

/** Plans embedded in a preview response; the rest are read page by page from the store. */
export const PREVIEW_RESPONSE_PLAN_LIMIT = 500;
/** Largest preview executed synchronously (canaries, tests); anything larger uses the worker. */
export const SYNCHRONOUS_EXECUTION_LIMIT = 1_000;
const PAGE = 500;

/**
 * Everything an approval is bound to besides the frozen items themselves. Executing a
 * preview requires the current values to match: a changed mapping/value/natural-key
 * configuration, conflict policy, connected account, or object scope invalidates it.
 */
export interface ApprovalContext {
  from: SystemId;
  to: SystemId;
  types: CanonicalType[];
  configFingerprint: string;
  configRevision: number;
  conflict: Pick<ResolveOptions, 'strategy' | 'sourceOfTruth'>;
  accounts: Partial<Record<SystemId, string>>;
  writeScope: 'destination-only';
  /**
   * Migrations move records only; relationships (associations, lookups) are not migrated
   * and are not backfilled by a later live sync either (R10). Shown before approval.
   */
  relationshipScope?: 'records-only';
  /** Schema hashes validated when the preview was made (set by the migration service). */
  schemaHashes?: Record<string, string>;
}

export interface ExecutePreviewOptions {
  createdBy?: string;
  runOptions?: Record<string, unknown>;
  /** Called once the execution run exists (before the first write). */
  onRunStarted?: (executionRunId: string) => void | Promise<void>;
  /** Called after each item settles; `wrote` is true when a CRM write happened. */
  onItem?: (plan: ReconcilePlan, wrote: boolean) => void | Promise<void>;
}

/** Execution refused because inputs changed after review; nothing was written for it. */
export class PreviewDriftError extends Error {
  constructor(message: string) {
    super(`preview drift: ${message}`);
    this.name = 'PreviewDriftError';
  }
}

/** Execution refused because what the approval was bound to has changed. */
export class ApprovalInvalidatedError extends Error {
  constructor(
    readonly reason: 'configuration' | 'conflict_policy' | 'account' | 'schema' | 'scope' | 'format' | 'state',
    message: string,
  ) {
    super(`approval invalidated: ${message}`);
    this.name = 'ApprovalInvalidatedError';
  }
}

/**
 * MigrationEngine performs bulk backfill as preview → approve → execute. A preview streams
 * source records through the SAME Reconciler the real-time engine uses (under the
 * destination-only migration policy) and freezes each item's exact write. Execution
 * consumes those frozen items: it re-verifies every input before any write and again
 * immediately before each write, sends exactly the reviewed payload, and stops on the
 * first uncertainty. A skipped item never produces a CRM write.
 *
 * Execution builds the id map, so the moment migration finishes, real-time sync already
 * knows how records line up.
 */
export class MigrationEngine {
  constructor(
    private readonly connectors: Record<SystemId, CRMConnector>,
    private readonly config: ConfigContext,
    private readonly reconciler: Reconciler,
    private readonly activity?: ActivityLog,
    readonly store: MigrationStore = new InMemoryMigrationStore(),
  ) {}

  /** The approval context a preview made right now would be bound to. */
  async approvalContext(from: SystemId, types: CanonicalType[]): Promise<ApprovalContext> {
    const to: SystemId = from === 'salesforce' ? 'hubspot' : 'salesforce';
    const [sourceAccount, targetAccount] = await Promise.all([
      this.connectors[from].accountIdentity(),
      this.connectors[to].accountIdentity(),
    ]);
    const scope = [...new Set(types)].sort();
    return {
      from,
      to,
      types: scope,
      configFingerprint: this.config.fingerprint(scope),
      configRevision: this.config.revision,
      conflict: this.reconciler.conflictSettings(),
      accounts: { [from]: sourceAccount, [to]: targetAccount },
      writeScope: 'destination-only',
      relationshipScope: 'records-only',
    };
  }

  /** Preview by default; `dryRun: false` previews then executes that exact preview. */
  async run(opts: MigrationOptions): Promise<MigrationReport> {
    if (opts.dryRun === false) {
      const preview = await this.preview(opts);
      return this.executePreview(preview.runId, { createdBy: opts.createdBy });
    }
    return this.preview(opts);
  }

  async preview(opts: MigrationOptions): Promise<MigrationReport> {
    const approval = { ...(await this.approvalContext(opts.from, opts.types)), schemaHashes: opts.schemaHashes };
    const runId = await this.store.begin({
      source: opts.from,
      types: opts.types,
      mode: 'preview',
      options: {
        limitPerType: opts.limitPerType ?? null,
        ...(opts.runOptions ?? {}),
        approval,
      },
      createdBy: opts.createdBy,
    });
    const report = this.emptyReport(runId, 'preview', opts.types);
    report.approval = approval;
    const policy = this.reconciler.migrationPolicy(approval.conflict);
    const source = this.connectors[opts.from];

    try {
      for (const type of opts.types) {
        const stats = report.perType[type]!;
        let cursor: string | undefined;
        do {
          const page = await source.list(type, cursor);
          for (const record of page.records) {
            if (opts.limitPerType && stats.read >= opts.limitPerType) {
              cursor = undefined;
              break;
            }
            stats.read += 1;
            const plan = await this.planRecord(record, policy, opts.from);
            await this.store.recordPlan(runId, plan);
            if (report.plans.length < PREVIEW_RESPONSE_PLAN_LIMIT) report.plans.push(plan);
            else report.plansTruncated = true;
            stats.actions[plan.action] = (stats.actions[plan.action] ?? 0) + 1;
            if (plan.action === 'error') stats.errors += 1;
            else stats.reconciled += 1;
          }
          cursor = opts.limitPerType && stats.read >= opts.limitPerType ? undefined : page.nextCursor;
          logger.info({ type, read: stats.read, errors: stats.errors }, 'migration preview progress');
        } while (cursor);
      }
      report.finishedAt = new Date().toISOString();
      const total = report.plans.length;
      this.activity?.record({
        kind: 'migrate',
        message: `Previewed ${total} records from ${opts.from}`,
      });
      await this.store.complete(runId, report);
      return report;
    } catch (err) {
      await this.store.fail(runId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Previews one explicitly selected source record. This is the safety stage for a
   * migration canary: it creates a frozen, executable plan without writing to either CRM.
   */
  async previewRecord(opts: MigrationRecordPreviewOptions): Promise<MigrationReport> {
    return this.previewRecords({ ...opts, sourceIds: [opts.sourceId] }, { canary: true, sourceId: opts.sourceId });
  }

  /** Previews an explicit set of source records (a canary batch) as one frozen plan. */
  async previewRecords(
    opts: MigrationRecordsPreviewOptions,
    marker: Record<string, unknown> = { canary: true, sourceIds: opts.sourceIds },
  ): Promise<MigrationReport> {
    const approval = { ...(await this.approvalContext(opts.from, [opts.type])), schemaHashes: opts.schemaHashes };
    const records: CanonicalRecord[] = [];
    for (const sourceId of opts.sourceIds) {
      const record = await this.connectors[opts.from].read(opts.type, sourceId);
      if (!record) throw new Error(`source record not found: ${opts.type} ${sourceId}`);
      records.push(record);
    }
    const runId = await this.store.begin({
      source: opts.from,
      types: [opts.type],
      mode: 'preview',
      options: { ...marker, ...(opts.runOptions ?? {}), approval },
      createdBy: opts.createdBy,
    });
    const report = this.emptyReport(runId, 'preview', [opts.type]);
    report.approval = approval;
    const policy = this.reconciler.migrationPolicy(approval.conflict);
    try {
      const stats = report.perType[opts.type]!;
      for (const record of records) {
        stats.read += 1;
        const plan = await this.planRecord(record, policy, opts.from);
        await this.store.recordPlan(runId, plan);
        report.plans.push(plan);
        stats.actions[plan.action] = (stats.actions[plan.action] ?? 0) + 1;
        if (plan.action === 'error') stats.errors += 1;
        else stats.reconciled += 1;
      }
      report.finishedAt = new Date().toISOString();
      this.activity?.record({
        kind: 'migrate',
        message: `Prepared ${records.length}-record migration test from ${opts.from}`,
      });
      await this.store.complete(runId, report);
      return report;
    } catch (err) {
      await this.store.fail(runId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Executes an already-reviewed preview exactly. Before any write, the approval context
   * (configuration, conflict policy, accounts, scope) and every item's source/destination
   * fingerprints are re-verified; each item is verified again immediately before its write
   * and Salesforce updates are sent conditionally. The first failure or uncertainty stops
   * the run -- items after it are never written.
   */
  async executePreview(
    previewRunId: string,
    opts: ExecutePreviewOptions = {},
  ): Promise<MigrationReport> {
    const { approval, count } = await this.assertPreviewExecutable(previewRunId);
    if (count > SYNCHRONOUS_EXECUTION_LIMIT) {
      throw new Error(`a ${count}-record preview is executed by the durable migration worker, not synchronously`);
    }
    const frozenPlans = await this.store.plans(previewRunId, count);
    await this.assertApprovalCurrent(approval);

    // Verify every input before the first write: nothing is written if anything drifted.
    const verified: { record: CanonicalRecord; plan: ReconcilePlan }[] = [];
    for (const plan of frozenPlans) {
      verified.push({ record: await this.verifyItem(plan), plan });
    }

    const types = [...new Set(frozenPlans.map((plan) => plan.type))];
    const runId = await this.store.begin({
      source: approval.from,
      types,
      mode: 'execute',
      options: { previewRunId, frozen: true, approval, ...(opts.runOptions ?? {}) },
      createdBy: opts.createdBy,
    });
    await opts.onRunStarted?.(runId);
    const report = this.emptyReport(runId, 'execute', types);
    report.writes = 0;
    const policy = this.reconciler.migrationPolicy(approval.conflict);

    try {
      for (const { plan } of verified) {
        const stats = report.perType[plan.type]!;
        stats.read += 1;
        if (!plan.writes!.length && !plan.link) {
          // A skipped item produces no CRM write and needs no link change.
          await this.store.recordPlan(runId, plan);
          report.plans.push(plan);
          stats.reconciled += 1;
          stats.actions[plan.action] = (stats.actions[plan.action] ?? 0) + 1;
          await opts.onItem?.(plan, false);
          continue;
        }
        let applied: ReconcilePlan;
        try {
          // Re-verify immediately before writing (another process may have changed it).
          const record = await this.verifyItem(plan);
          // Deterministic per approved item: a later attempt recognises this item's own
          // earlier writes (R06 intents) instead of repeating them.
          applied = await this.reconciler.apply(plan, record, policy, {
            operationId: `mig:${previewRunId}:${plan.type}:${plan.sourceId}`,
          });
        } catch (err) {
          stats.errors += 1;
          const message = err instanceof PreviewDriftError || err instanceof IdentityConflictError
            ? err.message
            : friendlyErrorMessage(err, approval.to === 'salesforce' ? 'Salesforce' : 'HubSpot');
          const failed: ReconcilePlan = { ...plan, action: 'error', warnings: [...plan.warnings, message] };
          await this.store.recordPlan(runId, failed);
          report.plans.push(failed);
          await opts.onItem?.(failed, false);
          throw err;
        }
        report.writes += applied.writes?.length ?? 0;
        await this.store.recordPlan(runId, applied);
        report.plans.push(applied);
        stats.reconciled += 1;
        stats.actions[plan.action] = (stats.actions[plan.action] ?? 0) + 1;
        await opts.onItem?.(applied, Boolean(applied.writes?.length));
      }
      report.finishedAt = new Date().toISOString();
      const total = Object.values(report.perType).reduce((sum, stats) => sum + stats.reconciled, 0);
      this.activity?.incMigrated(total);
      this.activity?.record({
        kind: 'migrate',
        message: `Executed approved preview ${previewRunId.slice(0, 8)} (${total} records, ${report.writes} writes)`,
      });
      await this.store.complete(runId, report);
      return report;
    } catch (err) {
      await this.store.fail(runId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Throws ApprovalInvalidatedError when anything the approval is bound to changed. */
  async assertApprovalCurrent(approval: ApprovalContext): Promise<void> {
    const current = await this.approvalContext(approval.from, approval.types);
    if (current.configFingerprint !== approval.configFingerprint) {
      throw new ApprovalInvalidatedError('configuration', 'mappings, value translations, or matching rules changed after review');
    }
    if (stableJson(current.conflict) !== stableJson(approval.conflict)) {
      throw new ApprovalInvalidatedError('conflict_policy', 'the conflict policy changed after review');
    }
    for (const system of [approval.from, approval.to]) {
      if ((current.accounts[system] ?? null) !== (approval.accounts[system] ?? null)) {
        throw new ApprovalInvalidatedError('account', `the connected ${system} account changed after review`);
      }
    }
  }

  private async planRecord(
    record: CanonicalRecord,
    policy: ReturnType<Reconciler['migrationPolicy']>,
    from: SystemId,
  ): Promise<ReconcilePlan> {
    try {
      return await this.reconciler.preview(record, policy);
    } catch (err) {
      const targetSystem = from === 'salesforce' ? 'HubSpot' : 'Salesforce';
      const message = friendlyErrorMessage(err, targetSystem);
      logger.error({ err, type: record.type, sourceId: record.meta.sourceId }, 'migration record could not be planned');
      return {
        type: record.type,
        from,
        to: from === 'salesforce' ? 'hubspot' : 'salesforce',
        sourceId: record.meta.sourceId,
        action: 'error',
        fieldDiff: [],
        warnings: [message],
        writes: [],
      };
    }
  }

  /**
   * Validates a whole preview page by page (constant memory): it must be complete, use the
   * exact-plan format, contain no ambiguous/review/error items, and write only to the
   * approved destination. Returns its approval context and item count.
   */
  async assertPreviewExecutable(
    previewRunId: string,
  ): Promise<{ approval: ApprovalContext; count: number; types: CanonicalType[] }> {
    const previewRun = await this.store.get(previewRunId);
    if (!previewRun || previewRun.mode !== 'preview') {
      throw new ApprovalInvalidatedError('state', 'preview run not found');
    }
    if (previewRun.status !== 'completed') {
      throw new ApprovalInvalidatedError('state', `preview run is ${previewRun.status}`);
    }
    const approval = previewRun.options.approval as ApprovalContext | undefined;
    if (!approval) {
      throw new ApprovalInvalidatedError('format', 'preview predates exact approved plans; preview again');
    }
    let count = 0;
    const types = new Set<CanonicalType>();
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.store.plans(previewRunId, PAGE, offset);
      for (const plan of page) {
        count += 1;
        types.add(plan.type);
        if (!plan.writes || !plan.fingerprints) {
          throw new ApprovalInvalidatedError('format', 'preview predates exact approved plans; preview again');
        }
        if (plan.action === 'ambiguous') throw new Error('preview contains ambiguous matches');
        if (plan.action === 'review') throw new Error('preview contains records that need operator review');
        if (plan.action === 'error') throw new Error('preview contains records that could not be planned');
        if (plan.from !== approval.from || plan.to !== approval.to) {
          throw new Error('preview contains mixed source systems');
        }
        if (plan.writes.some((write) => write.system !== approval.to)) {
          throw new ApprovalInvalidatedError('scope', 'preview contains a write outside the destination');
        }
      }
      if (page.length < PAGE) break;
    }
    if (!count) throw new Error('preview has no executable records');
    return { approval, count, types: [...types] };
  }

  /**
   * Re-reads one item's source and destination and confirms both still match what was
   * reviewed. For a planned create, the destination must still have no record matching
   * the natural key (otherwise the create would duplicate one).
   */
  async verifyItem(plan: ReconcilePlan): Promise<CanonicalRecord> {
    const label = `${plan.type} ${plan.sourceId}`;
    const record = await this.connectors[plan.from].read(plan.type, plan.sourceId);
    if (!record) throw new PreviewDriftError(`${label} no longer exists`);
    if (contentHash(record.fields) !== plan.fingerprints!.source) {
      throw new PreviewDriftError(`${label} changed after review`);
    }
    if (plan.targetId) {
      const target = await this.connectors[plan.to].read(plan.type, plan.targetId);
      if (!target) throw new PreviewDriftError(`${plan.to} ${plan.type} ${plan.targetId} no longer exists`);
      if (contentHash(target.fields) !== plan.fingerprints!.target) {
        throw new PreviewDriftError(`${plan.to} ${plan.type} ${plan.targetId} changed after review`);
      }
    } else if (plan.writes!.some((write) => write.operation === 'create')) {
      const query = this.config.naturalKeyQuery(record);
      if (query) {
        const candidates = await this.connectors[plan.to].findByNaturalKey(plan.type, query);
        if (candidates.length) {
          throw new PreviewDriftError(`a ${plan.to} ${plan.type} matching ${query.key} appeared after review`);
        }
      }
    }
    return record;
  }

  private emptyReport(runId: string, mode: MigrationReport['mode'], types: CanonicalType[]): MigrationReport {
    return {
      runId,
      perType: Object.fromEntries(types.map((type) => [type, { read: 0, reconciled: 0, errors: 0, actions: {} }])),
      mode,
      plans: [],
      startedAt: new Date().toISOString(),
      finishedAt: '',
    };
  }
}
