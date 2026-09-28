import type { CanonicalType, SystemId } from '../core/types.js';
import type {
  AssociationLink,
  AssociationStore,
  NewPendingAssociation,
  PendingAssociation,
} from '../engine/associationEngine.js';
import type { PostgresDatabase } from './postgres.js';

interface PendingRow {
  id: string;
  system: SystemId;
  from_type: CanonicalType;
  from_source_id: string;
  to_type: CanonicalType;
  to_source_id: string;
  kind: string;
  label: string;
  status: PendingAssociation['status'];
  attempts: number;
  last_error: string | null;
  created_at: Date;
}

export class PostgresAssociationStore implements AssociationStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async upsert(link: AssociationLink): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO record_associations(
           id, tenant_id, from_link_id, to_link_id, kind, label
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, from_link_id, to_link_id, kind, label)
         DO UPDATE SET updated_at = now()`,
        [
          link.id,
          this.tenantId,
          link.fromCanonicalId,
          link.toCanonicalId,
          link.kind,
          link.label ?? '',
        ],
      );
    });
  }

  async defer(pending: NewPendingAssociation): Promise<string> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO pending_associations(
           tenant_id, system, from_type, from_source_id, to_type, to_source_id, kind, label
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, system, from_type, from_source_id, to_type, to_source_id, kind, label)
         DO UPDATE SET updated_at = pending_associations.updated_at
         RETURNING id`,
        [
          this.tenantId,
          pending.system,
          pending.fromType,
          pending.fromSourceId,
          pending.toType,
          pending.toSourceId,
          pending.kind,
          pending.label ?? '',
        ],
      );
      return result.rows[0]!.id;
    });
  }

  async pendingFor(system: SystemId, type: CanonicalType, sourceId: string): Promise<PendingAssociation[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<PendingRow>(
        `SELECT * FROM pending_associations
         WHERE tenant_id = $1 AND system = $2 AND status = 'pending'
           AND ((from_type = $3 AND from_source_id = $4) OR (to_type = $3 AND to_source_id = $4))
         ORDER BY created_at`,
        [this.tenantId, system, type, sourceId],
      );
      return result.rows.map(mapRow);
    });
  }

  async mark(id: string, status: PendingAssociation['status'], error?: string): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE pending_associations SET status = $3, attempts = attempts + 1,
                last_error = $4, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id, status, error?.slice(0, 1000) ?? null],
      );
    });
  }

  async listPending(limit = 100, status?: PendingAssociation['status']): Promise<PendingAssociation[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<PendingRow>(
        `SELECT * FROM pending_associations
         WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
         ORDER BY updated_at DESC LIMIT $3`,
        [this.tenantId, status ?? null, Math.min(limit, 500)],
      );
      return result.rows.map(mapRow);
    });
  }
}

function mapRow(row: PendingRow): PendingAssociation {
  return {
    id: row.id,
    system: row.system,
    fromType: row.from_type,
    fromSourceId: row.from_source_id,
    toType: row.to_type,
    toSourceId: row.to_source_id,
    kind: row.kind,
    label: row.label || undefined,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}
