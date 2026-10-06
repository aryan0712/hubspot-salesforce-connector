import crypto from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { PostgresDatabase, runMigrations } from '../../src/db/postgres.js';
import { TenantRepository } from '../../src/db/tenantRepository.js';
import { grantRuntimeRole } from '../../src/db/roles.js';

/**
 * An isolated database for one test file, created inside the suite-wide cluster started by
 * test/globalPostgres.ts. It mirrors production privileges (R11): an owner role runs the
 * schema migrations, and tests connect as a separate runtime role (NOSUPERUSER,
 * NOBYPASSRLS, owns nothing) that only has data privileges -- so row-level security is
 * exercised exactly as the deployed runtime sees it. Tests may open several independent
 * pools to model separate processes. Never points at the developer database or live data/.
 */
export interface IsolatedPostgres {
  /** The primary pool (restricted application role). */
  database: PostgresDatabase;
  /** Opens another independent pool, e.g. to model a second worker process. */
  connect(max?: number): PostgresDatabase;
  /** Connection string for the restricted runtime role. */
  url: string;
  /** Connection string for the schema-owner (migration) role. */
  ownerUrl: string;
  ensureTenant(slug: string): Promise<string>;
  stop(): Promise<void>;
}

export async function startIsolatedPostgres(opts: { migrate?: boolean } = {}): Promise<IsolatedPostgres> {
  const admin = inject('postgresAdmin');
  const suffix = crypto.randomBytes(6).toString('hex');
  const databaseName = `crm_sync_test_${suffix}`;
  const user = `crm_sync_app_${suffix}`;
  const owner = `crm_sync_owner_${suffix}`;
  const password = crypto.randomBytes(24).toString('base64url');
  const ownerPassword = crypto.randomBytes(24).toString('base64url');
  const adminClient = new pg.Client({ ...admin, database: 'postgres' });
  await adminClient.connect();
  try {
    await adminClient.query(
      `CREATE ROLE ${adminClient.escapeIdentifier(user)}
       LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await adminClient.query(
      `CREATE ROLE ${adminClient.escapeIdentifier(owner)}
       LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await adminClient.query(
      `CREATE DATABASE ${adminClient.escapeIdentifier(databaseName)}
       OWNER ${adminClient.escapeIdentifier(owner)} ENCODING 'UTF8' TEMPLATE template0`,
    );
  } finally {
    await adminClient.end();
  }

  const url =
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${admin.host}:${admin.port}/${databaseName}`;
  const ownerUrl =
    `postgresql://${encodeURIComponent(owner)}:${encodeURIComponent(ownerPassword)}` +
    `@${admin.host}:${admin.port}/${databaseName}`;
  if (opts.migrate !== false) {
    const migrator = new PostgresDatabase({ connectionString: ownerUrl, max: 1 });
    try {
      await runMigrations(migrator);
      await grantRuntimeRole(migrator, user);
    } finally {
      await migrator.close();
    }
  }
  const pools: PostgresDatabase[] = [];
  const connect = (max = 4): PostgresDatabase => {
    const pool = new PostgresDatabase({ connectionString: url, max });
    pools.push(pool);
    return pool;
  };
  const database = connect();
  const tenants = new TenantRepository(database);

  return {
    database,
    connect,
    url,
    ownerUrl,
    ensureTenant: async (slug) => (await tenants.ensure(slug)).id,
    async stop() {
      await Promise.allSettled(pools.map((pool) => pool.close()));
    },
  };
}
