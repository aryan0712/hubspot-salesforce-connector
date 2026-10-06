import type { Role } from './operationsRepository.js';
import type { PostgresDatabase } from './postgres.js';
import {
  normalizeEmail,
  type IdentityStore,
  type LoginFailureCounts,
  type Membership,
  type SessionRow,
  type UserRecord,
} from '../security/identity.js';

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  disabled_at: Date | null;
}

interface SessionDbRow {
  token_hash: string;
  user_id: string;
  tenant_id: string;
  csrf_hash: string;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  ip: string | null;
  user_agent: string | null;
}

/**
 * R11 identity persistence. users / user_sessions / login_attempts are global identity
 * tables (no tenant data); memberships live in tenant_users under tenant RLS and are read
 * either inside the tenant (membership checks) or as the user (their own workspaces only).
 */
export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly db: PostgresDatabase) {}

  async userByEmail(email: string): Promise<UserRecord | undefined> {
    const result = await this.db.pool.query<UserRow>(
      'SELECT id, email, password_hash, disabled_at FROM users WHERE lower(email) = $1',
      [normalizeEmail(email)],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  async userById(id: string): Promise<UserRecord | undefined> {
    if (!isUuid(id)) return undefined;
    const result = await this.db.pool.query<UserRow>(
      'SELECT id, email, password_hash, disabled_at FROM users WHERE id = $1',
      [id],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  async createUser(email: string, passwordHash?: string): Promise<UserRecord> {
    const result = await this.db.pool.query<UserRow>(
      `INSERT INTO users(email, password_hash) VALUES ($1, $2)
       RETURNING id, email, password_hash, disabled_at`,
      [normalizeEmail(email), passwordHash ?? null],
    );
    return mapUser(result.rows[0]!);
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
      userId,
      passwordHash,
    ]);
  }

  async membershipsOf(userId: string): Promise<Membership[]> {
    return this.db.asUser(userId, async (client) => {
      const result = await client.query<{ tenant_id: string; user_id: string; email: string; role: Role }>(
        `SELECT tu.tenant_id, tu.user_id, tu.email, tu.role
         FROM tenant_users tu JOIN tenants t ON t.id = tu.tenant_id
         WHERE tu.user_id = $1 AND t.status IN ('trial', 'active')
         ORDER BY tu.created_at`,
        [userId],
      );
      return result.rows.map(mapMembership);
    });
  }

  async membership(tenantId: string, userId: string): Promise<Membership | undefined> {
    return this.db.tenant(tenantId, async (client) => {
      const result = await client.query<{ tenant_id: string; user_id: string; email: string; role: Role }>(
        `SELECT tu.tenant_id, tu.user_id, tu.email, tu.role
         FROM tenant_users tu JOIN tenants t ON t.id = tu.tenant_id
         WHERE tu.tenant_id = $1 AND tu.user_id = $2 AND t.status IN ('trial', 'active')`,
        [tenantId, userId],
      );
      return result.rows[0] ? mapMembership(result.rows[0]) : undefined;
    });
  }

  async listMembers(tenantId: string): Promise<Membership[]> {
    return this.db.tenant(tenantId, async (client) => {
      const result = await client.query<{ tenant_id: string; user_id: string; email: string; role: Role }>(
        `SELECT tenant_id, user_id, email, role FROM tenant_users WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantId],
      );
      return result.rows.map(mapMembership);
    });
  }

  async setMembership(membership: Membership): Promise<void> {
    await this.db.tenant(membership.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_users(tenant_id, user_id, email, role) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role`,
        [membership.tenantId, membership.userId, normalizeEmail(membership.email), membership.role],
      );
    });
  }

  async removeMembership(tenantId: string, userId: string): Promise<boolean> {
    return this.db.tenant(tenantId, async (client) => {
      const result = await client.query('DELETE FROM tenant_users WHERE tenant_id = $1 AND user_id = $2', [
        tenantId,
        userId,
      ]);
      return Boolean(result.rowCount);
    });
  }

  async createSession(row: SessionRow): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO user_sessions(
         token_hash, user_id, tenant_id, csrf_hash, created_at, last_seen_at,
         idle_expires_at, expires_at, ip, user_agent
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.tokenHash,
        row.userId,
        row.tenantId,
        row.csrfHash,
        row.createdAt,
        row.lastSeenAt,
        row.idleExpiresAt,
        row.expiresAt,
        row.ip ?? null,
        row.userAgent ?? null,
      ],
    );
  }

  async session(tokenHash: string): Promise<SessionRow | undefined> {
    const result = await this.db.pool.query<SessionDbRow>('SELECT * FROM user_sessions WHERE token_hash = $1', [
      tokenHash,
    ]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      tokenHash: row.token_hash,
      userId: row.user_id,
      tenantId: row.tenant_id,
      csrfHash: row.csrf_hash,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      idleExpiresAt: row.idle_expires_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString(),
      ip: row.ip ?? undefined,
      userAgent: row.user_agent ?? undefined,
    };
  }

  async touchSession(tokenHash: string, lastSeenAt: string, idleExpiresAt: string): Promise<void> {
    await this.db.pool.query(
      `UPDATE user_sessions SET last_seen_at = $2, idle_expires_at = $3
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash, lastSeenAt, idleExpiresAt],
    );
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.db.pool.query(
      'UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash],
    );
  }

  async revokeUserSessions(userId: string, tenantId?: string): Promise<number> {
    const result = await this.db.pool.query(
      `UPDATE user_sessions SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
      [userId, tenantId ?? null],
    );
    return result.rowCount ?? 0;
  }

  async recordLoginAttempt(email: string, ip: string, succeeded: boolean): Promise<void> {
    await this.db.pool.query('INSERT INTO login_attempts(email, ip, succeeded) VALUES ($1,$2,$3)', [
      normalizeEmail(email),
      ip,
      succeeded,
    ]);
  }

  async recentFailures(email: string, ip: string, since: string): Promise<LoginFailureCounts> {
    const result = await this.db.pool.query<{ by_email_ip: string; by_email: string; by_ip: string }>(
      `SELECT
         count(*) FILTER (WHERE lower(email) = $1 AND ip = $2) AS by_email_ip,
         count(*) FILTER (WHERE lower(email) = $1) AS by_email,
         count(*) FILTER (WHERE ip = $2) AS by_ip
       FROM login_attempts
       WHERE NOT succeeded AND attempted_at >= $3 AND (lower(email) = $1 OR ip = $2)`,
      [normalizeEmail(email), ip, since],
    );
    const row = result.rows[0]!;
    return { byEmailAndIp: Number(row.by_email_ip), byEmail: Number(row.by_email), byIp: Number(row.by_ip) };
  }
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash ?? undefined,
    disabledAt: row.disabled_at?.toISOString(),
  };
}

function mapMembership(row: { tenant_id: string; user_id: string; email: string; role: Role }): Membership {
  return { tenantId: row.tenant_id, userId: row.user_id, email: row.email, role: row.role };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
