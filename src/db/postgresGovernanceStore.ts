import type {
  ConflictRecord,
  GovernanceStore,
  NewTombstone,
  StoredConflict,
  Tombstone,
} from '../engine/governanceStore.js';
import type { CanonicalRecord, ChangeEvent, SystemId } from '../core/types.js';
import type { PostgresDatabase } from './postgres.js';

interface ConflictRow {
  id: string;
  link_id: string | null;
  object_type: string;
  source_snapshot: CanonicalRecord;
  target_snapshot: CanonicalRecord;
  strategy: string;
  resolution: CanonicalRecord;
  decision: ConflictRecord['decision'] | null;
  status: StoredConflict['status'];
  resolution_source: StoredConflict['resolutionSource'];
  resolved_by: string | null;
  created_at: Date;
}

interface TombstoneRow {
  id: string;
  link_id: string;
  object_type: string;
  deleted_system: SystemId;
  deleted_source_id: string;
  target_system: SystemId;
  target_id: string | null;
  policy: Tombstone['policy'];
  approved_by: string | null;
  sync_event_id: string | null;
  created_at: Date;
  restored_at: Date | null;
  restored_by: string | null;
}

export class PostgresGovernanceStore implements GovernanceStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async recordConflict(conflict: ConflictRecord): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO conflicts(
           tenant_id, link_id, object_type, source_snapshot, target_snapshot,
           strategy, resolution, decision, status, resolved_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'resolved',now())`,
        [
          this.tenantId,
          conflict.linkId ?? null,
          conflict.type,
          JSON.stringify(conflict.source),
          JSON.stringify(conflict.target),
          conflict.strategy,
          JSON.stringify(conflict.resolution),
          conflict.decision ? JSON.stringify(conflict.decision) : null,
        ],
      );
    });
  }

  async listConflicts(limit = 100): Promise<StoredConflict[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<ConflictRow>(
        `SELECT * FROM conflicts WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [this.tenantId, Math.min(limit, 500)],
      );
      return result.rows.map(mapConflict);
    });
  }

  async getConflict(id: string): Promise<StoredConflict | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<ConflictRow>(
        `SELECT * FROM conflicts WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id],
      );
      return result.rows[0] ? mapConflict(result.rows[0]) : undefined;
    });
  }

  async resolveConflict(id: string, actorId: string | undefined, winner: SystemId): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE conflicts SET status = 'resolved', resolution_source = 'manual',
                resolved_by = $3, resolved_at = now(),
                decision = coalesce(decision, '{}'::jsonb) || jsonb_build_object('winner', $4::text)
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id, actorId ?? null, winner],
      );
      return Boolean(result.rowCount);
    });
  }

  async recordDeletion(input: {
    jobId: string;
    event: ChangeEvent;
    targetSystem: SystemId;
    targetId?: string;
    policy: 'ignore' | 'cascade' | 'manual-review';
  }): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deletion_requests(
           tenant_id, sync_event_id, source_system, object_type, source_id,
           target_id, policy, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, sync_event_id) WHERE sync_event_id IS NOT NULL
         DO UPDATE SET policy = EXCLUDED.policy`,
        [
          this.tenantId,
          input.jobId,
          input.event.system,
          input.event.type,
          input.event.sourceId,
          input.targetId ?? null,
          input.policy,
          input.policy === 'cascade' ? 'completed' : 'pending',
        ],
      );
    });
  }

  async completeDeletion(jobId: string, actorId?: string): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE deletion_requests SET status = 'completed', reviewed_by = $3,
                reviewed_at = now()
         WHERE tenant_id = $1 AND sync_event_id = $2`,
        [this.tenantId, jobId, actorId ?? null],
      );
    });
  }

  async tombstone(input: NewTombstone): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO record_tombstones(
           tenant_id, link_id, object_type, deleted_system, deleted_source_id,
           target_system, target_id, policy, approved_by, sync_event_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, link_id) WHERE restored_at IS NULL DO NOTHING`,
        [
          this.tenantId,
          input.linkId,
          input.type,
          input.deletedSystem,
          input.deletedSourceId,
          input.targetSystem,
          input.targetId ?? null,
          input.policy,
          input.approvedBy ?? null,
          input.syncEventId ?? null,
        ],
      );
    });
  }

  async activeTombstone(linkId: string): Promise<Tombstone | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<TombstoneRow>(
        `SELECT * FROM record_tombstones
         WHERE tenant_id = $1 AND link_id = $2 AND restored_at IS NULL`,
        [this.tenantId, linkId],
      );
      return result.rows[0] ? mapTombstone(result.rows[0]) : undefined;
    });
  }

  async latestTombstone(linkId: string): Promise<Tombstone | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<TombstoneRow>(
        `SELECT * FROM record_tombstones WHERE tenant_id = $1 AND link_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [this.tenantId, linkId],
      );
      return result.rows[0] ? mapTombstone(result.rows[0]) : undefined;
    });
  }

  async restoreTombstone(linkId: string, actorId?: string): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE record_tombstones SET restored_at = now(), restored_by = $3
         WHERE tenant_id = $1 AND link_id = $2 AND restored_at IS NULL`,
        [this.tenantId, linkId, actorId ?? null],
      );
      return Boolean(result.rowCount);
    });
  }

  async listTombstones(limit = 100): Promise<Tombstone[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<TombstoneRow>(
        `SELECT * FROM record_tombstones WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [this.tenantId, Math.min(limit, 500)],
      );
      return result.rows.map(mapTombstone);
    });
  }
}

function mapConflict(row: ConflictRow): StoredConflict {
  return {
    id: row.id,
    linkId: row.link_id ?? undefined,
    type: row.object_type,
    source: row.source_snapshot,
    target: row.target_snapshot,
    strategy: row.strategy,
    resolution: row.resolution,
    decision: row.decision ?? undefined,
    status: row.status,
    resolutionSource: row.resolution_source,
    resolvedBy: row.resolved_by ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

function mapTombstone(row: TombstoneRow): Tombstone {
  return {
    id: row.id,
    linkId: row.link_id,
    type: row.object_type,
    deletedSystem: row.deleted_system,
    deletedSourceId: row.deleted_source_id,
    targetSystem: row.target_system,
    targetId: row.target_id ?? undefined,
    policy: row.policy,
    approvedBy: row.approved_by ?? undefined,
    syncEventId: row.sync_event_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    restoredAt: row.restored_at?.toISOString(),
    restoredBy: row.restored_by ?? undefined,
  };
}
