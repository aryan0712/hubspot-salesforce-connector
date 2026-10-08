import {
  ConditionalWriteRejectedError,
  IncompleteCandidateSetError,
  type CRMConnector,
} from '../core/connector.js';
import type {
  CanonicalRecord,
  CanonicalType,
  ChangeEvent,
  FieldValue,
  NaturalKeyQuery,
  SchemaField,
  SystemId,
} from '../core/types.js';
import {
  contentHash,
  hashMatches,
  isLegacyHash,
  NaturalKeyCollisionError,
  newCanonicalId,
  type IdMapStore,
  type Link,
} from '../core/idMap.js';
import { resolve, type ResolveOptions } from '../core/conflict.js';
import { logger } from '../logger.js';
import type { ActivityLog } from '../observability/activity.js';
import type { ConfigContext } from '../core/configContext.js';
import { extractDuplicateValueConflict, MissingRequiredFieldError } from '../core/vendorError.js';
import type { GovernanceStore, StoredConflict } from './governanceStore.js';
import {
  isUncertainOutcome,
  UncertainWriteError,
  type IdentityLock,
  type WriteIntent,
  type WriteIntentStore,
} from './writeIntents.js';
import crypto from 'node:crypto';

export type PlannedAction =
  | 'create'
  | 'update'
  /** An existing destination record was found by natural key and will be linked (and updated if its values differ). */
  | 'match'
  /** No CRM write: already in agreement, an echo, or the destination's values were kept. */
  | 'skip'
  /** The destination changed since the last sync; the conflict was resolved during planning. */
  | 'conflict'
  | 'ambiguous'
  /**
   * Needs an operator decision before anything is written: the natural key already
   * identifies another source record, the destination search was incomplete, or a vendor
   * timestamp cannot be trusted for last-write-wins. Blocks execution like 'ambiguous'.
   */
  | 'review'
  /** The write was attempted (or couldn't even be planned) and failed; see warnings for why. */
  | 'error';

export interface FieldDiff {
  field: string;
  source: FieldValue | undefined;
  target: FieldValue | undefined;
}

/** One exact CRM mutation, frozen at planning time. */
export interface PlannedWrite {
  system: SystemId;
  operation: 'create' | 'update';
  /** Native id being updated; absent for a create. */
  targetId?: string;
  /** Canonical values this write sets (only the fields that change, for an update). */
  fields: Record<string, FieldValue>;
  /** The exact native payload sent to the vendor. */
  payload: Record<string, FieldValue>;
  /** For an update: the record's modified time when it was reviewed (conditional writes). */
  expectedModifiedAt?: string;
}

export interface ConflictDecision {
  strategy: string;
  /** Which side's values the destination ends up with. */
  winner: SystemId | 'merged';
  /** Fields whose destination value was kept instead of the source value. */
  keptDestinationFields: string[];
  targetChangedSinceLastSync: boolean;
  /** The destination's values when the decision was made (for the conflict audit trail). */
  destinationFields: Record<string, FieldValue>;
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
  /** Exact writes this plan performs; empty for skip/ambiguous. Absent on legacy rows. */
  writes?: PlannedWrite[];
  /** Record the source↔destination pairing even when no write is needed. */
  link?: boolean;
  conflict?: ConflictDecision;
  /** A linked destination record that no longer exists; the plan replaces that link. */
  staleTargetId?: string;
  /** Canonical content the destination holds after the writes (drives echo detection). */
  resultFields?: Record<string, FieldValue>;
  /** Content fingerprints observed at planning time; execution refuses when they drift. */
  fingerprints?: { source: string; target: string | null };
  sourceModifiedAt?: string;
  targetModifiedAt?: string;
}

/** Live sync cannot decide safely; the sync engine routes the job to manual review. */
export class ReviewRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewRequiredError';
  }
}

export class AmbiguousNaturalKeyError extends ReviewRequiredError {
  constructor(
    readonly plan: ReconcilePlan,
  ) {
    super(`ambiguous target match for ${plan.type} ${plan.naturalKey ?? ''}`.trim());
    this.name = 'AmbiguousNaturalKeyError';
  }
}

/** Errors that mean "stop and ask an operator" rather than "retry later". */
/** Default time a freshly created record may take to appear in vendor search results. */
export const DEFAULT_SEARCH_VISIBILITY_MS = 120_000;

export function requiresReview(err: unknown): boolean {
  return (
    err instanceof ReviewRequiredError ||
    err instanceof NaturalKeyCollisionError ||
    err instanceof IncompleteCandidateSetError
  );
}

/** Clock skew tolerated before a vendor timestamp "from the future" is distrusted. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Timestamp-based strategies (last-write-wins, field-merge) are only as good as the vendor
 * timestamps they compare. Returns why they cannot be trusted, or undefined when they can.
 */
export function untrustedTimestamp(
  a: CanonicalRecord,
  b: CanonicalRecord,
  strategy: string | undefined,
  now = Date.now(),
): string | undefined {
  if (strategy === 'source-of-truth') return undefined;
  for (const record of [a, b]) {
    const at = Date.parse(record.meta.modifiedAt);
    if (!Number.isFinite(at)) {
      return `${record.meta.source} ${record.meta.sourceId} has no valid modified timestamp (${record.meta.modifiedAt || 'empty'})`;
    }
    if (at > now + MAX_FUTURE_SKEW_MS) {
      return `${record.meta.source} ${record.meta.sourceId} has a modified timestamp in the future (${record.meta.modifiedAt})`;
    }
  }
  return undefined;
}

/** An approved write would have been applied to a different record than the one reviewed. */
export class IdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConflictError';
  }
}

/**
 * How a plan may behave. Live sync may reconcile both systems toward the merged truth;
 * a directional migration writes ONLY to the destination -- keeping a newer destination
 * value never causes a write back to the migration source.
 */
export interface ReconcilePolicy {
  mode: 'sync' | 'migration';
  writeScope: 'destination-only' | 'bidirectional';
  conflict?: Pick<ResolveOptions, 'strategy' | 'sourceOfTruth'>;
}

