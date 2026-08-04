import type { CanonicalType, SystemId } from '../core/types.js';
import {
  configureFieldRules,
  fieldRules,
  type FieldRule,
  type TransformId,
} from '../core/mapping.js';
import type { MappingStore } from '../core/mappingStore.js';
import type { PostgresDatabase } from './postgres.js';

interface MappingRow {
  canonical_field: string;
  native_field: string;
  to_canonical_transform: TransformId | null;
  from_canonical_transform: TransformId | null;
  read_only: boolean;
  source_of_truth: SystemId | null;
}

export class PostgresMappingStore implements MappingStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async init(): Promise<void> {
    for (const system of ['salesforce', 'hubspot'] as const) {
      for (const type of ['contact', 'company', 'deal'] as const) {
        const mapping = await this.load(system, type);
        if (mapping.configured) configureFieldRules(system, type, mapping.rules);
      }
    }
  }

  get(system: SystemId, type: CanonicalType): FieldRule[] {
    return fieldRules(system, type);
  }

  async set(system: SystemId, type: CanonicalType, rules: FieldRule[]): Promise<void> {
    configureFieldRules(system, type, rules);
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO field_mapping_sets(tenant_id, system, object_type)
         VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, system, object_type) DO UPDATE SET updated_at = now()`,
        [this.tenantId, system, type],
      );
      await client.query(
        `DELETE FROM field_mappings
         WHERE tenant_id = $1 AND system = $2 AND object_type = $3`,
        [this.tenantId, system, type],
      );
      for (const [index, rule] of rules.entries()) {
        await client.query(
          `INSERT INTO field_mappings(
             tenant_id, system, object_type, canonical_field, native_field,
             to_canonical_transform, from_canonical_transform, read_only,
             source_of_truth, sort_order
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            this.tenantId,
            system,
            type,
            rule.canonical,
            rule.native,
            rule.toCanonical ?? null,
            rule.fromCanonical ?? null,
            rule.readOnly ?? false,
            rule.sourceOfTruth ?? null,
            index,
          ],
        );
      }
    });
  }

  private async load(
    system: SystemId,
    type: CanonicalType,
  ): Promise<{ configured: boolean; rules: FieldRule[] }> {
    return this.db.tenant(this.tenantId, async (client) => {
      const [setResult, result] = await Promise.all([
        client.query(
          `SELECT 1 FROM field_mapping_sets
           WHERE tenant_id = $1 AND system = $2 AND object_type = $3`,
          [this.tenantId, system, type],
        ),
        client.query<MappingRow>(
          `SELECT canonical_field, native_field, to_canonical_transform,
                from_canonical_transform, read_only, source_of_truth
           FROM field_mappings
           WHERE tenant_id = $1 AND system = $2 AND object_type = $3 AND enabled = true
           ORDER BY sort_order, canonical_field`,
          [this.tenantId, system, type],
        ),
      ]);
      return {
        configured: Boolean(setResult.rowCount || result.rowCount),
        rules: result.rows.map((row) => ({
          canonical: row.canonical_field,
          native: row.native_field,
          toCanonical: row.to_canonical_transform ?? undefined,
          fromCanonical: row.from_canonical_transform ?? undefined,
          readOnly: row.read_only,
          sourceOfTruth: row.source_of_truth ?? undefined,
        })),
      };
    });
  }
}
