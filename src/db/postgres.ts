import { promises as fs, readFileSync } from 'node:fs';
import tls from 'node:tls';
import path from 'node:path';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import { logger } from '../logger.js';

/**
 * TLS for the database connection (R14). Certificates are always verified unless a
 * non-production process explicitly opts out; `ca` is a PEM string or a path to one
 * (a managed database's CA bundle).
 */
export interface DatabaseTls {
  ca?: string;
  /** Local development only; refused in production (src/config/database.ts). */
  insecureSkipVerify?: boolean;
}

export interface DatabaseOptions {
  connectionString: string;
  /** true = TLS with certificate verification against the system CAs. */
  ssl?: boolean | DatabaseTls;
  max?: number;
  /** Abort statements that run longer than this (0 = no limit). */
  statementTimeoutMs?: number;
  /** Fail instead of waiting longer than this for a row/table/advisory lock. */
  lockTimeoutMs?: number;
  /** Give up acquiring a connection after this long. */
  connectTimeoutMs?: number;
  /** Terminate sessions left idle inside an open transaction. */
  idleInTransactionTimeoutMs?: number;
  applicationName?: string;
}

export const DEFAULT_DATABASE_TIMEOUTS = {
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 60_000,
};

export function tlsOptions(ssl: DatabaseOptions['ssl'], connectionString?: string): PoolConfig['ssl'] {
  if (!ssl) return undefined;
  if (ssl !== true && ssl.insecureSkipVerify) return { rejectUnauthorized: false };
  const ca = ssl !== true && ssl.ca && !ssl.ca.includes('-----BEGIN') ? readFileSync(ssl.ca, 'utf8') : ssl === true ? undefined : ssl.ca;
  // Verify the certificate against the host we actually connect to. node-postgres sends no
  // SNI name for IP addresses, and Node would then check the certificate against
  // "localhost" -- accepting a localhost certificate for any IP.
  const host = hostOf(connectionString);
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
    ...(host ? { checkServerIdentity: (_servername: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(host, cert) } : {}),
  };
}

function hostOf(connectionString: string | undefined): string | undefined {
  if (!connectionString) return undefined;
  try {
    return new URL(connectionString).hostname.replace(/^\[|\]$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

export class PostgresDatabase {
  readonly pool: Pool;

  constructor(opts: DatabaseOptions) {
    const timeouts = { ...DEFAULT_DATABASE_TIMEOUTS, ...stripUndefined(opts) };
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 10,
      ssl: tlsOptions(opts.ssl, opts.connectionString),
      connectionTimeoutMillis: timeouts.connectTimeoutMs || undefined,
      statement_timeout: timeouts.statementTimeoutMs || undefined,
      lock_timeout: timeouts.lockTimeoutMs || undefined,
      idle_in_transaction_session_timeout: timeouts.idleInTransactionTimeoutMs || undefined,
      application_name: opts.applicationName ?? 'crm-sync',
    });
    this.pool.on('error', (err) => logger.error({ err }, 'unexpected PostgreSQL pool error'));
  }

  async health(): Promise<{ ok: boolean; databaseTime: string }> {
    const result = await this.pool.query<{ now: Date }>('SELECT now()');
    return { ok: true, databaseTime: result.rows[0]!.now.toISOString() };
  }

  /** Pool usage for metrics. */
  poolStats(): { total: number; idle: number; waiting: number } {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount };
  }

  async tenant<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.scoped('app.tenant_id', tenantId, fn);
  }

  /**
   * A transaction that can see only this user's own memberships across workspaces
   * (tenant_users_self policy) and no tenant data. Used at sign-in (R11).
   */
  async asUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.scoped('app.user_id', userId, fn);
  }

  private async scoped<T>(
    setting: 'app.tenant_id' | 'app.user_id',
    settingValue: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [setting, settingValue]);
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const MIGRATIONS_DIR = path.resolve('db/migrations');
/** Key of the advisory lock that serializes schema migrations across processes. */
const MIGRATION_LOCK = 'crm-sync:schema-migrations';

async function migrationFiles(): Promise<string[]> {
  return (await fs.readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
}

/**
 * Applies pending migrations (R14): serialized across processes with a session advisory
 * lock (a second process waits, then finds nothing left to do), each migration in its own
 * transaction, without the runtime statement timeout (DDL on large tables may be slow).
 */
export async function runMigrations(db: PostgresDatabase): Promise<string[]> {
  const client = await db.pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SET statement_timeout = 0');
    await client.query('SET lock_timeout = 0');
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((row) => row.version),
    );
    for (const file of await migrationFiles()) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        logger.info({ migration: file }, 'PostgreSQL migration applied');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

/** Migrations present in this build but not applied to the database (readiness). */
export async function pendingMigrations(db: PostgresDatabase): Promise<string[]> {
  const files = await migrationFiles();
  const result = await db.pool
    .query<{ version: string }>('SELECT version FROM schema_migrations')
    .catch(() => ({ rows: [] as { version: string }[] }));
  const applied = new Set(result.rows.map((row) => row.version));
  return files.filter((file) => !applied.has(file));
}

export async function one<T extends QueryResultRow>(
  result: QueryResult<T>,
): Promise<T | undefined> {
  return result.rows[0];
}