export const MIGRATION_POLICY: Omit<ReconcilePolicy, 'conflict'> = {
  mode: 'migration',
  writeScope: 'destination-only',
};

/**
 * The Reconciler is the single place where a change becomes agreement across systems.
 * Both the migration engine (bulk) and the sync engine (real-time) funnel through it, so
 * migration and live sync can never drift in behavior. Work happens in two stages:
 *
 *   plan()  -- locate the link/target, drop echoes, resolve conflicts, and freeze the exact
 *              native writes (no CRM mutation). A migration preview stores this plan.
 *   apply() -- perform exactly the planned writes and record the resulting link + hashes.
 *
 * reconcile() is plan + apply under the live-sync policy.
 */
const SCHEMA_CACHE_TTL_MS = 5 * 60_000;

export class Reconciler {
  private readonly schemaCache = new Map<string, { fields: SchemaField[]; fetchedAt: number }>();

  constructor(
    private readonly connectors: Record<SystemId, CRMConnector>,
    private readonly idMap: IdMapStore,
    private readonly config: ConfigContext,
    private readonly opts: {
      readCounterpartForConflict?: boolean;
      activity?: ActivityLog;
      governance?: GovernanceStore;
      conflictOptions?: (type?: CanonicalType) => Pick<ResolveOptions, 'strategy' | 'sourceOfTruth'>;
      /** Live sync write scope per object; defaults to bidirectional reconciliation. */
      syncWriteScope?: (type: CanonicalType) => ReconcilePolicy['writeScope'];
      /** R06: durable write intents (recorded before every CRM mutation). */
      intents?: WriteIntentStore;
      /** R06: serializes work per record identity across workers/processes. */
      locks?: IdentityLock;
      /** How long a created record may be invisible to vendor search (recovery lookups). */
      searchVisibilityMs?: number;
    } = {},
  ) {}

  private other(system: SystemId): SystemId {
    return system === 'salesforce' ? 'hubspot' : 'salesforce';
  }

  /** The conflict settings a plan made now would use. */
  conflictSettings(type?: CanonicalType): Pick<ResolveOptions, 'strategy' | 'sourceOfTruth'> {
    return { ...this.opts.conflictOptions?.(type) };
  }

  syncPolicy(type: CanonicalType): ReconcilePolicy {
    return {
      mode: 'sync',
      writeScope: this.opts.syncWriteScope?.(type) ?? 'bidirectional',
      conflict: this.conflictSettings(type),
    };
  }

  migrationPolicy(conflict?: Pick<ResolveOptions, 'strategy' | 'sourceOfTruth'>): ReconcilePolicy;
  migrationPolicy(type: CanonicalType, conflict?: Pick<ResolveOptions, 'strategy' | 'sourceOfTruth'>): ReconcilePolicy;
  migrationPolicy(
    arg1?: CanonicalType | Pick<ResolveOptions, 'strategy' | 'sourceOfTruth'>,
    arg2?: Pick<ResolveOptions, 'strategy' | 'sourceOfTruth'>,
  ): ReconcilePolicy {
    if (typeof arg1 === 'string') {
      return { ...MIGRATION_POLICY, conflict: arg2 ?? this.conflictSettings(arg1) };
    }
    return { ...MIGRATION_POLICY, conflict: arg1 ?? this.conflictSettings() };
  }

  // ------------------------------------------------------------------ live sync

  /**
   * @param overrides.conflict  applies a deliberate conflict decision (manual resolution:
   *   e.g. source-of-truth = the system the operator chose) instead of the configured one.
   * @param overrides.force  re-evaluates the record even if its content is what we last
   *   synced (a manual resolution must act although the record itself did not change).
   */
  async reconcile(
    source: CanonicalRecord,
    overrides: { conflict?: Pick<ResolveOptions, 'strategy' | 'sourceOfTruth'>; force?: boolean } = {},
  ): Promise<void> {
    await this.withIdentity(source, async () => {
      // Finish (or safely abandon) anything an earlier attempt left half-done first, so the
      // plan below sees the true state instead of re-creating a record that already exists.
      await this.recover(source);
      const policy = { ...this.syncPolicy(source.type), ...(overrides.conflict ? { conflict: overrides.conflict } : {}) };
      const plan = await this.planSync(source, policy, { force: overrides.force });
      if (plan.action === 'skip' && !plan.writes?.length && !plan.link) return;
      await this.applyUnlocked(plan, source, policy);
    });
  }

  /**
   * Serializes all work on one record identity: its source id and its normalised natural
   * key (so the Salesforce and HubSpot copies of one person also serialize with each other).
   */
  private async withIdentity<T>(source: CanonicalRecord, fn: () => Promise<T>): Promise<T> {
    if (!this.opts.locks) return fn();
    const keys = [`src:${source.type}:${source.meta.source}:${source.meta.sourceId}`];
    const query = this.config.naturalKeyQuery(source);
    if (query) keys.push(`nk:${source.type}:${query.key}`);
    return this.opts.locks.withLocks(keys, fn);
  }

  // ------------------------------------------------------------------ recovery (R06)

  /**
   * Resolves every unresolved write intent left for this source record. An intent whose
   * write provably happened is adopted into the id map; one that provably did not is
   * abandoned; an outcome that cannot be determined yet (search not yet consistent) is
   * retried later, and one that cannot be determined at all goes to operator review.
   */
  private async recover(source: CanonicalRecord): Promise<void> {
    const intents = this.opts.intents;
    if (!intents) return;
    const pending = await intents.unresolvedForSource(source.type, source.meta.source, source.meta.sourceId);
    for (const intent of pending) await this.recoverIntent(intent, source);
  }

