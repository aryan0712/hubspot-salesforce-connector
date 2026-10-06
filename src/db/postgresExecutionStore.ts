import type { PoolClient } from 'pg';
import type {
  ClaimOutcome,
  ExecutionClaimInput,
  ExecutionCounts,
  ExecutionItem,
  ExecutionItemStatus,
  ExecutionKind,
  ExecutionSettlement,
  ExecutionStatus,
  ExecutionStore,
  ItemResult,
  MigrationExecution,
  PlanPageLoader,
} from '../engine/executionStore.js';
import { emptyCounts, planIneligibility } from '../engine/executionStore.js';
import type { ReconcilePlan } from '../engine/reconciler.js';
import type { ApprovalContext } from '../engine/migrationEngine.js';
import { mapMigrationPlanRow, type MigrationPlanRow } from './postgresMigrationPlanStore.js';
import type { PostgresDatabase } from './postgres.js';

interface ExecutionRow {
  id: string;
  kind: ExecutionKind;
  status: ExecutionStatus;
  preview_run_id: string;
  execution_run_id: string | null;
  plan_id: string | null;
  plan_revision: number | null;
  idempotency_key: string | null;
  actor_id: string | null;
  approval: ApprovalContext;
  snapshot: Record<string, unknown>;
  approved_at: Date;
  quota_metric: string | null;
  quota_reserved: string;
  quota_charged: string | null;
  error: string | null;
  pause_reason: string | null;
  failure_threshold: number | null;
  item_count: number;
  counts: Partial<ExecutionCounts>;
  created_at: Date;
  finished_at: Date | null;
}

interface ItemRow {
  execution_id: string;
  position: number;
  object_type: string;
  source_id: string;
  plan: ReconcilePlan;
  status: ExecutionItemStatus;
  attempts: number;
  wrote: boolean;
  target_id: string | null;
  error: string | null;
  updated_at: Date;
}

const ACTIVE_SQL = `status IN ('running', 'paused', 'cancelling')`;

/**
 * Claims are one transaction: the plan row is locked (FOR UPDATE) so two processes claiming
 * the same plan serialize; the unique (tenant, preview_run_id) and idempotency-key
 * constraints make a second claim of the same preview find the first; and quota is
 * checked against committed usage plus running reservations under a per-tenant advisory
 * lock, then reserved by the inserted row itself.
 */
