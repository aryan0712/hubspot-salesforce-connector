import { env } from '../config/env.js';
import { resolveDatabaseUrl } from '../config/runtimeSecrets.js';
import { databaseOptions } from '../config/database.js';
import { logger } from '../logger.js';
import { PostgresDatabase } from './postgres.js';
import { applyRetention } from './retention.js';

/** Applies data retention once (R14); workers also run it daily. npm run db:retention */
async function main(): Promise<void> {
  const db = new PostgresDatabase(databaseOptions(env, resolveDatabaseUrl(env), { max: 2 }));
  try {
    logger.info({ deleted: await applyRetention(db) }, 'data retention applied');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'data retention failed');
  process.exit(1);
});
