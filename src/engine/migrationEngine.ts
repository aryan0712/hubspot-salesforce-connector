import type { CRMConnector } from '../core/connector.js';
import type { CanonicalRecord, CanonicalType, SystemId } from '../core/types.js';
import type { Reconciler } from './reconciler.js';
import type { ReconcilePlan } from './reconciler.js';
import { logger } from '../logger.js';
import type { ActivityLog } from '../observability/activity.js';
import { InMemoryMigrationStore, type MigrationStore } from './migrationStore.js';
import { friendlyErrorMessage } from '../core/vendorError.js';

export interface MigrationOptions {
  types: CanonicalType[];
  /** Source system to read FROM during the bulk backfill. */
  from: SystemId;
  /** Stop after N records per type (useful for dry runs). */
  limitPerType?: number;
  /** If true, don't write to the target; just report what would happen. */
  dryRun?: boolean;
}

export interface MigrationRecordPreviewOptions {
  from: SystemId;
  type: CanonicalType;
  sourceId: string;
  runOptions?: Record<string, unknown>;
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
}

/**
 * MigrationEngine performs the initial bulk backfill. It streams every record of each
 * requested type from the source connector and funnels each through the SAME Reconciler
 * the real-time engine uses. That means the migration also builds the id map, so the
 * moment migration finishes, real-time sync already knows how records line up.
 *
 * Run it once per direction for a full bidirectional seed, or once for a one-way migration.
 */
export class MigrationEngine {
  constructor(
    private readonly connectors: Record<SystemId, CRMConnector>,
    private readonly reconciler: Reconciler,
    private readonly activity?: ActivityLog,
    readonly store: MigrationStore = new InMemoryMigrationStore(),
  ) {}

