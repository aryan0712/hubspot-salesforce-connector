import { env } from '../config/env.js';
import { createCipher, resolveDatabaseUrl } from '../config/runtimeSecrets.js';
import { databaseOptions } from '../config/database.js';
import { logger } from '../logger.js';
import { PostgresDatabase } from './postgres.js';
import { rotateSecrets } from './rotateSecrets.js';

/**
 * Re-encrypts stored secrets under the current APP_ENCRYPTION_KEY (R14). Dry run unless
 * --confirm is passed. Never touches data/*.json or data/.encryption-key.
 *
 *   npm run secrets:rotate            # report what would change
 *   npm run secrets:rotate -- --confirm
 */
async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const db = new PostgresDatabase(databaseOptions(env, resolveDatabaseUrl(env), { max: 2 }));
  try {
    const report = await rotateSecrets(db, createCipher(env), { dryRun: !confirm });
    logger.info({ ...report, dryRun: !confirm }, confirm ? 'secrets re-encrypted' : 'dry run: secrets that would be re-encrypted');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'secret rotation failed');
  process.exit(1);
});
