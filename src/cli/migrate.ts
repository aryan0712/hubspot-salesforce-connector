import { createApp } from '../app.js';
import { logger } from '../logger.js';
import { parseMigrationArgs } from './migrateArgs.js';

/**
 * Bulk migration CLI.
 *
 *   npm run migrate -- --from salesforce --types contact,company,deal --limit 20
 *   npm run migrate -- --from hubspot --types contact --limit 50 --dry-run
 *   npm run migrate -- --from salesforce --types contact --limit 20 --confirm
 *
 * For a full BIDIRECTIONAL seed, run it once per direction:
 *   npm run migrate -- --from salesforce --types contact,company,deal --confirm
 *   npm run migrate -- --from hubspot   --types contact,company,deal --confirm
 * The shared id map + natural-key matching means the second pass links to, rather than
 * duplicates, records created by the first.
 *
 * Safety: preview is the default. CRM writes require an explicit --confirm.
 */
async function main(): Promise<void> {
  const args = parseMigrationArgs(process.argv.slice(2));
  logger.info({ args }, 'starting migration');
  const app = await createApp();
  const report = await app.migration.run({
    from: args.from,
    types: args.types,
    limitPerType: args.limit,
    dryRun: args.dryRun,
  });
  logger.info({ report }, 'migration complete');
  process.exit(0);
}

main().catch((err) => {
  logger.fatal({ err }, 'migration failed');
  process.exit(1);
});
