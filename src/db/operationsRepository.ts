import crypto from 'node:crypto';
import type { ActivityEntry } from '../observability/activity.js';
import type { PostgresDatabase } from './postgres.js';

export type Role = 'owner' | 'admin' | 'operator' | 'viewer';

export interface AuditEntry {
  id: string;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  correlationId?: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export class PostgresOperationsRepository {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async recordAudit(input: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO audit_entries(
           tenant_id, actor_id, action, resource_type, resource_id,
           correlation_id, detail
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          this.tenantId,
          input.actorId ?? null,
          input.action,
          input.resourceType,
          input.resourceId ?? null,
          input.correlationId ?? null,
          JSON.stringify(input.detail),
        ],
      );
    });
  }

  async recordActivity(entry: ActivityEntry): Promise<void> {
    await this.recordAudit({
      action: entry.kind,
      resourceType: 'activity',
      detail: { message: entry.message, at: entry.at },
    });
    const metric =
      entry.kind === 'sync'
        ? 'records_synced'
        : entry.kind === 'conflict'
          ? 'conflicts'
          : entry.kind === 'error'
            ? 'errors'
            : undefined;
    if (metric) await this.incrementUsage(metric, 1);
  }

  async listAudit(limit = 100): Promise<AuditEntry[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{
        id: string;
        actor_id: string | null;
        action: string;
        resource_type: string;
        resource_id: string | null;
        correlation_id: string | null;
        detail: Record<string, unknown>;
        created_at: Date;
      }>(
        `SELECT id::text, actor_id, action, resource_type, resource_id,
                correlation_id, detail, created_at
         FROM audit_entries WHERE tenant_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [this.tenantId, limit],
      );
      return result.rows.map((row) => ({
        id: row.id,
        actorId: row.actor_id ?? undefined,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id ?? undefined,
        correlationId: row.correlation_id ?? undefined,
        detail: row.detail,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  async incrementUsage(metric: string, quantity: number): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO usage_counters(tenant_id, metric, period_start, quantity)
         VALUES ($1,$2,date_trunc('month', now())::date,$3)
         ON CONFLICT (tenant_id, metric, period_start) DO UPDATE SET
           quantity = usage_counters.quantity + EXCLUDED.quantity,
           updated_at = now()`,
        [this.tenantId, metric, quantity],
      );
    });
  }

  async usage(): Promise<Record<string, number>> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{ metric: string; quantity: string }>(
        `SELECT metric, quantity::text FROM usage_counters
         WHERE tenant_id = $1 AND period_start = date_trunc('month', now())::date`,
        [this.tenantId],
      );
      return Object.fromEntries(result.rows.map((row) => [row.metric, Number(row.quantity)]));
    });
  }

  async workspaceOverview(): Promise<{
    plan: string;
    status: string;
    currentPeriodEnd?: string;
    limits: Record<string, number>;
    team: Array<{ email: string; role: Role; createdAt: string }>;
  }> {
    return this.db.tenant(this.tenantId, async (client) => {
      const [tenant, subscription, team] = await Promise.all([
        client.query<{ plan: string; status: string }>(
          'SELECT plan, status FROM tenants WHERE id = $1',
          [this.tenantId],
        ),
        client.query<{
          plan: string;
          status: string;
          limits: Record<string, number>;
          current_period_end: Date | null;
        }>(
          `SELECT plan, status, limits, current_period_end
           FROM subscriptions WHERE tenant_id = $1`,
          [this.tenantId],
        ),
        client.query<{ email: string; role: Role; created_at: Date }>(
          `SELECT email, role, created_at FROM tenant_users
           WHERE tenant_id = $1 ORDER BY created_at`,
          [this.tenantId],
        ),
      ]);
      const base = tenant.rows[0] ?? { plan: 'trial', status: 'active' };
      const billing = subscription.rows[0];
      return {
        plan: billing?.plan ?? base.plan,
        status: billing?.status ?? base.status,
        currentPeriodEnd: billing?.current_period_end?.toISOString(),
        limits: billing?.limits ?? {},
        team: team.rows.map((row) => ({
          email: row.email,
          role: row.role,
          createdAt: row.created_at.toISOString(),
        })),
      };
    });
  }

  async quota(
    metric: string,
    requested = 0,
  ): Promise<{ allowed: boolean; used: number; limit?: number }> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{
        used: string;
        limit_value: string | null;
      }>(
        `SELECT
           coalesce((
             SELECT quantity FROM usage_counters
             WHERE tenant_id = $1 AND metric = $2
               AND period_start = date_trunc('month', now())::date
           ), 0)::text AS used,
           (
             SELECT limits ->> $2 FROM subscriptions WHERE tenant_id = $1
           ) AS limit_value`,
        [this.tenantId, metric],
      );
      const used = Number(result.rows[0]?.used ?? 0);
      const limit =
        result.rows[0]?.limit_value === null ||
        result.rows[0]?.limit_value === undefined
          ? undefined
          : Number(result.rows[0].limit_value);
      return {
        allowed: limit === undefined || used + requested <= limit,
        used,
        limit,
      };
    });
  }
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  role: Exclude<Role, 'owner'>;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export class PostgresApiKeyRepository {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async create(name: string, role: Exclude<Role, 'owner'>): Promise<ApiKeyInfo & { key: string }> {
    const key = `crm_${crypto.randomBytes(32).toString('base64url')}`;
    const prefix = key.slice(0, 12);
    const hash = hashKey(key);
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO api_keys(tenant_id, name, key_prefix, key_hash, role)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
        [this.tenantId, name, prefix, hash, role],
      );
      return {
        id: result.rows[0]!.id,
        name,
        prefix,
        role,
        key,
        createdAt: result.rows[0]!.created_at.toISOString(),
      };
    });
  }

  async verify(key: string): Promise<{ id: string; role: Exclude<Role, 'owner'> } | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{ id: string; role: Exclude<Role, 'owner'> }>(
        `UPDATE api_keys SET last_used_at = now()
         WHERE tenant_id = $1 AND key_hash = $2 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
         RETURNING id, role`,
        [this.tenantId, hashKey(key)],
      );
      return result.rows[0];
    });
  }

  async list(): Promise<ApiKeyInfo[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{
        id: string;
        name: string;
        key_prefix: string;
        role: Exclude<Role, 'owner'>;
        created_at: Date;
        last_used_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT id, name, key_prefix, role, created_at, last_used_at, revoked_at
         FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [this.tenantId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.key_prefix,
        role: row.role,
        createdAt: row.created_at.toISOString(),
        lastUsedAt: row.last_used_at?.toISOString(),
        revokedAt: row.revoked_at?.toISOString(),
      }));
    });
  }

  async revoke(id: string): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        'UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND id = $2',
        [this.tenantId, id],
      );
    });
  }
}

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}