  /** Returns the adopted target id when the intent's write is known to have happened. */
  private async recoverIntent(intent: WriteIntent, source: CanonicalRecord): Promise<string | undefined> {
    const intents = this.opts.intents!;
    if (intent.status === 'review') {
      throw new ReviewRequiredError(`an earlier ${intent.system} write for this record needs review (${intent.operationId})`);
    }
    const outcome = await this.resolveOutcome(intent);
    if (outcome.status === 'wait') {
      throw new UncertainWriteError(outcome.reason, intent.operationId);
    }
    if (outcome.status === 'review') {
      await intents.update(intent.operationId, { status: 'review', evidence: { reason: outcome.reason } });
      throw new ReviewRequiredError(outcome.reason);
    }
    if (outcome.status === 'abandoned') {
      await intents.update(intent.operationId, { status: 'abandoned', evidence: { reason: outcome.reason } });
      return undefined;
    }
    if (outcome.status !== 'applied') return undefined;
    // The write happened: make sure the id map records it (idempotent).
    const link =
      (await this.idMap.bySource(intent.sourceSystem, intent.sourceId, intent.type)) ??
      ({
        canonicalId: intent.linkId,
        type: intent.type,
        ids: { [intent.sourceSystem]: intent.sourceId },
        hashes: {},
        modifiedAt: {},
        naturalKeys: intent.naturalKey ? [intent.naturalKey] : [],
        updatedAt: new Date().toISOString(),
      } satisfies Link);
    const existing = link.ids[intent.system];
    if (existing && existing !== outcome.targetId) {
      const reason = `${intent.system} write ${intent.operationId} created ${outcome.targetId}, but the record is linked to ${existing}`;
      await intents.update(intent.operationId, { status: 'review', evidence: { reason } });
      throw new ReviewRequiredError(reason);
    }
    if (!existing) {
      link.ids[intent.system] = outcome.targetId;
      await this.idMap.upsertLink(link);
    }
    await intents.update(intent.operationId, {
      status: 'committed',
      targetId: outcome.targetId,
      evidence: { recovered: outcome.reason },
    });
    this.opts.activity?.record({
      kind: 'info',
      message: `${intent.type}: recovered an earlier ${intent.system} ${intent.operation} (${outcome.reason})`,
    });
    void source;
    return outcome.targetId;
  }

  private async resolveOutcome(
    intent: WriteIntent,
  ): Promise<
    | { status: 'applied'; targetId: string; reason: string }
    | { status: 'abandoned' | 'wait' | 'review'; reason: string }
  > {
    const connector = this.connectors[intent.system];
    if (intent.status === 'applied' && intent.targetId) {
      const current = await connector.read(intent.type, intent.targetId);
      return current
        ? { status: 'applied', targetId: intent.targetId, reason: 'vendor confirmed the write before the link was saved' }
        : { status: 'review', reason: `${intent.system} ${intent.targetId} was written but no longer exists` };
    }
    if (intent.operation === 'update') {
      if (!intent.targetId) return { status: 'review', reason: 'update intent without a target id' };
      const current = await connector.read(intent.type, intent.targetId);
      if (!current) return { status: 'review', reason: `${intent.system} ${intent.targetId} no longer exists` };
      const applied = Object.entries(intent.fields).every(([field, value]) => sameValue(current.fields[field], value));
      if (applied) return { status: 'applied', targetId: intent.targetId, reason: 'destination already holds the written values' };
      if (Date.parse(current.meta.modifiedAt) > Date.parse(intent.createdAt)) {
        return { status: 'review', reason: `${intent.system} ${intent.targetId} changed after an update with an unknown outcome` };
      }
      return { status: 'abandoned', reason: 'destination does not hold the values and is unchanged; re-planning' };
    }
    // A create with an unknown outcome: look for the record it would have created.
    const query = this.config.naturalKeyQuery({
      canonicalId: '',
      type: intent.type,
      fields: intent.fields,
      meta: { source: intent.sourceSystem, sourceId: intent.sourceId, modifiedAt: intent.createdAt },
    });
    if (!query) {
      return { status: 'review', reason: 'an earlier create has an unknown outcome and the record has no natural key to look it up' };
    }
    let candidates: CanonicalRecord[];
    try {
      candidates = await this.findCandidates(intent.system, intent.type, query);
    } catch (err) {
      if (err instanceof IncompleteCandidateSetError) return { status: 'review', reason: err.message };
      throw err;
    }
    if (candidates.length > 1) {
      return { status: 'review', reason: `${candidates.length} ${intent.system} records match ${query.key} after an uncertain create` };
    }
    if (candidates.length === 1) {
      const candidate = candidates[0]!;
      const owner = await this.idMap.bySource(intent.system, candidate.meta.sourceId, intent.type);
      if (owner && owner.ids[intent.sourceSystem] && owner.ids[intent.sourceSystem] !== intent.sourceId) {
        return { status: 'review', reason: `${intent.system} ${candidate.meta.sourceId} is already linked to another record` };
      }
      return { status: 'applied', targetId: candidate.meta.sourceId, reason: `found ${intent.system} ${candidate.meta.sourceId} by ${query.key}` };
    }
    const age = Date.now() - Date.parse(intent.createdAt);
    if (age < (this.opts.searchVisibilityMs ?? DEFAULT_SEARCH_VISIBILITY_MS)) {
      return { status: 'wait', reason: `waiting for ${intent.system} search to show the outcome of ${intent.operationId}` };
    }
    return { status: 'abandoned', reason: 'no matching record after the search-visibility window; the create did not happen' };
  }

