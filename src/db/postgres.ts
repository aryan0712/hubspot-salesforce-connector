import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { logger } from '../logger.js';

export interface DatabaseOptions {
  connectionString: string;
  ssl?: boolean;
  max?: number;
}

export class PostgresDatabase {
  readonly pool: Pool;

  constructor(opts: DatabaseOptions) {
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 10,
      ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
    });
    this.pool.on('error', (err) => logger.error({ err }, 'unexpected PostgreSQL pool error'));
  }

  async health(): Promise<{ ok: boolean; databaseTime: string }> {
    const result = await this.pool.query<{ now: Date }>('SELECT now()');
    return { ok: true, databaseTime: result.rows[0]!.now.toISOString() };
  }

  async tenant<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function runMigrations(db: PostgresDatabase): Promise<void> {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const dir = path.resolve('db/migrations');
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = await db.pool.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [file],
    );
    if (applied.rowCount) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info({ migration: file }, 'PostgreSQL migration applied');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function one<T extends QueryResultRow>(
  result: QueryResult<T>,
): Promise<T | undefined> {
  return result.rows[0];
}
