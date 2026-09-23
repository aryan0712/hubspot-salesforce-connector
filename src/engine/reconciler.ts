import type { CRMConnector } from '../core/connector.js';
import type { CanonicalRecord, ChangeEvent, SystemId, UpsertResult } from '../core/types.js';
import {
  contentHash,
  naturalKeyFields,
  naturalKeyQuery,
  newCanonicalId,
  type IdMapStore,
  type Link,
} from '../core/idMap.js';
import { resolve } from '../core/conflict.js';
import type { ResolveOptions } from '../core/conflict.js';
import { logger } from '../logger.js';
import type { ActivityLog } from '../observability/activity.js';
import type { CanonicalType, FieldValue } from '../core/types.js';
import { fieldRules, fromCanonicalFields } from '../core/mapping.js';
import { extractDuplicateValueConflict, MissingRequiredFieldError } from '../core/vendorError.js';
import type { GovernanceStore } from './governanceStore.js';
import type { SchemaField } from '../core/types.js';

export type PlannedAction =
  | 'create'
  | 'update'
  | 'match'
  | 'skip'
  | 'conflict'
  | 'ambiguous'
  /** The write was attempted (or couldn't even be planned) and failed; see warnings for why. */
  | 'error';

export interface FieldDiff {
  field: string;
  source: FieldValue | undefined;
  target: FieldValue | undefined;
}

export interface ReconcilePlan {
  canonicalId?: string;
  type: CanonicalType;
  from: SystemId;
  to: SystemId;
  sourceId: string;
  targetId?: string;
  naturalKey?: string;
  action: PlannedAction;
  fieldDiff: FieldDiff[];
  warnings: string[];
}

export class AmbiguousNaturalKeyError extends Error {
  constructor(
    readonly plan: ReconcilePlan,
  ) {
    super(`ambiguous target match for ${plan.type} ${plan.naturalKey ?? ''}`.trim());
    this.name = 'AmbiguousNaturalKeyError';
  }
}

/**
 * The Reconciler is the single place where a change becomes agreement across systems.
 * Both the migration engine (bulk) and the sync engine (real-time) funnel through
 * reconcile(). That guarantees migration and live sync can never drift in behavior.
 *
 * Given a canonical snapshot from ONE system, it:
 *   1. locates (or creates) the cross-system Link via id map / natural key,
 *   2. drops echoes (changes we ourselves just wrote) using content hashes,
 *   3. resolves conflicts against the counterpart record,
 *   4. writes the winner to the counterpart system,
 *   5. records new hashes so the resulting webhook is recognized as an echo.
 */
const SCHEMA_CACHE_TTL_MS = 5 * 60_000;

export class Reconciler {
  private readonly schemaCache = new Map<string, { fields: SchemaField[]; fetchedAt: number }>();

  constructor(
    private readonly connectors: Record<SystemId, CRMConnector>,
    private readonly idMap: IdMapStore,
    private readonly opts: {
      readCounterpartForConflict?: boolean;
      activity?: ActivityLog;
      governance?: GovernanceStore;
      conflictOptions?: () => Pick<ResolveOptions, 'strategy' | 'sourceOfTruth'>;
    } = {},
  ) {}

  private other(system: SystemId): SystemId {
    return system === 'salesforce' ? 'hubspot' : 'salesforce';
  }

