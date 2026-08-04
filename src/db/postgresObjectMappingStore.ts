import { configureNaturalKeyFields, isAllowedNaturalKeyField } from '../core/idMap.js';
import type { CanonicalType } from '../core/types.js';
import type { PostgresDatabase } from './postgres.js';

const DEFAULTS: Record<CanonicalType, string[]> = {
  contact: ['email'],
  company: ['domain'],
  deal: ['name', 'closeDate'],
};

export class PostgresObjectMappingStore {
  private keys = structuredClone(DEFAULTS);

  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async init(): Promise<void> {
    const rows = await this.db.tenant(this.tenantId, async (client) =>
      client.query<{ canonical_object: CanonicalType; natural_key_fields: string[] }>(
        `SELECT canonical_object, natural_key_fields FROM object_mappings
         WHERE tenant_id = $1 AND enabled = true`,
        [this.tenantId],
      ),
    );
    for (const row of rows.rows) {
      if (
        row.canonical_object in this.keys &&
        row.natural_key_fields.length &&
        row.natural_key_fields.length <= 3 &&
        row.natural_key_fields.every((field) =>
          isAllowedNaturalKeyField(row.canonical_object, field))
      ) {
        this.keys[row.canonical_object] = row.natural_key_fields;
      }
    }
    for (const [type, fields] of Object.entries(this.keys)) {
      configureNaturalKeyFields(type as CanonicalType, fields);
    }
  }

  get(type: CanonicalType): string[] {
    return [...this.keys[type]];
  }

  async set(type: CanonicalType, fields: string[]): Promise<void> {
    configureNaturalKeyFields(type, fields);
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO object_mappings(
           tenant_id, canonical_object, salesforce_object, hubspot_object,
           natural_key_fields
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, canonical_object) DO UPDATE SET
           natural_key_fields = EXCLUDED.natural_key_fields, updated_at = now()`,
        [
          this.tenantId,
          type,
          type === 'contact' ? 'Contact' : type === 'company' ? 'Account' : 'Opportunity',
          type === 'contact' ? 'contacts' : type === 'company' ? 'companies' : 'deals',
          fields,
        ],
      );
    });
    this.keys[type] = [...fields];
  }
}
