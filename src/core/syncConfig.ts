import type { ConflictStrategy } from './conflict.js';
import type { CanonicalType, FieldValue, SystemId } from './types.js';

export type SyncDirection =
  | 'bidirectional'
  | 'salesforce_to_hubspot'
  | 'hubspot_to_salesforce';

export type SyncConditionOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'lt'
  | 'contains'
  | 'is_null'
  | 'is_not_null';

/**
 * A single filter row scoped to ONE system's native schema (e.g. Salesforce's `IsPersonAccount`
 * has no HubSpot equivalent, so a condition is never canonical/cross-system -- it always
 * describes which native records on ONE side are eligible for this object's sync).
 */
export interface SyncCondition {
  field: string;
  operator: SyncConditionOperator;
  value?: FieldValue;
}

export interface SyncObjectConfig {
  enabled: boolean;
  direction: SyncDirection;
  /**
   * True once this object has been walked through the dedicated Sync setup wizard. A
   * canonical object can be registered (used by Migration) without ever being enrolled for
   * Sync -- this is what the Sync tab and the sync-scoped field-mapping queue filter on, so
   * unrelated migration-only objects don't show up there.
   */
  enrolledForSync: boolean;
  /**
   * Structured, schema-driven filter rows (AND-combined) plus an optional advanced raw SOQL
   * WHERE fragment (Salesforce only -- HubSpot's Search API has no free-text filter
   * language), keyed by the system whose native records they filter. Applied at the query
   * (SOQL WHERE / HubSpot search filter), not as a post-fetch filter, so an excluded record
   * (e.g. a Person Account) is never even read.
   */
  conditions?: Partial<Record<SystemId, SyncCondition[]>>;
  rawCondition?: Partial<Record<SystemId, string>>;
}

/**
 * Scheduled polling sync: a complement to webhook-driven sync that periodically checks both
 * CRMs for changes, for setups where webhooks aren't configured/reachable. Each object gets
 * its own enabled flag and interval ("scenario") -- e.g. Contacts every 5 minutes, Deals
 * hourly -- rather than one interval shared by every object. `objects` above still governs
 * *direction* (which system may originate a change); this only governs the polling schedule.
 */
export interface PollingConfig {
  enabled: boolean;
  intervalMinutes: number;
  /** How far back the first-ever poll looks for changes, before a cursor exists. Default 1. */
  lookbackDays?: number;
}

export interface SyncConfig {
  conflictStrategy: ConflictStrategy;
  sourceOfTruth: SystemId;
  objects: Record<CanonicalType, SyncObjectConfig>;
  polling: Record<CanonicalType, PollingConfig>;
}

export const MIN_POLLING_INTERVAL_MINUTES = 1;
export const MAX_POLLING_INTERVAL_MINUTES = 30 * 24 * 60;

export interface SyncConfigStore {
  get(): SyncConfig;
  update(config: SyncConfig): Promise<SyncConfig>;
}

/**
 * `objects` lists which canonical objects should default to enabled+bidirectional sync —
 * normally every currently-registered object (see core/objectRegistry.ts's
 * listCanonicalObjects()). No object list is hardcoded here; an empty list is valid and
 * simply means nothing syncs until objects are registered.
 */
export function defaultSyncConfig(
  conflictStrategy: ConflictStrategy,
  sourceOfTruth: SystemId,
  objects: CanonicalType[] = [],
): SyncConfig {
  return {
    conflictStrategy,
    sourceOfTruth,
    objects: Object.fromEntries(
      objects.map((type) => [
        type,
        { enabled: true, direction: 'bidirectional', enrolledForSync: true } as SyncObjectConfig,
      ]),
    ),
    // Opt-in per object: polling makes live, scheduled API calls against both CRMs, so it
    // stays off until an admin explicitly turns it on for that object from the Sync tab.
    polling: Object.fromEntries(
      objects.map((type) => [type, { enabled: false, intervalMinutes: 30 } as PollingConfig]),
    ),
  };
}

export class InMemorySyncConfigStore implements SyncConfigStore {
  constructor(private config: SyncConfig) {}

  get(): SyncConfig {
    return structuredClone(this.config);
  }

  async update(config: SyncConfig): Promise<SyncConfig> {
    this.config = structuredClone(config);
    return this.get();
  }
}

export function syncAllows(
  config: SyncConfig,
  type: CanonicalType,
  source: SystemId,
): boolean {
  const object = config.objects[type];
  if (!object?.enabled) return false;
  if (object.direction === 'bidirectional') return true;
  return object.direction === `${source}_to_${source === 'salesforce' ? 'hubspot' : 'salesforce'}`;
}

/**
 * Evaluates a set of AND-combined structured conditions against one native record's fields.
 * Pure and side-effect-free so it can be reused both server-side (to decide, on an ambiguous
 * webhook, which of several canonical objects sharing one native object a record belongs to)
 * and as the reference behavior a connector's compiled SOQL/search-filter must match.
 */
export function evaluateConditions(
  conditions: SyncCondition[] | undefined,
  nativeFields: Record<string, unknown>,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((condition) => {
    const actual = nativeFields[condition.field];
    switch (condition.operator) {
      case 'is_null':
        return actual === null || actual === undefined;
      case 'is_not_null':
        return actual !== null && actual !== undefined;
      case 'eq':
        return String(actual ?? '').toLowerCase() === String(condition.value ?? '').toLowerCase();
      case 'ne':
        return String(actual ?? '').toLowerCase() !== String(condition.value ?? '').toLowerCase();
      case 'gt':
        return Number(actual) > Number(condition.value);
      case 'lt':
        return Number(actual) < Number(condition.value);
      case 'contains':
        return String(actual ?? '').toLowerCase().includes(String(condition.value ?? '').toLowerCase());
      default:
        return true;
    }
  });
}