  /**
   * Live-sync planning: the link is found (or a new one prepared), echoes of our own
   * writes are dropped, and a changed counterpart is resolved under the sync conflict
   * strategy. Bidirectional scope may also plan a write back to the source.
   */
  private async planSync(
    source: CanonicalRecord,
    policy = this.syncPolicy(source.type),
    opts: { force?: boolean } = {},
  ): Promise<ReconcilePlan> {
    const from = source.meta.source;
    const to = this.other(from);
    const incomingHash = contentHash(source.fields);
    const link = await this.findOrPrepareLink(source);
    const base = {
      canonicalId: link.canonicalId,
      type: source.type,
      from,
      to,
      sourceId: source.meta.sourceId,
      naturalKey: this.config.naturalKeyQuery(source)?.key,
    };

    // Echo suppression: content equal to what we last recorded for this system originated
    // from our own write. Ignore it to break the loop.
    if (!opts.force && hashMatches(link.hashes?.[from], source.fields)) {
      if (isLegacyHash(link.hashes?.[from])) {
        // Upgrade the stored hash from this read-only observation; no CRM write.
        await this.idMap.upsertLink({ ...link, hashes: { ...link.hashes, [from]: incomingHash } });
      }
      logger.debug({ canonicalId: link.canonicalId, from }, 'echo suppressed');
      this.opts.activity?.record({
        kind: 'echo-suppressed',
        message: `Echo from ${from} suppressed (${link.canonicalId.slice(0, 8)})`,
      });
      return { ...base, targetId: link.ids[to], action: 'skip', fieldDiff: [], warnings: ['echo'], writes: [] };
    }

    let targetId = link.ids[to];
    let counterpart: CanonicalRecord | null = null;
    if ((this.opts.readCounterpartForConflict ?? true) && targetId) {
      counterpart = await this.connectors[to].read(source.type, targetId);
      const tombstone = counterpart ? undefined : await this.opts.governance?.latestTombstone(link.canonicalId);
      if (!counterpart && tombstone?.restoredAt) {
        // An operator explicitly restored this deleted record: recreate it.
        targetId = undefined;
        delete link.ids[to];
        delete link.hashes[to];
      } else if (!counterpart) {
        // The linked destination record is gone. If an approved delete removed it, a late
        // or replayed change must not resurrect it (R10 tombstone); otherwise someone
        // deleted it outside the sync and an operator decides whether to recreate it.
        if (tombstone) {
          this.opts.activity?.record({
            kind: 'info',
            message: `${source.type}: not recreating ${to} ${targetId}; it was deleted (${tombstone.policy}${tombstone.approvedBy ? ` by ${tombstone.approvedBy}` : ''})`,
          });
          return { ...base, targetId, action: 'skip', fieldDiff: [], warnings: ['deleted: tombstone'], writes: [] };
        }
        throw new ReviewRequiredError(
          `linked ${to} ${source.type} ${targetId} no longer exists; restore it or relink before syncing`,
        );
      }
    }
    let resolved: Record<string, FieldValue> = source.fields;
    let conflict: ConflictDecision | undefined;
    if (counterpart && !hashMatches(link.hashes[to], counterpart.fields)) {
      const distrust = untrustedTimestamp(source, counterpart, policy.conflict?.strategy);
      if (distrust) throw new ReviewRequiredError(`conflict needs review: ${distrust}`);
      const res = resolve(source, counterpart, { ...policy.conflict, fieldOwners: this.fieldOwners(source.type) });
      resolved = res.winner.fields;
      conflict = {
        strategy: res.reason,
        winner: res.winner === source ? from : res.winner === counterpart ? to : 'merged',
        keptDestinationFields: Object.keys(resolved).filter(
          (field) => resolved[field] !== source.fields[field] && resolved[field] === counterpart!.fields[field],
        ),
        targetChangedSinceLastSync: true,
        destinationFields: { ...counterpart.fields },
      };
    }

    const writes: PlannedWrite[] = [];
    const targetWrite = this.buildWrite(to, source.type, resolved, counterpart, targetId);
    if (targetWrite) writes.push(targetWrite);
    if (
      policy.writeScope === 'bidirectional' &&
      conflict &&
      contentHash(resolved) !== incomingHash &&
      link.ids[from]
    ) {
      const sourceWrite = this.buildWrite(from, source.type, resolved, source, link.ids[from]);
      if (sourceWrite) writes.push(sourceWrite);
    }
    return {
      ...base,
      targetId,
      action: conflict ? 'conflict' : targetId ? 'update' : 'create',
      fieldDiff: diffFields(source.fields, counterpart?.fields ?? {}),
      warnings: [],
      writes,
      link: true,
      conflict,
      resultFields: resolved,
      fingerprints: { source: incomingHash, target: counterpart ? contentHash(counterpart.fields) : null },
      sourceModifiedAt: source.meta.modifiedAt,
      targetModifiedAt: counterpart?.meta.modifiedAt,
    };
  }

  // ------------------------------------------------------------------ migration planning

