import type { CanonicalType, SystemId } from '../core/types.js';
import type {
  MigrationPlan,
  MigrationPlanInput,
  MigrationPlanStatus,
  MigrationPlanStore,
} from '../engine/migrationPlanStore.js';
import type { PostgresDatabase } from './postgres.js';

interface PlanRow {
  id: string;
  name: string;
  source_system: SystemId;
  object_types: CanonicalType[];
  limit_per_type: number | null;
  include_associations: boolean;
  config: MigrationPlan['config'];
  status: MigrationPlanStatus;
  revision: number;
  schema_hashes: Record<string, string>;
  preview_run_id: string | null;
  preview_revision: number | null;
  execution_run_id: string | null;
  canary_preview_run_id: string | null;
  canary_preview_revision: number | null;
  canary_execution_run_id: string | null;
  canary_object_type: CanonicalType | null;
  canary_source_id: string | null;
  canary_verified_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PostgresMigrationPlanStore implements MigrationPlanStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async create(input: MigrationPlanInput): Promise<MigrationPlan> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<PlanRow>(
        `INSERT INTO migration_plans(
           tenant_id, name, source_system, object_types, limit_per_type,
           include_associations, config, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          this.tenantId,
          input.name,
          input.source,
          input.types,
          input.limitPerType ?? null,
          false,
          JSON.stringify(input.config ?? {}),
          input.createdBy ?? null,
        ],
      );
      return mapRow(result.rows[0]!);
    });
  }

  async list(limit = 50): Promise<MigrationPlan[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<PlanRow>(
        `SELECT * FROM migration_plans
         WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2`,
        [this.tenantId, limit],
      );
      return result.rows.map(mapRow);
    });
  }

  async get(id: string): Promise<MigrationPlan | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<PlanRow>(
        `SELECT * FROM migration_plans WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : undefined;
    });
  }

  async update(id: string, input: MigrationPlanInput): Promise<MigrationPlan | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<PlanRow>(
        `UPDATE migration_plans SET
           name = $3, source_system = $4, object_types = $5, limit_per_type = $6,
           include_associations = $7, config = $8, status = 'draft',
           revision = revision + 1, schema_hashes = '{}'::jsonb,
           preview_run_id = NULL, preview_revision = NULL,
           execution_run_id = NULL, canary_preview_run_id = NULL,
           canary_preview_revision = NULL, canary_execution_run_id = NULL,
           canary_object_type = NULL, canary_source_id = NULL,
           canary_verified_at = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          this.tenantId,
          id,
          input.name,
          input.source,
          input.types,
          input.limitPerType ?? null,
          false,
          JSON.stringify(input.config ?? {}),
        ],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : undefined;
    });
  }

  async saveValidation(
    id: string,
    revision: number,
    schemaHashes: Record<string, string>,
  ): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE migration_plans SET status = 'validated', schema_hashes = $4,
                updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND revision = $3`,
        [this.tenantId, id, revision, JSON.stringify(schemaHashes)],
      );
      return Boolean(result.rowCount);
    });
  }

  async savePreview(id: string, revision: number, runId: string): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE migration_plans SET status = 'previewed', preview_run_id = $4,
                preview_revision = $3, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND revision = $3`,
        [this.tenantId, id, revision, runId],
      );
      return Boolean(result.rowCount);
    });
  }

  async saveCanaryPreview(
    id: string,
    revision: number,
    type: CanonicalType,
    sourceId: string,
    runId: string,
  ): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE migration_plans SET canary_preview_run_id = $6,
                canary_preview_revision = $3, canary_execution_run_id = NULL,
                canary_object_type = $4, canary_source_id = $5,
                canary_verified_at = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND revision = $3`,
        [this.tenantId, id, revision, type, sourceId, runId],
      );
      return Boolean(result.rowCount);
    });
  }

  async finishCanary(id: string, revision: number, runId: string): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE migration_plans SET canary_execution_run_id = $4,
                canary_verified_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND revision = $3
           AND canary_preview_revision = revision
           AND canary_preview_run_id IS NOT NULL`,
        [this.tenantId, id, revision, runId],
      );
      return Boolean(result.rowCount);
    });
  }

  async startExecution(id: string, revision: number): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE migration_plans SET status = 'executing', updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND revision = $3
           AND preview_revision = revision AND preview_run_id IS NOT NULL`,
        [this.tenantId, id, revision],
      );
      return Boolean(result.rowCount);
    });
  }

  async finishExecution(id: string, runId: string | undefined, ok: boolean): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE migration_plans SET status = $3, execution_run_id = $4, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id, ok ? 'completed' : 'failed', runId ?? null],
      );
    });
  }
}

function mapRow(row: PlanRow): MigrationPlan {
  return {
    id: row.id,
    name: row.name,
    source: row.source_system,
    types: row.object_types,
    limitPerType: row.limit_per_type ?? undefined,
    config: row.config,
    status: row.status,
    revision: row.revision,
    schemaHashes: row.schema_hashes,
    previewRunId: row.preview_run_id ?? undefined,
    previewRevision: row.preview_revision ?? undefined,
    executionRunId: row.execution_run_id ?? undefined,
    canary:
      row.canary_preview_run_id &&
      row.canary_preview_revision !== null &&
      row.canary_object_type &&
      row.canary_source_id
        ? {
            type: row.canary_object_type,
            sourceId: row.canary_source_id,
            previewRunId: row.canary_preview_run_id,
            previewRevision: row.canary_preview_revision,
            executionRunId: row.canary_execution_run_id ?? undefined,
            verifiedAt: row.canary_verified_at?.toISOString(),
          }
        : undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
