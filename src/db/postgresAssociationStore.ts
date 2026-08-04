import type { AssociationLink, AssociationStore } from '../engine/associationEngine.js';
import type { PostgresDatabase } from './postgres.js';

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
}
