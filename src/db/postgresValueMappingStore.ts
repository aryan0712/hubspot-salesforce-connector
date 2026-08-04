import type { CanonicalType } from '../core/types.js';
import {
  configureValueMappings,
  type ValueMapping,
} from '../core/mapping.js';
import type { PostgresDatabase } from './postgres.js';

export class PostgresValueMappingStore {
  private cache: ValueMapping[] = [];

  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async init(): Promise<void> {
    this.cache = await this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{
        object_type: CanonicalType;
        canonical_field: string;
        canonical_value: string;
        salesforce_value: string | null;
        hubspot_value: string | null;
      }>(
        `SELECT object_type, canonical_field, canonical_value,
                salesforce_value, hubspot_value
         FROM value_mappings WHERE tenant_id = $1
         ORDER BY object_type, canonical_field, canonical_value`,
        [this.tenantId],
      );
      return result.rows.map((row) => ({
        type: row.object_type,
        canonicalField: row.canonical_field,
        canonicalValue: row.canonical_value,
        salesforceValue: row.salesforce_value ?? undefined,
        hubspotValue: row.hubspot_value ?? undefined,
      }));
    });
    configureValueMappings(this.cache);
  }

  list(type?: CanonicalType, field?: string): ValueMapping[] {
    return this.cache
      .filter(
        (mapping) =>
          (!type || mapping.type === type) &&
          (!field || mapping.canonicalField === field),
      )
      .map((mapping) => ({ ...mapping }));
  }

  async replace(
    type: CanonicalType,
    field: string,
    mappings: Omit<ValueMapping, 'type' | 'canonicalField'>[],
  ): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `DELETE FROM value_mappings
         WHERE tenant_id = $1 AND object_type = $2 AND canonical_field = $3`,
        [this.tenantId, type, field],
      );
      for (const mapping of mappings) {
        await client.query(
          `INSERT INTO value_mappings(
             tenant_id, object_type, canonical_field, salesforce_value,
             hubspot_value, canonical_value
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            this.tenantId,
            type,
            field,
            mapping.salesforceValue ?? null,
            mapping.hubspotValue ?? null,
            mapping.canonicalValue,
          ],
        );
      }
    });
    await this.init();
  }
}
