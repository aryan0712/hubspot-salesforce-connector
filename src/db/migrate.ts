import { env } from '../config/env.js';
import { resolveDatabaseUrl } from '../config/runtimeSecrets.js';
import { logger } from '../logger.js';
import { PostgresDatabase, runMigrations } from './postgres.js';

async function main(): Promise<void> {
  const db = new PostgresDatabase({
    connectionString: resolveDatabaseUrl(env),
    ssl: env.DATABASE_SSL,
  });
  try {
    await runMigrations(db);
    logger.info('database is up to date');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'database migration failed');
  process.exit(1);
});
