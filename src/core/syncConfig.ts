import type { ConflictStrategy } from './conflict.js';
import type { CanonicalType, SystemId } from './types.js';

export type SyncDirection =
  | 'bidirectional'
  | 'salesforce_to_hubspot'
  | 'hubspot_to_salesforce';

export interface SyncObjectConfig {
  enabled: boolean;
  direction: SyncDirection;
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
      objects.map((type) => [type, { enabled: true, direction: 'bidirectional' } as SyncObjectConfig]),
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