export class PostgresExecutionStore implements ExecutionStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async claim(input: ExecutionClaimInput): Promise<ClaimOutcome> {
    return this.db.tenant(this.tenantId, async (client) => {
      if (input.idempotencyKey) {
        const byKey = await this.selectOne(client, 'idempotency_key = $2', [input.idempotencyKey]);
        if (byKey) return { status: 'existing', execution: byKey, sameRequest: true };
      }
      if (input.planId) {
        const planResult = await client.query<MigrationPlanRow>(
          `SELECT * FROM migration_plans WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [this.tenantId, input.planId],
        );
        const row = planResult.rows[0];
        if (!row) return { status: 'rejected', reason: 'plan_not_found' };
        const existing = await this.selectOne(client, 'preview_run_id = $2', [input.previewRunId]);
        if (existing) return { status: 'existing', execution: existing, sameRequest: false };
        const why = planIneligibility(mapMigrationPlanRow(row), input);
        if (why) return { status: 'rejected', reason: 'plan_state', detail: { message: why } };
      }
      if (input.quota) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${this.tenantId}:quota:${input.quota.metric}`,
        ]);
        const quota = await client.query<{ used: string; reserved: string; limit_value: string | null }>(
          `SELECT
             coalesce((SELECT quantity FROM usage_counters
                       WHERE tenant_id = $1 AND metric = $2
                         AND period_start = date_trunc('month', now())::date), 0)::text AS used,
             coalesce((SELECT sum(quota_reserved) FROM migration_executions
                       WHERE tenant_id = $1 AND quota_metric = $2 AND ${ACTIVE_SQL}), 0)::text AS reserved,
             (SELECT limits ->> $2 FROM subscriptions WHERE tenant_id = $1) AS limit_value`,
          [this.tenantId, input.quota.metric],
        );
        const used = Number(quota.rows[0]?.used ?? 0);
        const reserved = Number(quota.rows[0]?.reserved ?? 0);
        const limitValue = quota.rows[0]?.limit_value;
        const limit = limitValue === null || limitValue === undefined ? undefined : Number(limitValue);
        if (limit !== undefined && used + reserved + input.quota.requested > limit) {
          return {
            status: 'rejected',
            reason: 'quota_exceeded',
            detail: { used, reserved, requested: input.quota.requested, limit },
          };
        }
      }
      const inserted = await client.query<ExecutionRow>(
        `INSERT INTO migration_executions(
           tenant_id, preview_run_id, plan_id, plan_revision, kind, idempotency_key,
           actor_id, approval, snapshot, quota_metric, quota_reserved
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          this.tenantId,
          input.previewRunId,
          input.planId ?? null,
          input.planRevision ?? null,
          input.kind,
          input.idempotencyKey ?? null,
          input.actorId ?? null,
          JSON.stringify(input.approval),
          JSON.stringify(input.snapshot ?? {}),
          input.quota?.metric ?? null,
          input.quota?.requested ?? 0,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        const existing =
          (input.idempotencyKey
            ? await this.selectOne(client, 'idempotency_key = $2', [input.idempotencyKey])
            : undefined) ?? (await this.selectOne(client, 'preview_run_id = $2', [input.previewRunId]));
        if (!existing) throw new Error('execution claim conflicted but no existing execution was found');
        return {
          status: 'existing',
          execution: existing,
          sameRequest: Boolean(input.idempotencyKey && existing.idempotencyKey === input.idempotencyKey),
        };
      }
      if (input.planId) {
        await client.query(
          `UPDATE migration_plans SET active_execution_id = $3,
                  status = CASE WHEN $4::boolean THEN 'executing' ELSE status END,
                  updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [this.tenantId, input.planId, row.id, input.kind === 'full'],
        );
      }
      return { status: 'claimed', execution: mapRow(row) };
    });
  }

  async attachRun(id: string, executionRunId: string): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE migration_executions SET execution_run_id = $3
         WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
        [this.tenantId, id, executionRunId],
      );
    });
  }

  async settle(id: string, settlement: ExecutionSettlement): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<ExecutionRow>(
        `UPDATE migration_executions SET status = $3, quota_charged = $4, error = $5,
                execution_run_id = coalesce($6, execution_run_id), finished_at = now()
         WHERE tenant_id = $1 AND id = $2 AND ${ACTIVE_SQL}
         RETURNING *`,
        [
          this.tenantId,
          id,
          settlement.status,
          settlement.charged,
          settlement.error?.slice(0, 4000) ?? null,
          settlement.executionRunId ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) return false;
      if (row.quota_metric && settlement.charged > 0) {
        await client.query(
          `INSERT INTO usage_counters(tenant_id, metric, period_start, quantity)
           VALUES ($1,$2,date_trunc('month', now())::date,$3)
           ON CONFLICT (tenant_id, metric, period_start) DO UPDATE SET
             quantity = usage_counters.quantity + EXCLUDED.quantity,
             updated_at = now()`,
          [this.tenantId, row.quota_metric, settlement.charged],
        );
      }
      if (row.plan_id) {
        const full = row.kind === 'full';
        await client.query(
          `UPDATE migration_plans SET active_execution_id = NULL,
                  status = CASE WHEN $4::boolean THEN $5 ELSE status END,
                  execution_run_id = CASE WHEN $4::boolean THEN $6 ELSE execution_run_id END,
                  updated_at = now()
           WHERE tenant_id = $1 AND id = $2 AND active_execution_id = $3`,
          [
            this.tenantId,
            row.plan_id,
            row.id,
            full,
            settlement.status === 'succeeded' ? 'completed' : 'failed',
            row.execution_run_id,
          ],
        );
      }
      return true;
    });
  }

  async get(id: string): Promise<MigrationExecution | undefined> {
    return this.db.tenant(this.tenantId, (client) => this.selectOne(client, 'id = $2', [id]));
  }

  async byPreview(previewRunId: string): Promise<MigrationExecution | undefined> {
    return this.db.tenant(this.tenantId, (client) => this.selectOne(client, 'preview_run_id = $2', [previewRunId]));
  }

  async list(limit = 50): Promise<MigrationExecution[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<ExecutionRow>(
        `SELECT * FROM migration_executions WHERE tenant_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [this.tenantId, limit],
      );
      return result.rows.map(mapRow);
    });
  }

  // ------------------------------------------------------------------ R08 item queue

  async enqueueItems(
    executionId: string,
    previewRunId: string,
    _loadPage: PlanPageLoader,
    failureThreshold?: number,
  ): Promise<number> {
    // Set-based copy inside the database: the frozen plans never pass through app memory.
    return this.db.tenant(this.tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO migration_execution_items(
           tenant_id, execution_id, position, object_type, source_id, plan
         )
         SELECT tenant_id, $2, (row_number() OVER (ORDER BY position NULLS LAST, created_at, id))::int - 1,
                object_type, source_id, plan
         FROM migration_items
         WHERE tenant_id = $1 AND run_id = $3 AND plan IS NOT NULL
         ON CONFLICT DO NOTHING`,
        [this.tenantId, executionId, previewRunId],
      );
      const count = inserted.rowCount ?? 0;
      await client.query(
        `UPDATE migration_executions SET item_count = $3, failure_threshold = $4
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, executionId, count, failureThreshold ?? null],
      );
      return count;
    });
  }

  async claimItems(workerId: string, limit: number, leaseMs: number, executionId?: string): Promise<ExecutionItem[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<ItemRow>(
        `WITH candidates AS (
           SELECT i.execution_id, i.position
           FROM migration_execution_items i
           JOIN migration_executions e ON e.tenant_id = i.tenant_id AND e.id = i.execution_id
           WHERE i.tenant_id = $1 AND e.status = 'running'
             AND ($5::uuid IS NULL OR i.execution_id = $5)
             AND (i.status = 'queued' OR (i.status = 'running' AND i.lease_expires_at < now()))
           ORDER BY i.execution_id, i.position
           FOR UPDATE OF i SKIP LOCKED
           LIMIT $2
         )
         UPDATE migration_execution_items i
         SET status = 'running', attempts = i.attempts + 1, lease_owner = $3,
             lease_expires_at = now() + ($4::int * interval '1 millisecond'), updated_at = now()
         FROM candidates c
         WHERE i.tenant_id = $1 AND i.execution_id = c.execution_id AND i.position = c.position
         RETURNING i.*`,
        [this.tenantId, limit, workerId, leaseMs, executionId ?? null],
      );
      return result.rows.sort((a, b) => a.position - b.position).map(mapItem);
    });
  }

  async completeItem(executionId: string, position: number, workerId: string, result: ItemResult): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE migration_execution_items
         SET status = $5, wrote = $6, target_id = coalesce($7, target_id), error = $8,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE tenant_id = $1 AND execution_id = $2 AND position = $3
           AND status = 'running' AND lease_owner = $4`,
        [
          this.tenantId,
          executionId,
          position,
          workerId,
          result.status,
          Boolean(result.wrote),
          result.targetId ?? null,
          result.error?.slice(0, 2000) ?? null,
        ],
      );
      return Boolean(updated.rowCount);
    });
  }

  async extendLease(executionId: string, position: number, workerId: string, leaseMs: number): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE migration_execution_items
         SET lease_expires_at = now() + ($5::int * interval '1 millisecond')
         WHERE tenant_id = $1 AND execution_id = $2 AND position = $3 AND lease_owner = $4 AND status = 'running'`,
        [this.tenantId, executionId, position, workerId, leaseMs],
      );
      return Boolean(updated.rowCount);
    });
  }

  async counts(executionId: string): Promise<ExecutionCounts> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{ status: ExecutionItemStatus; count: string; written: string }>(
        `SELECT status, count(*)::text AS count, count(*) FILTER (WHERE wrote)::text AS written
         FROM migration_execution_items WHERE tenant_id = $1 AND execution_id = $2
         GROUP BY status`,
        [this.tenantId, executionId],
      );
      const counts = emptyCounts();
      for (const row of result.rows) {
        counts[row.status] = Number(row.count);
        counts.total += Number(row.count);
        counts.written += Number(row.written);
      }
      return counts;
    });
  }

  async items(
    executionId: string,
    opts: { after?: number; limit?: number; status?: ExecutionItemStatus } = {},
  ): Promise<ExecutionItem[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<ItemRow>(
        `SELECT * FROM migration_execution_items
         WHERE tenant_id = $1 AND execution_id = $2 AND position > $3
           AND ($4::text IS NULL OR status = $4)
         ORDER BY position LIMIT $5`,
        [this.tenantId, executionId, opts.after ?? -1, opts.status ?? null, Math.min(opts.limit ?? 100, 1000)],
      );
      return result.rows.map(mapItem);
    });
  }

  async transition(id: string, from: ExecutionStatus[], to: ExecutionStatus, reason?: string): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE migration_executions SET status = $4,
                pause_reason = CASE WHEN $4 = 'paused' THEN $5 ELSE NULL END
         WHERE tenant_id = $1 AND id = $2 AND status = ANY($3::text[])`,
        [this.tenantId, id, from, to, reason ?? null],
      );
      return Boolean(result.rowCount);
    });
  }

  async cancelQueued(executionId: string): Promise<number> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE migration_execution_items SET status = 'cancelled', updated_at = now()
         WHERE tenant_id = $1 AND execution_id = $2 AND status = 'queued'`,
        [this.tenantId, executionId],
      );
      return result.rowCount ?? 0;
    });
  }

  async requeue(executionId: string, statuses: ExecutionItemStatus[]): Promise<number> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE migration_execution_items SET status = 'queued', error = NULL,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE tenant_id = $1 AND execution_id = $2 AND status = ANY($3::text[])`,
        [this.tenantId, executionId, statuses],
      );
      return result.rowCount ?? 0;
    });
  }

  async recordProgress(executionId: string, counts: ExecutionCounts): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE migration_executions SET counts = $3, progress_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, executionId, JSON.stringify(counts)],
      );
    });
  }

  async active(): Promise<MigrationExecution[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<ExecutionRow>(
        `SELECT * FROM migration_executions
         WHERE tenant_id = $1 AND status IN ('running', 'cancelling')
         ORDER BY created_at`,
        [this.tenantId],
      );
      return result.rows.map(mapRow);
    });
  }

  private async selectOne(
    client: PoolClient,
    where: string,
    params: unknown[],
  ): Promise<MigrationExecution | undefined> {
    const result = await client.query<ExecutionRow>(
      `SELECT * FROM migration_executions WHERE tenant_id = $1 AND ${where}`,
      [this.tenantId, ...params],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }
}

function mapRow(row: ExecutionRow): MigrationExecution {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    previewRunId: row.preview_run_id,
    executionRunId: row.execution_run_id ?? undefined,
    planId: row.plan_id ?? undefined,
    planRevision: row.plan_revision ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    actorId: row.actor_id ?? undefined,
    approval: row.approval,
    snapshot: row.snapshot,
    approvedAt: row.approved_at.toISOString(),
    quotaMetric: row.quota_metric ?? undefined,
    quotaReserved: Number(row.quota_reserved),
    quotaCharged: row.quota_charged === null ? undefined : Number(row.quota_charged),
    error: row.error ?? undefined,
    pauseReason: row.pause_reason ?? undefined,
    failureThreshold: row.failure_threshold ?? undefined,
    itemCount: row.item_count,
    counts: row.counts,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
  };
}

function mapItem(row: ItemRow): ExecutionItem {
  return {
    executionId: row.execution_id,
    position: row.position,
    type: row.object_type,
    sourceId: row.source_id,
    plan: row.plan,
    status: row.status,
    attempts: row.attempts,
    wrote: row.wrote,
    targetId: row.target_id ?? undefined,
    error: row.error ?? undefined,
    updatedAt: row.updated_at.toISOString(),
  };
}
