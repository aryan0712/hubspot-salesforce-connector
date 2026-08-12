import { configureNaturalKeyFields, isAllowedNaturalKeyField, naturalKeyFields } from '../core/idMap.js';
import {
  listCanonicalObjects,
  registerObjectMapping,
  type ObjectRegistration,
} from '../core/objectRegistry.js';
import type { CanonicalType } from '../core/types.js';
import type { PostgresDatabase } from './postgres.js';

interface ObjectMappingRow {
  canonical_object: string;
  label: string;
  salesforce_object: string | null;
  hubspot_object: string | null;
  natural_key_fields: string[];
}

export interface NewObjectMapping {
  canonicalObject: string;
  label: string;
  salesforceObject?: string;
  hubspotObject?: string;
  naturalKeyFields?: string[];
}

/**
 * The tenant's object registry: which canonical objects exist, and their native name in each
 * CRM. Backed by object_mappings, which already stores salesforce_object/hubspot_object per
 * row — this class persists whatever native names a caller actually selected, rather than
 * re-deriving them from a fixed contact/company/deal ternary.
 */
export class PostgresObjectMappingStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async init(): Promise<void> {
    const rows = await this.db.tenant(this.tenantId, async (client) =>
      client.query<ObjectMappingRow>(
        `SELECT canonical_object, label, salesforce_object, hubspot_object, natural_key_fields
         FROM object_mappings
         WHERE tenant_id = $1 AND enabled = true`,
        [this.tenantId],
      ),
    );
    for (const row of rows.rows) {
      registerObjectMapping({
        canonicalObject: row.canonical_object,
        label: row.label,
        salesforceObject: row.salesforce_object ?? undefined,
        hubspotObject: row.hubspot_object ?? undefined,
      });
      if (
        row.natural_key_fields.length &&
        row.natural_key_fields.length <= 3 &&
        row.natural_key_fields.every((field) =>
          isAllowedNaturalKeyField(row.canonical_object, field))
      ) {
        configureNaturalKeyFields(row.canonical_object, row.natural_key_fields);
      }
    }
  }

  list(): ObjectRegistration[] {
    return listCanonicalObjects();
  }

  getNaturalKeyFields(type: CanonicalType): string[] {
    return naturalKeyFields(type);
  }

  /** Registers a brand-new canonical object with the native names the operator picked. */
  async create(input: NewObjectMapping): Promise<ObjectRegistration> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO object_mappings(
           tenant_id, canonical_object, label, salesforce_object, hubspot_object,
           natural_key_fields
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          this.tenantId,
          input.canonicalObject,
          input.label,
          input.salesforceObject ?? null,
          input.hubspotObject ?? null,
          input.naturalKeyFields ?? [],
        ],
      );
    });
    const registration: ObjectRegistration = {
      canonicalObject: input.canonicalObject,
      label: input.label,
      salesforceObject: input.salesforceObject,
      hubspotObject: input.hubspotObject,
    };
    registerObjectMapping(registration);
    if (input.naturalKeyFields?.length) {
      configureNaturalKeyFields(input.canonicalObject, input.naturalKeyFields);
    }
    return registration;
  }

  /** Updates natural-key fields for an already-registered object; native names are untouched. */
  async setNaturalKeyFields(type: CanonicalType, fields: string[]): Promise<void> {
    configureNaturalKeyFields(type, fields);
    const result = await this.db.tenant(this.tenantId, async (client) =>
      client.query(
        `UPDATE object_mappings SET natural_key_fields = $3, updated_at = now()
         WHERE tenant_id = $1 AND canonical_object = $2`,
        [this.tenantId, type, fields],
      ),
    );
    if (result.rowCount === 0) {
      throw new Error(`object "${type}" is not registered; create it before setting natural keys`);
    }
  }
}
