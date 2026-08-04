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
    return result.rows[0]!;
  }

  async bySlug(slug: string): Promise<Tenant | undefined> {
    const result = await this.db.pool.query<Tenant>(
      'SELECT id, slug, name, status, plan FROM tenants WHERE slug = $1',
      [slug],
    );
    return result.rows[0];
  }
}
