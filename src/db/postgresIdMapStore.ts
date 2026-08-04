import type { PoolClient } from 'pg';
import type { CanonicalType, SystemId } from '../core/types.js';
import type { IdMapStore, Link } from '../core/idMap.js';
import type { PostgresDatabase } from './postgres.js';

interface LinkRow {
  canonical_id: string;
  object_type: CanonicalType;
  updated_at: Date;
  system: SystemId | null;
  native_id: string | null;
  content_hash: string | null;
  source_modified_at: Date | null;
}

export class PostgresIdMapStore implements IdMapStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async init(): Promise<void> {
    // Schema initialization is owned by runMigrations().
  }

  async bySource(system: SystemId, sourceId: string): Promise<Link | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const id = await client.query<{ link_id: string }>(
        `SELECT link_id FROM record_link_sides
         WHERE tenant_id = $1 AND system = $2 AND native_id = $3`,
        [this.tenantId, system, sourceId],
      );
      return id.rows[0] ? this.load(client, id.rows[0].link_id) : undefined;
    });
  }

  async byNaturalKey(type: CanonicalType, key: string): Promise<Link | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const id = await client.query<{ link_id: string }>(
        `SELECT link_id FROM record_natural_keys
         WHERE tenant_id = $1 AND object_type = $2 AND natural_key = $3`,
        [this.tenantId, type, key],
      );
      return id.rows[0] ? this.load(client, id.rows[0].link_id) : undefined;
    });
  }

  async upsertLink(link: Link): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO record_links(id, tenant_id, object_type, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (id) DO UPDATE SET object_type = EXCLUDED.object_type, updated_at = now()`,
        [link.canonicalId, this.tenantId, link.type],
      );
      for (const system of ['salesforce', 'hubspot'] as const) {
        const nativeId = link.ids[system];
        if (!nativeId) continue;
        await client.query(
          `INSERT INTO record_link_sides(
             tenant_id, link_id, system, native_id, content_hash, source_modified_at
           ) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, link_id, system) DO UPDATE SET
             native_id = EXCLUDED.native_id,
             content_hash = EXCLUDED.content_hash,
             source_modified_at = EXCLUDED.source_modified_at`,
          [
            this.tenantId,
            link.canonicalId,
            system,
            nativeId,
            link.hashes[system] ?? null,
            link.modifiedAt[system] ?? null,
          ],
        );
      }
      for (const key of link.naturalKeys ?? []) {
        await client.query(
          `INSERT INTO record_natural_keys(tenant_id, object_type, natural_key, link_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, object_type, natural_key)
           DO UPDATE SET link_id = EXCLUDED.link_id`,
          [this.tenantId, link.type, key, link.canonicalId],
        );
      }
    });
  }

  private async load(client: PoolClient, linkId: string): Promise<Link | undefined> {
    const rows = await client.query<LinkRow>(
      `SELECT l.id AS canonical_id, l.object_type, l.updated_at,
              s.system, s.native_id, s.content_hash, s.source_modified_at
       FROM record_links l
       LEFT JOIN record_link_sides s
         ON s.tenant_id = l.tenant_id AND s.link_id = l.id
       WHERE l.tenant_id = $1 AND l.id = $2`,
      [this.tenantId, linkId],
    );
    if (!rows.rows.length) return undefined;
    const keys = await client.query<{ natural_key: string }>(
      `SELECT natural_key FROM record_natural_keys
       WHERE tenant_id = $1 AND link_id = $2 ORDER BY natural_key`,
      [this.tenantId, linkId],
    );
    const first = rows.rows[0]!;
    const link: Link = {
      canonicalId: first.canonical_id,
      type: first.object_type,
      ids: {},
      hashes: {},
      modifiedAt: {},
      naturalKeys: keys.rows.map((row) => row.natural_key),
      updatedAt: first.updated_at.toISOString(),
    };
    for (const row of rows.rows) {
      if (!row.system || !row.native_id) continue;
      link.ids[row.system] = row.native_id;
      if (row.content_hash) link.hashes[row.system] = row.content_hash;
      if (row.source_modified_at) {
        link.modifiedAt[row.system] = row.source_modified_at.toISOString();
      }
    }
    return link;
  }
}
