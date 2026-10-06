import { createApp } from '../app.js';
import { logger } from '../logger.js';
import { parseMigrationArgs } from './migrateArgs.js';

/**
 * Bulk migration CLI. Writing always takes two explicit steps through the same
 * approved-plan service as the HTTP API:
 *
 *   1. Preview (the default; prints the preview run id and a summary):
 *        npm run migrate -- --from salesforce --types contact,company --limit 20
 *   2. Review that preview, then execute exactly it (at most once):
 *        npm run migrate -- --confirm --preview <previewRunId>
 *
 * Execution refuses if mappings, conflict policy, connected accounts, schemas or any
 * previewed record changed after the preview -- preview again in that case.
 *
 * For a full BIDIRECTIONAL seed, preview and execute once per direction; the shared id map
 * + natural-key matching means the second pass links to, rather than duplicates, records
 * created by the first.
 */
async function main(): Promise<void> {
  const args = parseMigrationArgs(process.argv.slice(2));
  logger.info({ args: { ...args, idempotencyKey: args.idempotencyKey ? 'set' : undefined } }, 'starting migration');
  const app = await createApp();

  if (args.previewRunId) {
    const outcome = await app.migrations.executeDirect(args.previewRunId, {
      actorId: 'cli',
      idempotencyKey: args.idempotencyKey,
    });
    logger.info(
      {
        executionId: outcome.execution.id,
        status: outcome.execution.status,
        executionRunId: outcome.execution.executionRunId,
        replayed: outcome.replayed,
        perType: outcome.report?.perType,
        writes: outcome.report?.writes,
      },
      'migration executed',
    );
    process.exit(0);
  }

  // --types omitted means "every registered object" -- resolved now that the registry
  // (populated during createApp) is available, instead of a hardcoded default list.
  const types = args.types ?? app.config.listCanonicalObjects().map((object) => object.canonicalObject);
  if (!types.length) {
    throw new Error('no canonical objects are registered; configure one before migrating');
  }
  const report = await app.migrations.preview({
    from: args.from,
    types,
    limitPerType: args.limit,
    createdBy: 'cli',
  });
  logger.info(
    { previewRunId: report.runId, perType: report.perType },
    'preview complete -- review it, then run: npm run migrate -- --confirm --preview <previewRunId>',
  );
  process.exit(0);
}

main().catch((err) => {
  logger.fatal({ err }, 'migration failed');
  process.exit(1);
});
