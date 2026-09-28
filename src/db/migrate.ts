import { env } from '../config/env.js';
import { resolveDatabaseUrl } from '../config/runtimeSecrets.js';
import { logger } from '../logger.js';
import { PostgresDatabase, runMigrations } from './postgres.js';
import { databaseOptions } from '../config/database.js';
import { grantRuntimeRole } from './roles.js';

/**
 * Release migration step (R14): runs as the schema owner (DATABASE_MIGRATION_URL when
 * set), serialized with an advisory lock so concurrent deploys cannot race, then grants the
 * runtime role (DATABASE_URL) data privileges on anything new.
 */
async function main(): Promise<void> {
  const runtimeUrl = resolveDatabaseUrl(env);
  const db = new PostgresDatabase(databaseOptions(env, env.DATABASE_MIGRATION_URL ?? runtimeUrl, { max: 1 }));
  try {
    const applied = await runMigrations(db);
    if (env.DATABASE_MIGRATION_URL) {
      const runtime = new PostgresDatabase(databaseOptions(env, runtimeUrl, { max: 1 }));
      try {
        const role = (await runtime.pool.query<{ current_user: string }>('SELECT current_user')).rows[0]!.current_user;
        await grantRuntimeRole(db, role);
      } finally {
        await runtime.close();
      }
    }
    logger.info({ applied }, 'database is up to date');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'database migration failed');
  process.exit(1);
});