  /**
   * Migration planning (no writes). Finds the destination by link or natural key, resolves
   * any difference with the destination under the migration policy, and freezes exactly
   * what will be written. The source is never a write target in a migration plan.
   */
  async preview(source: CanonicalRecord, policy = this.migrationPolicy()): Promise<ReconcilePlan> {
    const from = source.meta.source;
    const to = this.other(from);
    const query = this.config.naturalKeyQuery(source);
    let link = await this.idMap.bySource(from, source.meta.sourceId, source.type);
    let keyOwnedElsewhere = false;
    if (!link && query) {
      link = await this.idMap.byNaturalKey(source.type, query.key);
      // The key already identifies a DIFFERENT source record (e.g. a reused email):
      // never silently re-point that identity at this record.
      keyOwnedElsewhere = Boolean(link?.ids[from] && link.ids[from] !== source.meta.sourceId);
    }

    const base = {
      canonicalId: link?.canonicalId,
      type: source.type,
      from,
      to,
      sourceId: source.meta.sourceId,
      naturalKey: query?.key,
      sourceModifiedAt: source.meta.modifiedAt,
    };
    if (keyOwnedElsewhere) {
      return {
        ...base,
        canonicalId: undefined,
        action: 'review',
        fieldDiff: [],
        warnings: [`natural key ${query!.key} already identifies ${from} record ${link!.ids[from]}; resolve the duplicate before migrating`],
        writes: [],
        fingerprints: { source: contentHash(source.fields), target: null },
      };
    }
    let targetId = link?.ids[to];
    let target: CanonicalRecord | null = null;
    let matchedTarget = false;
    let staleTargetId: string | undefined;
    const warnings: string[] = [];
    if (targetId) {
      target = await this.connectors[to].read(source.type, targetId);
      if (!target) {
        const tombstone = link ? await this.opts.governance?.activeTombstone(link.canonicalId) : undefined;
        if (tombstone) {
          return {
            ...base,
            targetId,
            action: 'skip',
            fieldDiff: [],
            warnings: [`${to} record ${targetId} was deleted by an approved delete; restore it to migrate again`],
            writes: [],
            fingerprints: { source: contentHash(source.fields), target: null },
          };
        }
        staleTargetId = targetId;
        warnings.push(`linked ${to} record ${targetId} no longer exists`);
      }
    }
    if (!target && query) {
      let candidates: CanonicalRecord[];
      try {
        candidates = await this.findCandidates(to, source.type, query);
      } catch (err) {
        if (!(err instanceof IncompleteCandidateSetError)) throw err;
        return {
          ...base,
          action: 'review',
          fieldDiff: [],
          warnings: [`${err.message}; cannot prove there is no existing ${to} record for ${query.key}`],
          writes: [],
          fingerprints: { source: contentHash(source.fields), target: null },
        };
      }
      if (candidates.length > 1) {
        return {
          ...base,
          action: 'ambiguous',
          fieldDiff: [],
          warnings: [`${candidates.length} target records share this natural key`],
          writes: [],
          fingerprints: { source: contentHash(source.fields), target: null },
        };
      }
      target = candidates[0] ?? null;
      targetId = target?.meta.sourceId;
      matchedTarget = Boolean(target);
    }

    if (!target) {
      const write = this.buildWrite(to, source.type, source.fields, null, undefined)!;
      return {
        ...base,
        canonicalId: link?.canonicalId,
        targetId: undefined,
        action: 'create',
        fieldDiff: Object.entries(source.fields).map(([field, value]) => ({
          field,
          source: value,
          target: undefined,
        })),
        warnings: query ? warnings : [...warnings, 'record has no configured natural key'],
        writes: [write],
        link: true,
        staleTargetId,
        resultFields: { ...source.fields },
        fingerprints: { source: contentHash(source.fields), target: null },
      };
    }

    const fieldDiff = diffFields(source.fields, target.fields);
    const linked = Boolean(link?.ids[to] && link.ids[to] === target.meta.sourceId);
    const targetChangedAfterSync =
      Boolean(link?.hashes[to]) && !hashMatches(link?.hashes[to], target.fields);
    let resolved: Record<string, FieldValue> = source.fields;
    let conflict: ConflictDecision | undefined;
    const distrust = fieldDiff.length ? untrustedTimestamp(source, target, policy.conflict?.strategy) : undefined;
    if (distrust) {
      return {
        ...base,
        targetId: target.meta.sourceId,
        action: 'review',
        fieldDiff,
        warnings: [`cannot resolve the difference automatically: ${distrust}`],
        writes: [],
        fingerprints: { source: contentHash(source.fields), target: contentHash(target.fields) },
        targetModifiedAt: target.meta.modifiedAt,
      };
    }
    if (fieldDiff.length) {
      const res = resolve(source, target, {
        ...policy.conflict,
        fieldOwners: this.fieldOwners(source.type),
      });
      resolved = res.winner.fields;
      const kept = Object.keys(source.fields).filter(
        (field) => resolved[field] !== source.fields[field] && resolved[field] === target!.fields[field],
      );
      if (kept.length || targetChangedAfterSync) {
        conflict = {
          strategy: res.reason,
          winner: res.winner === source ? from : res.winner === target ? to : 'merged',
          keptDestinationFields: kept,
          targetChangedSinceLastSync: targetChangedAfterSync,
          destinationFields: { ...target.fields },
        };
      }
    }
    const write = this.buildWrite(to, source.type, resolved, target, target.meta.sourceId);
    if (conflict?.keptDestinationFields.length) {
      warnings.push(
        `kept newer ${to} value${conflict.keptDestinationFields.length === 1 ? '' : 's'} for ${conflict.keptDestinationFields.join(', ')} (${conflict.strategy}); ${from} is not modified by a migration`,
      );
    }
    if (matchedTarget && !linked) warnings.push('existing target record will be linked');
    return {
      ...base,
      targetId: target.meta.sourceId,
      action: !write
        ? matchedTarget && !linked ? 'match' : 'skip'
        : targetChangedAfterSync
          ? 'conflict'
          : matchedTarget && !linked
            ? 'match'
            : 'update',
      fieldDiff,
      warnings,
      writes: write ? [write] : [],
      link: !linked,
      conflict,
      staleTargetId,
      resultFields: { ...target.fields, ...(write?.fields ?? {}) },
      fingerprints: { source: contentHash(source.fields), target: contentHash(target.fields) },
      targetModifiedAt: target.meta.modifiedAt,
    };
  }

  // ------------------------------------------------------------------ apply

  /**
   * Performs exactly the plan's writes. Under the migration policy nothing is re-planned:
   * a duplicate-value rejection or a link that now points elsewhere stops the write
   * (IdentityConflictError) instead of silently retargeting it. Live sync may self-heal a
   * stale link when the vendor names the record that owns the natural-key value.
   */
  async apply(
    plan: ReconcilePlan,
    source: CanonicalRecord,
    policy: ReconcilePolicy,
    opts: { operationId?: string } = {},
  ): Promise<ReconcilePlan> {
    return this.withIdentity(source, async () => {
      if (policy.mode === 'migration' && this.opts.intents) {
        const resumed = await this.resumeMigrationItem(plan, source, opts.operationId);
        if (resumed) return resumed;
      }
      return this.applyUnlocked(plan, source, policy, opts);
    });
  }

