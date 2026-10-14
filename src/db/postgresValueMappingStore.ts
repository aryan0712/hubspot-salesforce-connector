import type { CanonicalType } from '../core/types.js';
import type { ValueMapping } from '../core/mapping.js';
import type { ConfigContext } from '../core/configContext.js';
import type { PostgresDatabase } from './postgres.js';

export class PostgresValueMappingStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
    private readonly config: ConfigContext,
  ) {}

  async init(): Promise<void> {
    const mappings = await this.db.tenant(this.tenantId, async (client) => {
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
    this.config.configureValueMappings(mappings);
  }

  list(type?: CanonicalType, field?: string): ValueMapping[] {
    return this.config.valueMappings(type, field);
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
      const seenCanonical = new Set<string>();
      for (let i = 0; i < mappings.length; i++) {
        const mapping = mappings[i];
        if (!mapping) continue;
        let cv =
          mapping.canonicalValue?.trim() ||
          mapping.salesforceValue?.trim() ||
          mapping.hubspotValue?.trim() ||
          `value_${i + 1}`;
        if (seenCanonical.has(cv.toLowerCase())) {
          cv = `${cv}_${i + 1}`;
        }
        seenCanonical.add(cv.toLowerCase());

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
            cv,
          ],
        );
      }
    });
    // Re-read the committed rows and publish them as one revision.
    await this.init();
  }
}