  async run(opts: MigrationOptions): Promise<MigrationReport> {
    const runId = await this.store.begin({
      source: opts.from,
      types: opts.types,
      mode: opts.dryRun ? 'preview' : 'execute',
      options: { limitPerType: opts.limitPerType ?? null },
    });
    const report: MigrationReport = {
      runId,
      perType: {},
      mode: opts.dryRun ? 'preview' : 'execute',
      plans: [],
      startedAt: new Date().toISOString(),
      finishedAt: '',
    };
    const source: CRMConnector = this.connectors[opts.from];

    try {
      for (const type of opts.types) {
      const stats = {
        read: 0,
        reconciled: 0,
        errors: 0,
        actions: {} as Record<string, number>,
      };
      report.perType[type] = stats;
      let cursor: string | undefined;

      do {
        const page = await source.list(type, cursor);
        for (const record of page.records) {
          if (opts.limitPerType && stats.read >= opts.limitPerType) {
            cursor = undefined;
            break;
          }
          stats.read += 1;
          let plan: ReconcilePlan | undefined;
          try {
            plan = await this.reconciler.preview(record);
            if (opts.dryRun) {
              await this.store.recordPlan(runId, plan);
              report.plans.push(plan);
              stats.actions[plan.action] = (stats.actions[plan.action] ?? 0) + 1;
            } else {
              if (plan.action === 'ambiguous') throw new Error(plan.warnings.join('; '));
              await this.reconciler.reconcile(record);
              await this.store.recordPlan(runId, plan);
              report.plans.push(plan);
              stats.actions[plan.action] = (stats.actions[plan.action] ?? 0) + 1;
            }
            stats.reconciled += 1;
          } catch (err) {
            stats.errors += 1;
            const targetSystem = opts.from === 'salesforce' ? 'HubSpot' : 'Salesforce';
            const message = friendlyErrorMessage(err, targetSystem);
            logger.error({ err, type, sourceId: record.meta.sourceId, message }, 'migration record failed');
            // Record what actually happened (not the pre-write intent) so the operator can see
            // which record failed and why, not just an aggregate error count.
            const failedPlan: ReconcilePlan = plan
              ? { ...plan, action: 'error', warnings: [...plan.warnings, message] }
              : {
                  type,
                  from: opts.from,
                  to: opts.from === 'salesforce' ? 'hubspot' : 'salesforce',
                  sourceId: record.meta.sourceId,
                  action: 'error',
                  fieldDiff: [],
                  warnings: [message],
                };
            await this.store.recordPlan(runId, failedPlan);
            report.plans.push(failedPlan);
          }
        }
        cursor = opts.limitPerType && stats.read >= opts.limitPerType ? undefined : page.nextCursor;
        logger.info({ type, ...stats }, 'migration progress');
      } while (cursor);
      }

      report.finishedAt = new Date().toISOString();
      const total = Object.values(report.perType).reduce((n, s) => n + s.reconciled, 0);
      if (!opts.dryRun) this.activity?.incMigrated(total);
      this.activity?.record({
        kind: 'migrate',
        message: `${opts.dryRun ? 'Previewed' : 'Migrated'} ${total} records from ${opts.from}`,
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
    const record = await this.connectors[opts.from].read(opts.type, opts.sourceId);
    if (!record) throw new Error(`source record not found: ${opts.type} ${opts.sourceId}`);
    const runId = await this.store.begin({
      source: opts.from,
      types: [opts.type],
      mode: 'preview',
      options: {
        canary: true,
        sourceId: opts.sourceId,
        ...(opts.runOptions ?? {}),
      },
    });
    const report: MigrationReport = {
      runId,
      perType: {
        [opts.type]: {
          read: 1,
          reconciled: 0,
          errors: 0,
          actions: {},
        },
      },
      mode: 'preview',
      plans: [],
      startedAt: new Date().toISOString(),
      finishedAt: '',
    };
    try {
      const plan = await this.reconciler.preview(record);
      await this.store.recordPlan(runId, plan);
      report.plans.push(plan);
      report.perType[opts.type]!.reconciled = 1;
      report.perType[opts.type]!.actions[plan.action] = 1;
      report.finishedAt = new Date().toISOString();
      this.activity?.record({
        kind: 'migrate',
        message: `Prepared one-record migration test from ${opts.from}`,
      });
      await this.store.complete(runId, report);
      return report;
    } catch (err) {
      report.perType[opts.type]!.errors = 1;
      await this.store.fail(runId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Executes an already-reviewed preview. Every source record and its plan are rechecked
   * before the first write, so source/target drift invalidates the run instead of silently
   * changing what the operator approved.
   */
  async executePreview(previewRunId: string): Promise<MigrationReport> {
    const frozenPlans = await this.store.plans(previewRunId, 100_000);
    if (!frozenPlans.length) throw new Error('preview has no executable records');
    if (frozenPlans.some((plan) => plan.action === 'ambiguous')) {
      throw new Error('preview contains ambiguous matches');
    }
    const from = frozenPlans[0]!.from;
    if (frozenPlans.some((plan) => plan.from !== from)) {
      throw new Error('preview contains mixed source systems');
    }

    const verified: { record: CanonicalRecord; plan: ReconcilePlan }[] = [];
    for (const frozen of frozenPlans) {
      const record = await this.connectors[from].read(frozen.type, frozen.sourceId);
      if (!record) throw new Error(`preview drift: ${frozen.type} ${frozen.sourceId} no longer exists`);
      const current = await this.reconciler.preview(record);
      if (planFingerprint(current) !== planFingerprint(frozen)) {
        throw new Error(`preview drift: ${frozen.type} ${frozen.sourceId} changed after review`);
      }
      verified.push({ record, plan: frozen });
    }

    const types = [...new Set(frozenPlans.map((plan) => plan.type))];
    const runId = await this.store.begin({
      source: from,
      types,
      mode: 'execute',
      options: { previewRunId, frozen: true },
    });
    const report: MigrationReport = {
      runId,
      perType: {},
      mode: 'execute',
      plans: [],
      startedAt: new Date().toISOString(),
      finishedAt: '',
    };
    for (const type of types) {
      report.perType[type] = {
        read: 0,
        reconciled: 0,
        errors: 0,
        actions: {},
      };
    }

    try {
      for (const { record, plan } of verified) {
        const stats = report.perType[plan.type]!;
        stats.read += 1;
        await this.store.recordPlan(runId, plan);
        try {
          await this.reconciler.reconcile(record);
          stats.reconciled += 1;
          stats.actions[plan.action] = (stats.actions[plan.action] ?? 0) + 1;
        } catch (err) {
          stats.errors += 1;
          throw err;
        }
      }
      report.finishedAt = new Date().toISOString();
      const total = Object.values(report.perType).reduce((sum, stats) => sum + stats.reconciled, 0);
      this.activity?.incMigrated(total);
      this.activity?.record({
        kind: 'migrate',
        message: `Executed frozen preview ${previewRunId.slice(0, 8)} (${total} records)`,
      });
      await this.store.complete(runId, report);
      return report;
    } catch (err) {
      await this.store.fail(runId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}

function planFingerprint(plan: ReconcilePlan): string {
  return JSON.stringify({
    type: plan.type,
    from: plan.from,
    to: plan.to,
    sourceId: plan.sourceId,
    targetId: plan.targetId ?? null,
    naturalKey: plan.naturalKey ?? null,
    action: plan.action,
    fieldDiff: plan.fieldDiff,
    warnings: plan.warnings,
  });
}