  /**
   * A migration item is executed under a deterministic operation id. If an earlier attempt
   * of THIS item already wrote (committed, or provably applied), the write is not repeated:
   * the item is reported as applied from the recorded evidence. Any other unresolved write
   * for the record stops the item -- the approved plan never builds on unknown state.
   */
  private async resumeMigrationItem(
    plan: ReconcilePlan,
    source: CanonicalRecord,
    operationId: string | undefined,
  ): Promise<ReconcilePlan | undefined> {
    const intents = this.opts.intents!;
    if (operationId) {
      const mine = await intents.forOperation(`${operationId}:`);
      const done = mine.find((intent) => intent.status === 'committed');
      if (done) {
        return { ...plan, targetId: done.targetId ?? plan.targetId, writes: [], warnings: [...plan.warnings, 'already applied by an earlier attempt'] };
      }
      for (const intent of mine.filter((item) => ['pending', 'applied', 'uncertain'].includes(item.status))) {
        const targetId = await this.recoverIntent(intent, source);
        if (targetId) {
          return { ...plan, targetId, writes: [], warnings: [...plan.warnings, 'recovered from an earlier attempt'] };
        }
      }
    }
    const others = await intents.unresolvedForSource(source.type, source.meta.source, source.meta.sourceId);
    if (others.length) {
      throw new UncertainWriteError(
        `an earlier write for ${source.type} ${source.meta.sourceId} is unresolved (${others[0]!.operationId})`,
        others[0]!.operationId,
      );
    }
    return undefined;
  }

  /**
   * The state of an earlier attempt of a deterministic operation (R08 resume):
   * 'committed' when its write is recorded as done, 'unresolved' when an attempt left an
   * intent whose outcome must be recovered, undefined when there was no attempt.
   */
  async priorAttempt(operationId: string): Promise<'committed' | 'unresolved' | undefined> {
    const intents = await this.opts.intents?.forOperation(`${operationId}:`);
    if (!intents?.length) return undefined;
    if (intents.some((intent) => intent.status === 'committed')) return 'committed';
    if (intents.some((intent) => ['pending', 'applied', 'uncertain', 'review'].includes(intent.status))) return 'unresolved';
    return undefined;
  }

  private async applyUnlocked(
    plan: ReconcilePlan,
    source: CanonicalRecord,
    policy: ReconcilePolicy,
    opts: { operationId?: string } = {},
  ): Promise<ReconcilePlan> {
    const from = plan.from;
    const to = plan.to;
    if (policy.mode === 'migration' && plan.writes?.some((write) => write.system !== to)) {
      throw new IdentityConflictError('a migration plan may only write to its destination system');
    }
    const link = await this.linkForApply(plan, source, policy);
    let targetId = plan.targetId;
    const applied: ReconcilePlan = { ...plan, writes: [] };
    const committed: string[] = [];
    const naturalKey = this.config.naturalKeyQuery(source)?.key;

    for (const [index, write] of (plan.writes ?? []).entries()) {
      if (write.system === to) await this.checkRequiredFields(to, source.type, write);
      const operationId = opts.operationId
        ? `${opts.operationId}:${write.system}:${index}:${crypto.randomUUID().slice(0, 8)}`
        : crypto.randomUUID();
      // Durable BEFORE the vendor call: a crash or lost response now leaves evidence.
      await this.opts.intents?.begin({
        operationId,
        linkId: link.canonicalId,
        type: source.type,
        system: write.system,
        operation: write.operation,
        sourceSystem: from,
        sourceId: source.meta.sourceId,
        targetId: write.targetId,
        naturalKey,
        fields: write.fields,
        payload: write.payload,
        payloadHash: contentHash(write.payload),
      });
      let resultId: string;
      try {
        resultId = write.system === to
          ? (await this.performTargetWrite(write, link, policy, source.type)).targetId
          : (await this.connectors[write.system].write(source.type, write.payload, write.targetId)).targetId;
      } catch (err) {
        if (this.opts.intents) {
          const uncertain = isUncertainOutcome(err);
          await this.opts.intents
            .update(operationId, {
              status: uncertain ? 'uncertain' : 'abandoned',
              evidence: { error: err instanceof Error ? err.message.slice(0, 500) : String(err) },
            })
            .catch((updateErr) => logger.error({ err: updateErr, operationId }, 'could not record write outcome'));
          if (uncertain) {
            throw new UncertainWriteError(
              `${write.system} ${write.operation} outcome is unknown (${err instanceof Error ? err.message : String(err)}); it will be recovered before any retry`,
              operationId,
            );
          }
        }
        throw err;
      }
      // If this update fails the intent stays 'pending' and recovery finds the record.
      await this.opts.intents?.update(operationId, { status: 'applied', targetId: resultId });
      committed.push(operationId);
      if (write.system === to) {
        targetId = resultId;
        link.ids[to] = resultId;
        applied.writes!.push({ ...write, targetId: resultId });
      } else {
        applied.writes!.push(write);
      }
    }

    if (plan.conflict) {
      await this.opts.governance?.recordConflict({
        linkId: link.canonicalId,
        type: source.type,
        source,
        target: {
          ...source,
          fields: plan.conflict.destinationFields,
          meta: { ...source.meta, source: to, sourceId: plan.targetId ?? '' },
        },
        strategy: plan.conflict.strategy,
        resolution: { ...source, fields: plan.resultFields ?? source.fields },
        decision: {
          winner: plan.conflict.winner,
          keptDestinationFields: plan.conflict.keptDestinationFields,
          fieldOwners: this.fieldOwners(source.type),
        },
      });
      this.opts.activity?.record({
        kind: 'conflict',
        message: `Conflict on ${source.type} resolved via ${plan.conflict.strategy}`,
      });
    }

    if (targetId) link.ids[to] = targetId;
    const resulting = plan.resultFields ?? source.fields;
    if (targetId) {
      link.hashes[to] = contentHash(resulting);
      link.modifiedAt[to] = new Date().toISOString();
    }
    const wroteBack = plan.writes?.some((write) => write.system === from);
    link.hashes[from] = wroteBack ? contentHash(resulting) : contentHash(source.fields);
    link.ids[from] = source.meta.sourceId;
    link.modifiedAt[from] = source.meta.modifiedAt;
    await this.idMap.upsertLink(link);
    for (const operationId of committed) {
      await this.opts.intents?.update(operationId, { status: 'committed' });
    }

    applied.canonicalId = link.canonicalId;
    applied.targetId = targetId;
    const operation = plan.writes?.find((write) => write.system === to)?.operation;
    logger.debug({ canonicalId: link.canonicalId, from, to, op: operation ?? 'link' }, 'reconciled');
    this.opts.activity?.record({
      kind: 'sync',
      message: `${from} → ${to}: ${source.type} ${operation ? `${operation}d` : 'linked'}`,
    });
    return applied;
  }

