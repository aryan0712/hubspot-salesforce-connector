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

export interface SyncConfig {
  conflictStrategy: ConflictStrategy;
  sourceOfTruth: SystemId;
  objects: Record<CanonicalType, SyncObjectConfig>;
}

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
