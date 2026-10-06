import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { PostgresDatabase, pendingMigrations, runMigrations } from '../src/db/postgres.js';
import { databaseOptions, UnsafeDatabaseConfigError } from '../src/config/database.js';
import { startIsolatedPostgres, type IsolatedPostgres } from './helpers/postgres.js';

/** R14: database timeouts, serialized migrations and verified TLS, demonstrated. */

const env = {
  NODE_ENV: 'production' as const,
  DATABASE_SSL: false,
  DATABASE_SSL_CA: undefined,
  DATABASE_SSL_INSECURE: false,
  DATABASE_POOL_MAX: 5,
  DATABASE_STATEMENT_TIMEOUT_MS: 30_000,
  DATABASE_LOCK_TIMEOUT_MS: 10_000,
};

describe('R14 timeouts and migrations', () => {
  let pg: IsolatedPostgres;
  const pools: PostgresDatabase[] = [];
  const open = (url: string, options: Partial<ConstructorParameters<typeof PostgresDatabase>[0]> = {}) => {
    const db = new PostgresDatabase({ connectionString: url, max: 2, ...options });
    pools.push(db);
    return db;
  };

  beforeAll(async () => {
    pg = await startIsolatedPostgres({ migrate: false });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(pools.map((pool) => pool.close()));
    await pg?.stop();
  });

  it('serializes concurrent migration runs: each migration is applied exactly once', async () => {
    const [first, second] = await Promise.all([runMigrations(open(pg.ownerUrl)), runMigrations(open(pg.ownerUrl))]);
    const files = (await fs.readdir(path.resolve('db/migrations'))).filter((file) => file.endsWith('.sql'));
    // One process applied everything; the other waited for the lock and found nothing to do.
    expect([...first, ...second].sort()).toEqual(files.sort());
    expect(Math.min(first.length, second.length)).toBe(0);
    expect(await pendingMigrations(open(pg.ownerUrl))).toEqual([]);
  });

  it('aborts statements that exceed the statement timeout', async () => {
    const db = open(pg.ownerUrl, { statementTimeoutMs: 300 });
    await expect(db.pool.query('SELECT pg_sleep(2)')).rejects.toMatchObject({ code: '57014' });
  });

  it('fails fast instead of waiting behind a held lock', async () => {
    const holder = open(pg.ownerUrl);
    const waiter = open(pg.ownerUrl, { lockTimeoutMs: 300 });
    await holder.pool.query(`INSERT INTO tenants(slug, name) VALUES ('lock-test', 'Lock test') ON CONFLICT DO NOTHING`);
    const client = await holder.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT * FROM tenants WHERE slug = 'lock-test' FOR UPDATE`);
      const started = Date.now();
      await expect(waiter.pool.query(`UPDATE tenants SET name = 'x' WHERE slug = 'lock-test'`)).rejects.toMatchObject({
        code: '55P03',
      });
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('terminates sessions left idle inside a transaction', async () => {
    const db = open(pg.ownerUrl, { idleInTransactionTimeoutMs: 300 });
    const client = await db.pool.connect();
    client.on('error', () => undefined);
    try {
      await client.query('BEGIN');
      await new Promise((resolve) => setTimeout(resolve, 800));
      await expect(client.query('SELECT 1')).rejects.toThrow();
    } finally {
      client.release(true);
    }
  });

  it('refuses unverified TLS in production configuration', () => {
    expect(() => databaseOptions({ ...env, DATABASE_SSL: true, DATABASE_SSL_INSECURE: true }, 'postgres://x')).toThrow(
      UnsafeDatabaseConfigError,
    );
    expect(databaseOptions({ ...env, DATABASE_SSL: true }, 'postgres://x').ssl).toEqual({ ca: undefined, insecureSkipVerify: false });
    expect(databaseOptions({ ...env, NODE_ENV: 'development', DATABASE_SSL: true, DATABASE_SSL_INSECURE: true }, 'postgres://x').ssl).toEqual({
      ca: undefined,
      insecureSkipVerify: true,
    });
  });
});

describe('R14 database TLS certificate verification', () => {
  let cluster: EmbeddedPostgres | undefined;
  let dir: string;
  let port: number;
  let caPem: string;
  const user = 'tls_admin';
  const password = crypto.randomBytes(12).toString('hex');

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-sync-tls-'));
    // A self-signed server certificate for "localhost" (stands in for a managed DB's CA).
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
      '-keyout', path.join(dir, 'server.key'), '-out', path.join(dir, 'server.crt'),
    ], { stdio: 'ignore' });
    caPem = await fs.readFile(path.join(dir, 'server.crt'), 'utf8');
    port = await freePort();
    cluster = new EmbeddedPostgres({
      databaseDir: path.join(dir, 'data'),
      user,
      password,
      port,
      persistent: false,
      authMethod: 'scram-sha-256',
      postgresFlags: [
        '-c', 'ssl=on',
        '-c', `ssl_cert_file=${path.join(dir, 'server.crt').replace(/\\/g, '/')}`,
        '-c', `ssl_key_file=${path.join(dir, 'server.key').replace(/\\/g, '/')}`,
      ],
      onLog: () => undefined,
      onError: () => undefined,
    });
    await cluster.initialise();
    await cluster.start();
  }, 120_000);

  afterAll(async () => {
    await cluster?.stop().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  });

  const url = () => `postgresql://${user}:${password}@localhost:${port}/postgres`;
  const attempt = async (ssl: ConstructorParameters<typeof PostgresDatabase>[0]['ssl']) => {
    const db = new PostgresDatabase({ connectionString: url(), ssl, max: 1, connectTimeoutMs: 5000 });
    try {
      return (await db.pool.query<{ ssl: boolean }>('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0]!.ssl;
    } finally {
      await db.close();
    }
  };

  it('rejects a server certificate it cannot verify', async () => {
    await expect(attempt(true)).rejects.toThrow(/self[- ]signed certificate/i);
  });

  it('connects over verified TLS with the right CA', async () => {
    expect(await attempt({ ca: caPem })).toBe(true);
  });

  it('rejects a certificate for another host even with the right CA', async () => {
    const db = new PostgresDatabase({
      connectionString: url().replace('@localhost:', '@127.0.0.1:'),
      ssl: { ca: caPem },
      max: 1,
      connectTimeoutMs: 5000,
    });
    try {
      await expect(db.pool.query('SELECT 1')).rejects.toThrow(/Hostname\/IP does not match|altnames/i);
    } finally {
      await db.close();
    }
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
