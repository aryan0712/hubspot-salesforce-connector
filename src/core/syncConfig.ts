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

export function defaultSyncConfig(
  conflictStrategy: ConflictStrategy,
  sourceOfTruth: SystemId,
): SyncConfig {
  return {
    conflictStrategy,
    sourceOfTruth,
    objects: {
      contact: { enabled: true, direction: 'bidirectional' },
      company: { enabled: true, direction: 'bidirectional' },
      deal: { enabled: true, direction: 'bidirectional' },
    },
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
  if (!object.enabled) return false;
  if (object.direction === 'bidirectional') return true;
  return object.direction === `${source}_to_${source === 'salesforce' ? 'hubspot' : 'salesforce'}`;
}