  private async performTargetWrite(
    write: PlannedWrite,
    link: Link,
    policy: ReconcilePolicy,
    type: CanonicalType,
  ): Promise<{ targetId: string }> {
    const connector = this.connectors[write.system];
    try {
      const result = await connector.write(type, write.payload, write.targetId, {
        ifUnmodifiedSince: policy.mode === 'migration' ? write.expectedModifiedAt : undefined,
      });
      return { targetId: result.targetId };
    } catch (err) {
      if (err instanceof ConditionalWriteRejectedError) throw err;
      const conflict = extractDuplicateValueConflict(err);
      const conflictField = conflict && nativeToNaturalKeyField(this.config, write.system, type, conflict.property);
      if (!conflict || !conflictField || conflict.conflictingId === write.targetId) throw err;
      if (policy.mode === 'migration') {
        throw new IdentityConflictError(
          `${write.system} record ${conflict.conflictingId} already owns "${conflictField}"; the approved write was not retargeted`,
        );
      }
      // Live sync self-heal: re-point to the record the vendor confirmed owns that value.
      logger.warn(
        {
          canonicalId: link.canonicalId,
          previousTargetId: write.targetId,
          conflictingId: conflict.conflictingId,
          field: conflictField,
        },
        'natural-key conflict on write -- re-linking to the existing record',
      );
      const retried = await connector.write(type, write.payload, conflict.conflictingId);
      this.opts.activity?.record({
        kind: 'info',
        message: `${type}: re-linked to an existing ${write.system} record on matching "${conflictField}" (the previous link was stale)`,
      });
      return { targetId: retried.targetId };
    }
  }

