import type { CanonicalType, SystemId } from '../core/types.js';
import type { MigrationReport } from '../engine/migrationEngine.js';
import type {
  MigrationRunInput,
  MigrationRunSummary,
  MigrationStore,
} from '../engine/migrationStore.js';
import type { PlannedAction, ReconcilePlan } from '../engine/reconciler.js';
import type { PostgresDatabase } from './postgres.js';

interface RunRow {
  id: string;
  source_system: SystemId;
  mode: 'preview' | 'execute';
  status: MigrationRunSummary['status'];
  object_types: CanonicalType[];
  options: Record<string, unknown>;
  summary: MigrationReport | { error?: string };
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_by: string | null;
}

export class PostgresMigrationStore implements MigrationStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async begin(input: MigrationRunInput): Promise<string> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO migration_runs(
           tenant_id, source_system, mode, status, object_types, options,
           started_at, created_by
         ) VALUES ($1,$2,$3,'running',$4,$5,now(),$6) RETURNING id`,
        [
          this.tenantId,
          input.source,
          input.mode,
          input.types,
          JSON.stringify(input.options),
          input.createdBy ?? null,
        ],
      );
      return result.rows[0]!.id;
    });
  }

  async recordPlan(runId: string, plan: ReconcilePlan): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO migration_items(
           tenant_id, run_id, object_type, source_id, target_id, natural_key,
           action, field_diff, warnings, plan, position
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
           (SELECT coalesce(max(position), -1) + 1 FROM migration_items
            WHERE tenant_id = $1 AND run_id = $2)
         )`,
        [
          this.tenantId,
          runId,
          plan.type,
          plan.sourceId,
          plan.targetId ?? null,
          plan.naturalKey ?? null,
          plan.action,
          JSON.stringify(plan.fieldDiff),
          JSON.stringify(plan.warnings),
          JSON.stringify(plan),
        ],
      );
    });
  }

  async complete(runId: string, report: MigrationReport): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE migration_runs SET status = 'completed', summary = $3,
                finished_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, runId, JSON.stringify({ ...report, plans: [] })],
      );
    });
  }

  async fail(runId: string, error: string): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE migration_runs SET status = 'failed',
                summary = jsonb_build_object('error', $3::text), finished_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, runId, error.slice(0, 4000)],
      );
    });
  }

  async get(runId: string): Promise<MigrationRunSummary | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<RunRow>(
        `SELECT id, source_system, mode, status, object_types, options, summary,
                created_at, started_at, finished_at, created_by
         FROM migration_runs WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, runId],
      );
      return result.rows[0] ? mapRun(result.rows[0]) : undefined;
    });
  }

  async list(limit = 50): Promise<MigrationRunSummary[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<RunRow>(
        `SELECT id, source_system, mode, status, object_types, options, summary,
                created_at, started_at, finished_at, created_by
         FROM migration_runs WHERE tenant_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [this.tenantId, limit],
      );
      return result.rows.map(mapRun);
    });
  }

  async plans(runId: string, limit = 500, offset = 0): Promise<ReconcilePlan[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{
        object_type: CanonicalType;
        source_id: string;
        target_id: string | null;
        natural_key: string | null;
        action: PlannedAction;
        field_diff: ReconcilePlan['fieldDiff'];
        warnings: string[];
        plan: ReconcilePlan | null;
        source_system: SystemId;
      }>(
        `SELECT i.object_type, i.source_id, i.target_id, i.natural_key,
                i.action, i.field_diff, i.warnings, i.plan, r.source_system
         FROM migration_items i
         JOIN migration_runs r ON r.tenant_id = i.tenant_id AND r.id = i.run_id
         WHERE i.tenant_id = $1 AND i.run_id = $2
         ORDER BY i.position NULLS LAST, i.created_at, i.id
         LIMIT $3 OFFSET $4`,
        [this.tenantId, runId, limit, offset],
      );
      return result.rows.map((row) =>
        row.plan ?? {
          // Legacy row from before exact plans were stored: no writes/fingerprints, which
          // execution rejects so the operator re-previews.
          type: row.object_type,
          from: row.source_system,
          to: row.source_system === 'salesforce' ? 'hubspot' : 'salesforce',
          sourceId: row.source_id,
          targetId: row.target_id ?? undefined,
          naturalKey: row.natural_key ?? undefined,
          action: row.action,
          fieldDiff: row.field_diff,
          warnings: row.warnings,
        });
    });
  }
}

function mapRun(row: RunRow): MigrationRunSummary {
  return {
    id: row.id,
    source: row.source_system,
    mode: row.mode,
    status: row.status,
    types: row.object_types,
    options: row.options,
    report: 'perType' in row.summary ? row.summary : undefined,
    error: 'error' in row.summary ? row.summary.error : undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
  };
}
