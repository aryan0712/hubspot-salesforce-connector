import type { PostgresDatabase } from './postgres.js';
import {
  type SyncConfig,
  type SyncConfigStore,
} from '../core/syncConfig.js';

export class PostgresSyncConfigStore implements SyncConfigStore {
  private config: SyncConfig;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
    defaults: SyncConfig,
  ) {
    this.config = structuredClone(defaults);
  }

  async init(): Promise<void> {
    const result = await this.db.pool.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM tenants WHERE id = $1',
      [this.tenantId],
    );
    const saved = result.rows[0]?.settings?.sync;
    if (saved && typeof saved === 'object') {
      this.config = mergeConfig(this.config, saved as Partial<SyncConfig>);
    }
  }

  get(): SyncConfig {
    return structuredClone(this.config);
  }

  async update(config: SyncConfig): Promise<SyncConfig> {
    await this.db.pool.query(
      `UPDATE tenants
       SET settings = jsonb_set(settings, '{sync}', $2::jsonb, true), updated_at = now()
       WHERE id = $1`,
      [this.tenantId, JSON.stringify(config)],
    );
    this.config = structuredClone(config);
    return this.get();
  }
}

function mergeConfig(defaults: SyncConfig, saved: Partial<SyncConfig>): SyncConfig {
  const types = new Set([...Object.keys(defaults.objects), ...Object.keys(saved.objects ?? {})]);
  const objects: SyncConfig['objects'] = {};
  for (const type of types) {
    const merged = { ...defaults.objects[type], ...saved.objects?.[type] };
    if (merged.enabled !== undefined && merged.direction !== undefined) {
      objects[type] = merged as SyncConfig['objects'][string];
    }
  }
  return {
    conflictStrategy: saved.conflictStrategy ?? defaults.conflictStrategy,
    sourceOfTruth: saved.sourceOfTruth ?? defaults.sourceOfTruth,
    objects,
  };
}
