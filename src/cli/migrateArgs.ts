import type { CanonicalType, SystemId } from '../core/types.js';

const SYSTEMS = new Set<SystemId>(['salesforce', 'hubspot']);
const TYPES = new Set<CanonicalType>(['contact', 'company', 'deal']);

export interface MigrationCliOptions {
  from: SystemId;
  types: CanonicalType[];
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

  const rawTypes = (get('--types') ?? 'contact,company,deal')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!rawTypes.length || rawTypes.some((type) => !TYPES.has(type as CanonicalType))) {
    throw new Error('--types must contain contact, company, or deal');
  }
  const types = [...new Set(rawTypes)] as CanonicalType[];

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