  async reconcile(source: CanonicalRecord): Promise<void> {
    const from = source.meta.source;
    const to = this.other(from);
    const incomingHash = contentHash(source.fields);

    const link = await this.findOrCreateLink(source);

    // (2) Echo suppression: if the incoming content equals what we last recorded for this
    // system, this change originated from our own write. Ignore it to break the loop.
    if (link.hashes[from] === incomingHash) {
      logger.debug({ canonicalId: link.canonicalId, from }, 'echo suppressed');
      this.opts.activity?.record({
        kind: 'echo-suppressed',
        message: `Echo from ${from} suppressed (${link.canonicalId.slice(0, 8)})`,
      });
      return;
    }
    source.canonicalId = link.canonicalId;

    // (3) Conflict resolution against the counterpart's current state.
    let winner: CanonicalRecord = source;
    let targetId = link.ids[to];
    if ((this.opts.readCounterpartForConflict ?? true) && targetId) {
      const counterpart = await this.connectors[to].read(source.type, targetId);
      if (counterpart) {
        const changedSinceLastSync =
          contentHash(counterpart.fields) !== link.hashes[to];
        if (changedSinceLastSync) {
          const owners = Object.fromEntries(
            [...fieldRules('salesforce', source.type), ...fieldRules('hubspot', source.type)]
              .filter((rule) => rule.sourceOfTruth)
              .map((rule) => [rule.canonical, rule.sourceOfTruth!]),
          );
          const res = resolve(source, counterpart, {
            ...this.opts.conflictOptions?.(),
            fieldOwners: owners,
          });
          winner = res.winner;
          await this.opts.governance?.recordConflict({
            linkId: link.canonicalId,
            type: source.type,
            source,
            target: counterpart,
            strategy: res.reason,
            resolution: winner,
          });
          logger.info(
            { canonicalId: link.canonicalId, reason: res.reason },
            'conflict resolved',
          );
          this.opts.activity?.record({
            kind: 'conflict',
            message: `Conflict on ${source.type} resolved via ${res.reason}`,
          });
        }
      }
    }

    // (4) Before writing, check the payload against the target's own required fields. A
    // vendor rejects this too, but only as a generic 400 -- catching it here first produces
    // an unmistakable error and skips a network call that was always going to fail.
    await this.checkRequiredFields(to, winner);

    // (5) Write the winner to the counterpart system. If the write fails because another
    // record over there already owns the natural-key value we're setting (a stale link, or
    // a duplicate findByNaturalKey missed on first sync), self-heal: re-point to the record
    // the target system itself just confirmed owns that value and retry against it, instead
    // of failing outright and waiting on manual review. Only for a field actually configured
    // as this object's natural key -- a collision on some other unique field isn't a safe
    // signal that the two records are the same person/company/deal.
    let result: UpsertResult;
    try {
      result = await this.connectors[to].upsert(winner, targetId);
    } catch (err) {
      const conflict = extractDuplicateValueConflict(err);
      const conflictField = conflict && nativeToNaturalKeyField(to, source.type, conflict.property);
      if (conflict && conflictField && conflict.conflictingId !== targetId) {
        logger.warn(
          {
            canonicalId: link.canonicalId,
            from,
            to,
            previousTargetId: targetId,
            conflictingId: conflict.conflictingId,
            field: conflictField,
          },
          'natural-key conflict on write -- re-linking to the existing record',
        );
        targetId = conflict.conflictingId;
        result = await this.connectors[to].upsert(winner, targetId);
        this.opts.activity?.record({
          kind: 'info',
          message: `${source.type}: re-linked to an existing ${to} record on matching "${conflictField}" (the previous link was stale)`,
        });
      } else {
        throw err;
      }
    }
    link.ids[to] = result.targetId;
    link.hashes[to] = contentHash(winner.fields);
    link.modifiedAt[to] = new Date().toISOString();

    // If a merge produced a value different from the source, write back so both agree.
    if (winner !== source && contentHash(winner.fields) !== incomingHash && link.ids[from]) {
      await this.connectors[from].upsert(winner, link.ids[from]);
      link.hashes[from] = contentHash(winner.fields);
    } else {
      link.hashes[from] = incomingHash;
    }
    link.ids[from] = source.meta.sourceId;
    link.modifiedAt[from] = source.meta.modifiedAt;

    await this.idMap.upsertLink(link);
    logger.debug(
      { canonicalId: link.canonicalId, from, to, op: result.operation },
      'reconciled',
    );
    this.opts.activity?.record({
      kind: 'sync',
      message: `${from} → ${to}: ${source.type} ${result.operation}`,
    });
  }

  async preview(source: CanonicalRecord): Promise<ReconcilePlan> {
    const from = source.meta.source;
    const to = this.other(from);
    const query = naturalKeyQuery(source);
    let link = await this.idMap.bySource(from, source.meta.sourceId);
    if (!link && query) link = await this.idMap.byNaturalKey(source.type, query.key);

    let targetId = link?.ids[to];
    let target: CanonicalRecord | null = null;
    let matchedTarget = false;
    if (targetId) target = await this.connectors[to].read(source.type, targetId);
    if (!target && query) {
      const candidates = await this.connectors[to].findByNaturalKey(source.type, query);
      if (candidates.length > 1) {
        return {
          canonicalId: link?.canonicalId,
          type: source.type,
          from,
          to,
          sourceId: source.meta.sourceId,
          naturalKey: query.key,
          action: 'ambiguous',
          fieldDiff: [],
          warnings: [`${candidates.length} target records share this natural key`],
        };
      }
      target = candidates[0] ?? null;
      targetId = target?.meta.sourceId;
      matchedTarget = Boolean(target);
    }

    if (!target) {
      return {
        canonicalId: link?.canonicalId,
        type: source.type,
        from,
        to,
        sourceId: source.meta.sourceId,
        naturalKey: query?.key,
        action: 'create',
        fieldDiff: Object.entries(source.fields).map(([field, value]) => ({
          field,
          source: value,
          target: undefined,
        })),
        warnings: query ? [] : ['record has no configured natural key'],
      };
    }

    const fieldDiff = diffFields(source.fields, target.fields);
    const targetChangedAfterSync =
      Boolean(link?.hashes[to]) && contentHash(target.fields) !== link?.hashes[to];
    return {
      canonicalId: link?.canonicalId,
      type: source.type,
      from,
      to,
      sourceId: source.meta.sourceId,
      targetId,
      naturalKey: query?.key,
      action:
        fieldDiff.length === 0
          ? 'skip'
          : targetChangedAfterSync
            ? 'conflict'
            : matchedTarget && !link?.ids[to]
              ? 'match'
              : 'update',
      fieldDiff,
      warnings: matchedTarget ? ['existing target record will be linked'] : [],
    };
  }

