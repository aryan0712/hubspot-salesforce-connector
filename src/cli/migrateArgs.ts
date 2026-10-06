import type { CanonicalType, SystemId } from '../core/types.js';

const SYSTEMS = new Set<SystemId>(['salesforce', 'hubspot']);

export interface MigrationCliOptions {
  from: SystemId;
  /** undefined means "--types" was omitted; the caller resolves it to every registered object. */
  types: CanonicalType[] | undefined;
  limit?: number;
  dryRun: boolean;
}

/**
 * Parse the migration CLI without performing any I/O.
 *
 * Preview is deliberately the default. A caller must pass --confirm to permit
 * CRM writes, mirroring the explicit confirmation required by the HTTP API.
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

  if (argv.includes('--confirm') && argv.includes('--dry-run')) {
    throw new Error('--confirm and --dry-run cannot be used together');
  }

  return {
    from,
    types,
    limit,
    dryRun: !argv.includes('--confirm'),
  };
}