  private async linkForApply(plan: ReconcilePlan, source: CanonicalRecord, policy: ReconcilePolicy): Promise<Link> {
    const from = plan.from;
    const to = plan.to;
    const query = this.config.naturalKeyQuery(source);
    const bySource = await this.idMap.bySource(from, source.meta.sourceId, source.type);
    const byKey = !bySource && query ? await this.idMap.byNaturalKey(source.type, query.key) : undefined;
    if (byKey?.ids[from] && byKey.ids[from] !== source.meta.sourceId) {
      const message = `natural key ${query!.key} already identifies ${from} record ${byKey.ids[from]}`;
      if (policy.mode === 'migration') throw new IdentityConflictError(message);
      throw new ReviewRequiredError(message);
    }
    const existing = bySource ?? byKey;
    if (existing) {
      const currentTarget = existing.ids[to] === plan.staleTargetId ? undefined : existing.ids[to];
      if (policy.mode === 'migration' && currentTarget && plan.targetId && currentTarget !== plan.targetId) {
        throw new IdentityConflictError(
          `${source.type} ${source.meta.sourceId} is now linked to ${to} ${existing.ids[to]}, not the reviewed ${plan.targetId}`,
        );
      }
      if (policy.mode === 'migration' && currentTarget && !plan.targetId) {
        throw new IdentityConflictError(
          `${source.type} ${source.meta.sourceId} gained a ${to} link after review; refusing to create another record`,
        );
      }
      // The link's identity follows the record: a changed key is retired by the store.
      if (query) existing.naturalKeys = [query.key];
      if (plan.staleTargetId && existing.ids[to] === plan.staleTargetId) delete existing.ids[to];
      existing.ids[from] = source.meta.sourceId;
      return existing;
    }
    return {
      canonicalId: plan.canonicalId ?? newCanonicalId(),
      type: source.type,
      ids: { [from]: source.meta.sourceId },
      hashes: {},
      modifiedAt: {},
      naturalKeys: query ? [query.key] : [],
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Deletes the counterpart of a deleted record and leaves a tombstone recording who
   * approved it (or which policy did), so the record is never recreated by a late event,
   * a replay or a later migration until an operator explicitly restores it.
   */
  async propagateDelete(
    event: ChangeEvent,
    provenance: { policy?: 'ignore' | 'cascade' | 'manual-review'; approvedBy?: string; jobId?: string } = {},
  ): Promise<void> {
    const link = await this.idMap.bySource(event.system, event.sourceId, event.type);
    if (!link) return;
    const target = this.other(event.system);
    const targetId = link.ids[target];
    if (!targetId) return;
    await this.connectors[target].remove(event.type, targetId);
    await this.opts.governance?.tombstone({
      linkId: link.canonicalId,
      type: event.type,
      deletedSystem: event.system,
      deletedSourceId: event.sourceId,
      targetSystem: target,
      targetId,
      policy: provenance.policy ?? 'manual-review',
      approvedBy: provenance.approvedBy,
      syncEventId: provenance.jobId,
    });
    this.opts.activity?.record({
      kind: 'delete',
      message: `${event.system} → ${target}: ${event.type} deleted`,
    });
  }

  /**
   * Deliberate manual conflict resolution (R10). The automatic resolution may already have
   * propagated the other side's values everywhere, so the chosen side's values are taken
   * from the conflict's recorded snapshot: they are restored in the winning system, then
   * pushed to the other system through the normal reconcile path (locks, write intents,
   * echo hashes) with that system as source of truth.
   */
  async resolveConflictManually(conflict: StoredConflict, winner: SystemId): Promise<void> {
    const snapshot = conflict.source.meta.source === winner ? conflict.source : conflict.target;
    const link = await this.idMap.bySource(conflict.source.meta.source, conflict.source.meta.sourceId, conflict.type);
    const winnerId = link?.ids[winner];
    if (!link || !winnerId) throw new Error('conflict record is not linked');
    const current = await this.connectors[winner].read(conflict.type, winnerId);
    if (!current) throw new Error('winning record not found');
    const fields = { ...current.fields, ...snapshot.fields };
    if (contentHash(fields) !== contentHash(current.fields)) {
      await this.connectors[winner].upsert({ ...current, fields }, winnerId);
    }
    const restored = await this.connectors[winner].read(conflict.type, winnerId);
    if (!restored) throw new Error('winning record not found');
    await this.reconcile(restored, {
      conflict: { strategy: 'source-of-truth', sourceOfTruth: winner },
      force: true,
    });
  }

  /** Lifts a tombstone so the record may be synced (recreated) again. */
  async restoreDeleted(linkId: string, actorId?: string): Promise<boolean> {
    return (await this.opts.governance?.restoreTombstone(linkId, actorId)) ?? false;
  }

  // ------------------------------------------------------------------ helpers

  /** Live sync: find the link, or prepare (not persist) a new one matched by natural key. */
  private async findOrPrepareLink(source: CanonicalRecord): Promise<Link> {
    const from = source.meta.source;
    const existing = await this.idMap.bySource(from, source.meta.sourceId, source.type);
    if (existing) return existing;

    // First time we see this native id: try to match an existing record by natural key
    // so we don't create duplicates during the first bidirectional pass.
    const query = this.config.naturalKeyQuery(source);
    if (query) {
      const byKey = await this.idMap.byNaturalKey(source.type, query.key);
      if (byKey?.ids[from] && byKey.ids[from] !== source.meta.sourceId) {
        // Another source record already owns this identity (duplicate or reused value).
        throw new ReviewRequiredError(
          `natural key ${query.key} already identifies ${from} record ${byKey.ids[from]}; not re-linking automatically`,
        );
      }
      if (byKey) {
        byKey.ids[from] = source.meta.sourceId;
        byKey.naturalKeys = [query.key];
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
      const candidates = await this.findCandidates(to, source.type, query);
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

  /**
   * Destination records matching a natural key. A vendor search may be broad (Salesforce
   * matches a domain with LIKE), so every candidate is verified locally against the exact
   * normalised key: `example.com` never matches `notexample.com`. A truncated result
   * surfaces as IncompleteCandidateSetError from the connector.
   */
  private async findCandidates(
    system: SystemId,
    type: CanonicalType,
    query: NaturalKeyQuery,
  ): Promise<CanonicalRecord[]> {
    const candidates = await this.connectors[system].findByNaturalKey(type, query);
    return candidates.filter((candidate) => this.config.naturalKey(candidate) === query.key);
  }

  /**
   * Builds the write that brings `system` to `desired`. With a known current record, only
   * writable fields whose values differ are sent (undefined when nothing changes); without
   * one, every writable mapped field is sent.
   */
  private buildWrite(
    system: SystemId,
    type: CanonicalType,
    desired: Record<string, FieldValue>,
    current: CanonicalRecord | null,
    targetId: string | undefined,
  ): PlannedWrite | undefined {
    const writable = new Set(
      this.config.fieldRules(system, type)
        .filter((rule) => !rule.readOnly && !rule.native.includes('.'))
        .map((rule) => rule.canonical),
    );
    const fields: Record<string, FieldValue> = {};
    for (const [field, value] of Object.entries(desired)) {
      if (!writable.has(field)) continue;
      if (current && targetId && sameValue(current.fields[field], value)) continue;
      fields[field] = value ?? null;
    }
    if (targetId && current && !Object.keys(fields).length) return undefined;
    return {
      system,
      operation: targetId ? 'update' : 'create',
      targetId,
      fields,
      payload: this.config.fromCanonicalFields(system, type, fields),
      expectedModifiedAt: targetId ? current?.meta.modifiedAt : undefined,
    };
  }

  private fieldOwners(type: CanonicalType): Record<string, SystemId> {
    return Object.fromEntries(
      [...this.config.fieldRules('salesforce', type), ...this.config.fieldRules('hubspot', type)]
        .filter((rule) => rule.sourceOfTruth)
        .map((rule) => [rule.canonical, rule.sourceOfTruth!]),
    );
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
   * Throws MissingRequiredFieldError if a write would leave a required target field blank:
   * a create must supply every required mapped field; an update must not blank one it sends.
   * An unmapped required field is a configuration problem (preflight's
   * REQUIRED_TARGET_UNMAPPED), not a per-record data problem, so it is not checked here.
   */
  private async checkRequiredFields(to: SystemId, type: CanonicalType, write: PlannedWrite): Promise<void> {
    const rules = this.config.fieldRules(to, type).filter((rule) => !rule.readOnly && !rule.native.includes('.'));
    if (!rules.length) return;
    const schema = await this.describeCached(to, type);
    const schemaByName = new Map(schema.map((field) => [field.name.toLowerCase(), field]));
    const missing = rules
      .filter((rule) => {
        if (!schemaByName.get(rule.native.toLowerCase())?.required) return false;
        if (write.operation === 'update' && !(rule.native in write.payload)) return false;
        return isBlank(write.payload[rule.native]);
      })
      .map((rule) => schemaByName.get(rule.native.toLowerCase())!.label || rule.native);
    if (missing.length) throw new MissingRequiredFieldError(missing);
  }
}

function isBlank(value: FieldValue | undefined): boolean {
  return value === undefined || value === null || value === '';
}

function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Maps a native field name (as named in a vendor error, e.g. HubSpot's "email") back to the
 * canonical field, and returns it only if that canonical field is one of this object's
 * configured natural-key fields -- the one signal strong enough to auto-resolve a write
 * conflict without a human, since it's the same rule the app already uses to match records
 * across systems in the first place.
 */
function nativeToNaturalKeyField(
  config: ConfigContext,
  system: SystemId,
  type: CanonicalType,
  nativeName: string,
): string | undefined {
  const rule = config.fieldRules(system, type).find(
    (r) => r.native.toLowerCase() === nativeName.toLowerCase(),
  );
  if (!rule) return undefined;
  // Only a single-field key is strong enough: a duplicate on one component of a composite
  // key (e.g. a deal name without its close date) does not prove it is the same record.
  const keyFields = config.naturalKeyFields(type);
  return keyFields.length === 1 && keyFields[0] === rule.canonical ? rule.canonical : undefined;
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