  async propagateDelete(event: ChangeEvent): Promise<void> {
    const link = await this.idMap.bySource(event.system, event.sourceId);
    if (!link) return;
    const target = this.other(event.system);
    const targetId = link.ids[target];
    if (!targetId) return;
    await this.connectors[target].remove(event.type, targetId);
    this.opts.activity?.record({
      kind: 'delete',
      message: `${event.system} → ${target}: ${event.type} deleted`,
    });
  }

  private async findOrCreateLink(source: CanonicalRecord): Promise<Link> {
    const from = source.meta.source;
    const existing = await this.idMap.bySource(from, source.meta.sourceId);
    if (existing) return existing;

    // First time we see this native id: try to match an existing record by natural key
    // (email/domain/name) so we don't create duplicates during the first bidirectional pass.
    const query = naturalKeyQuery(source);
    if (query) {
      const byKey = await this.idMap.byNaturalKey(source.type, query.key);
      if (byKey) {
        byKey.ids[from] = source.meta.sourceId;
        byKey.naturalKeys = [...new Set([...(byKey.naturalKeys ?? []), query.key])];
        return byKey;
      }
    }

    const to = this.other(from);
    const link: Link = {
      canonicalId: newCanonicalId(),
      type: source.type,
      ids: { [from]: source.meta.sourceId },
      hashes: {},
      modifiedAt: {},
      naturalKeys: query ? [query.key] : [],
      updatedAt: new Date().toISOString(),
    };
    if (query) {
      const candidates = await this.connectors[to].findByNaturalKey(source.type, query);
      if (candidates.length > 1) {
        throw new AmbiguousNaturalKeyError({
          type: source.type,
          from,
          to,
          sourceId: source.meta.sourceId,
          naturalKey: query.key,
          action: 'ambiguous',
          fieldDiff: [],
          warnings: [`${candidates.length} target records share this natural key`],
        });
      }
      if (candidates[0]) link.ids[to] = candidates[0].meta.sourceId;
    }
    return link;
  }

  private async describeCached(system: SystemId, type: CanonicalType): Promise<SchemaField[]> {
    const key = `${system}:${type}`;
    const cached = this.schemaCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < SCHEMA_CACHE_TTL_MS) return cached.fields;
    const fields = await this.connectors[system].describe(type);
    this.schemaCache.set(key, { fields, fetchedAt: Date.now() });
    return fields;
  }

  /**
   * Throws MissingRequiredFieldError if the payload about to be written is blank for a
   * required target field -- but only a field this object actually maps for writing. An
   * unmapped required field is a configuration problem (already caught by preflight's
   * REQUIRED_TARGET_UNMAPPED, a one-time schema check), not a per-record data problem; it
   * would otherwise be relying on the target's own default, which isn't this check's business.
   */
  private async checkRequiredFields(to: SystemId, record: CanonicalRecord): Promise<void> {
    const rules = fieldRules(to, record.type).filter((rule) => !rule.readOnly && !rule.native.includes('.'));
    if (!rules.length) return;
    const payload = fromCanonicalFields(to, record.type, record.fields);
    const schema = await this.describeCached(to, record.type);
    const schemaByName = new Map(schema.map((field) => [field.name.toLowerCase(), field]));
    const missing = rules
      .filter((rule) => schemaByName.get(rule.native.toLowerCase())?.required && isBlank(payload[rule.native]))
      .map((rule) => schemaByName.get(rule.native.toLowerCase())!.label || rule.native);
    if (missing.length) throw new MissingRequiredFieldError(missing);
  }
}

function isBlank(value: FieldValue | undefined): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Maps a native field name (as named in a vendor error, e.g. HubSpot's "email") back to the
 * canonical field, and returns it only if that canonical field is one of this object's
 * configured natural-key fields -- the one signal strong enough to auto-resolve a write
 * conflict without a human, since it's the same rule the app already uses to match records
 * across systems in the first place.
 */
function nativeToNaturalKeyField(
  system: SystemId,
  type: CanonicalType,
  nativeName: string,
): string | undefined {
  const rule = fieldRules(system, type).find(
    (r) => r.native.toLowerCase() === nativeName.toLowerCase(),
  );
  if (!rule) return undefined;
  return naturalKeyFields(type).includes(rule.canonical) ? rule.canonical : undefined;
}

function diffFields(
  source: Record<string, FieldValue>,
  target: Record<string, FieldValue>,
): FieldDiff[] {
  const keys = new Set([...Object.keys(source), ...Object.keys(target)]);
  return [...keys]
    .filter((field) => source[field] !== target[field])
    .sort()
    .map((field) => ({ field, source: source[field], target: target[field] }));
}
