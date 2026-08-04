import type { CanonicalType, SchemaField, SystemId } from '../core/types.js';
import type { SchemaSnapshotStore } from '../engine/preflight.js';
import type { PostgresDatabase } from './postgres.js';

export class PostgresSchemaSnapshotStore implements SchemaSnapshotStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async save(
    system: SystemId,
    type: CanonicalType,
    hash: string,
    fields: SchemaField[],
  ): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM schema_snapshots
         WHERE tenant_id = $1 AND system = $2 AND object_type = $3 AND schema_hash = $4`,
        [this.tenantId, system, type, hash],
      );
      if (!existing.rowCount) {
        await client.query(
          `INSERT INTO schema_snapshots(
             tenant_id, system, object_type, schema_hash, fields
           ) VALUES ($1,$2,$3,$4,$5)`,
          [this.tenantId, system, type, hash, JSON.stringify(fields)],
        );
      }
    });
  }
}
