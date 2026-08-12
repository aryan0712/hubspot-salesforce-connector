import { DEFAULT_OBJECTS } from '../core/defaultObjects.js';
import type { PostgresDatabase } from './postgres.js';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: 'trial' | 'active' | 'suspended' | 'closed';
  plan: string;
}

export class TenantRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async ensure(slug: string, name = 'Local workspace'): Promise<Tenant> {
    const result = await this.db.pool.query<Tenant>(
      `INSERT INTO tenants(slug, name, status, plan)
       VALUES ($1, $2, 'trial', 'developer')
       ON CONFLICT (slug) DO UPDATE SET updated_at = now()
       RETURNING id, slug, name, status, plan`,
      [slug, name],
    );
    const tenant = result.rows[0]!;
    // Idempotent: a migration backfills existing tenants, this covers every tenant created
    // after that migration ran (ON CONFLICT DO NOTHING makes repeat calls on boot a no-op).
    await this.seedDefaultObjects(tenant.id);
    return tenant;
  }

  private async seedDefaultObjects(tenantId: string): Promise<void> {
    await this.db.tenant(tenantId, async (client) => {
      for (const object of DEFAULT_OBJECTS) {
        await client.query(
          `INSERT INTO object_mappings(
             tenant_id, canonical_object, label, salesforce_object, hubspot_object, natural_key_fields
           ) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, canonical_object) DO NOTHING`,
          [
            tenantId,
            object.canonicalObject,
            object.label,
            object.salesforceObject,
            object.hubspotObject,
            object.naturalKeyFields,
          ],
        );
        for (const system of ['salesforce', 'hubspot'] as const) {
          await client.query(
            `INSERT INTO field_mapping_sets(tenant_id, system, object_type)
             VALUES ($1,$2,$3)
             ON CONFLICT (tenant_id, system, object_type) DO NOTHING`,
            [tenantId, system, object.canonicalObject],
          );
          for (const [index, rule] of object.fieldRules[system].entries()) {
            await client.query(
              `INSERT INTO field_mappings(
                 tenant_id, system, object_type, canonical_field, native_field,
                 to_canonical_transform, read_only, sort_order
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (tenant_id, system, object_type, canonical_field) DO NOTHING`,
              [
                tenantId,
                system,
                object.canonicalObject,
                rule.canonical,
                rule.native,
                rule.toCanonical ?? null,
                rule.readOnly ?? false,
                index,
              ],
            );
          }
        }
      }
    });
  }

  async bySlug(slug: string): Promise<Tenant | undefined> {
    const result = await this.db.pool.query<Tenant>(
      'SELECT id, slug, name, status, plan FROM tenants WHERE slug = $1',
      [slug],
    );
    return result.rows[0];
  }
}
