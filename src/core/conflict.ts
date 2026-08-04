import type { CanonicalRecord, FieldValue, SystemId } from './types.js';
import { env } from '../config/env.js';

/**
 * CONFLICT RESOLUTION
 * -------------------
 * When both systems changed "the same" record since we last reconciled, we must decide
 * what the merged truth is. Strategy is configurable (env.CONFLICT_STRATEGY):
 *
 *   source-of-truth : one system always wins wholesale (env.SOURCE_OF_TRUTH).
 *   last-write-wins : the record with the newer meta.modifiedAt wins wholesale.
 *   field-merge     : per-field, newer modifiedAt wins; non-null beats null on ties.
 *
 * Input: the two competing canonical snapshots (may be undefined if one side is new).
 * Output: the winning canonical record to write to BOTH systems.
 */

export interface Resolution {
  winner: CanonicalRecord;
  reason: string;
}

export type ConflictStrategy = 'source-of-truth' | 'last-write-wins' | 'field-merge';

export interface ResolveOptions {
  strategy?: ConflictStrategy;
  sourceOfTruth?: SystemId;
  fieldOwners?: Record<string, SystemId>;
}

/**
 * Resolve two competing snapshots. Options default to the configured env values, but can be
 * overridden explicitly — which keeps this function pure and unit-testable per strategy.
 */
export function resolve(
  a: CanonicalRecord | undefined,
  b: CanonicalRecord | undefined,
  opts: ResolveOptions = {},
): Resolution {
  if (a && !b) return { winner: a, reason: 'only-a' };
  if (b && !a) return { winner: b, reason: 'only-b' };
  if (!a || !b) throw new Error('resolve() requires at least one record');

  const strategy = opts.strategy ?? env.CONFLICT_STRATEGY;
  const sourceOfTruth = opts.sourceOfTruth ?? env.SOURCE_OF_TRUTH;

  switch (strategy) {
    case 'source-of-truth': {
      const winner = pickBySystem(a, b, sourceOfTruth);
      return { winner, reason: `source-of-truth:${sourceOfTruth}` };
    }
    case 'last-write-wins': {
      const winner = newer(a, b);
      return { winner, reason: 'last-write-wins' };
    }
    case 'field-merge': {
      return { winner: fieldMerge(a, b, opts.fieldOwners), reason: 'field-merge' };
    }
    default:
      return { winner: newer(a, b), reason: 'default-lww' };
  }
}

function pickBySystem(a: CanonicalRecord, b: CanonicalRecord, system: SystemId): CanonicalRecord {
  return a.meta.source === system ? a : b;
}

function newer(a: CanonicalRecord, b: CanonicalRecord): CanonicalRecord {
  return Date.parse(a.meta.modifiedAt) >= Date.parse(b.meta.modifiedAt) ? a : b;
}

/**
 * Per-field merge. Both snapshots represent the same canonical record; we build a new
 * field set choosing, for each field, the value from the record with the newer timestamp,
 * unless that value is null and the other is non-null (avoid clobbering data with blanks).
 */
function fieldMerge(
  a: CanonicalRecord,
  b: CanonicalRecord,
  fieldOwners: Record<string, SystemId> = {},
): CanonicalRecord {
  const primary = newer(a, b);
  const secondary = primary === a ? b : a;
  const fields: Record<string, FieldValue> = {};
  const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
  for (const key of keys) {
    const owner = fieldOwners[key];
    if (owner) {
      const owned = a.meta.source === owner ? a : b;
      const fallback = owned === a ? b : a;
      fields[key] = owned.fields[key] ?? fallback.fields[key] ?? null;
      continue;
    }
    const pv = primary.fields[key] ?? null;
    const sv = secondary.fields[key] ?? null;
    fields[key] = pv !== null ? pv : sv;
  }
  return { ...primary, fields };
}
