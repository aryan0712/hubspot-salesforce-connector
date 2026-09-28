import type { CanonicalType, SystemId } from '../core/types.js';

const SYSTEMS = new Set<SystemId>(['salesforce', 'hubspot']);

export interface MigrationCliOptions {
  from: SystemId;
  /** undefined means "--types" was omitted; the caller resolves it to every registered object. */
  types: CanonicalType[] | undefined;
  limit?: number;
  dryRun: boolean;
  /** The reviewed preview run to execute; required with --confirm. */
  previewRunId?: string;
  idempotencyKey?: string;
}

/**
 * Parse the migration CLI without performing any I/O.
 *
 * Preview is deliberately the default. Writing requires two explicit steps, matching the
 * HTTP API: preview first (prints a run id), review it, then execute exactly that preview
 * with `--confirm --preview <runId>`. `--confirm` alone is rejected -- the CLI never
 * previews and writes in one unreviewed step.
 */
export function parseMigrationArgs(argv: string[]): MigrationCliOptions {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const from = (get('--from') ?? 'salesforce') as SystemId;
  if (!SYSTEMS.has(from)) {
    throw new Error('--from must be salesforce or hubspot');
  }

  const rawTypesArg = get('--types');
  const types = rawTypesArg === undefined
    ? undefined
    : (() => {
        const parsed = [...new Set(
          rawTypesArg.split(',').map((value) => value.trim()).filter(Boolean),
        )];
        if (!parsed.length) throw new Error('--types must list at least one object');
        return parsed;
      })();

  const rawLimit = get('--limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }

  const confirm = argv.includes('--confirm');
  if (confirm && argv.includes('--dry-run')) {
    throw new Error('--confirm and --dry-run cannot be used together');
  }
  const previewRunId = get('--preview');
  if (argv.includes('--preview') && (!previewRunId || previewRunId.startsWith('--'))) {
    throw new Error('--preview requires a preview run id');
  }
  if (confirm && !previewRunId) {
    throw new Error('--confirm requires --preview <runId>: preview first, review it, then execute that preview');
  }
  if (previewRunId && !confirm) {
    throw new Error('--preview <runId> executes a reviewed preview and must be combined with --confirm');
  }
  const idempotencyKey = get('--idempotency-key');

  return {
    from,
    types,
    limit,
    dryRun: !confirm,
    ...(previewRunId ? { previewRunId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}
