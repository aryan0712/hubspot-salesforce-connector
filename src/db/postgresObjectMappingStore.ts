import { isAllowedNaturalKeyField, validateNaturalKeyFields } from '../core/idMap.js';
import type { ObjectRegistration, ObjectMappingStore, NewObjectMapping } from '../core/objectRegistry.js';
import type { ConfigContext } from '../core/configContext.js';
import type { CanonicalType } from '../core/types.js';
import { isNativeObjectId } from '../core/identifiers.js';
import type { PostgresDatabase } from './postgres.js';

interface ObjectMappingRow {
  canonical_object: string;
  label: string;
  salesforce_object: string | null;
  hubspot_object: string | null;
  natural_key_fields: string[];
}

/**
 * The tenant's object registry: which canonical objects exist, and their native name in each
 * CRM. Backed by object_mappings, which already stores salesforce_object/hubspot_object per
 * row -- this class persists whatever native names a caller actually selected, rather than
 * re-deriving them from a fixed contact/company/deal ternary. It hydrates and updates only
 * its own tenant's ConfigContext, always persisting before publishing.
 */
export class PostgresObjectMappingStore implements ObjectMappingStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
    private readonly config: ConfigContext,
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
    this.config.publish((draft) => {
      for (const row of rows.rows) {
        draft.objects.set(row.canonical_object, {
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
          draft.naturalKeys[row.canonical_object] = [...new Set(row.natural_key_fields)];
        }
      }
    }, rows.rows.map((row) => row.canonical_object));
  }

  list(): ObjectRegistration[] {
    return this.config.listCanonicalObjects();
  }

  getNaturalKeyFields(type: CanonicalType): string[] {
    return this.config.naturalKeyFields(type);
  }

  /** Registers a brand-new canonical object with the native names the operator picked. */
  async create(input: NewObjectMapping): Promise<ObjectRegistration> {
    if (input.salesforceObject && !isNativeObjectId('salesforce', input.salesforceObject)) {
      throw new Error('invalid Salesforce object API name');
    }
    if (input.hubspotObject && !isNativeObjectId('hubspot', input.hubspotObject)) {
      throw new Error('invalid HubSpot object type ID');
    }
    const naturalKeyFields = input.naturalKeyFields?.length
      ? validateNaturalKeyFields(input.canonicalObject, input.naturalKeyFields)
      : [];
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
          naturalKeyFields,
        ],
      );
    });
    const registration: ObjectRegistration = {
      canonicalObject: input.canonicalObject,
      label: input.label,
      salesforceObject: input.salesforceObject,
      hubspotObject: input.hubspotObject,
    };
    this.config.publish((draft) => {
      draft.objects.set(registration.canonicalObject, { ...registration });
      if (naturalKeyFields.length) draft.naturalKeys[registration.canonicalObject] = naturalKeyFields;
    }, [registration.canonicalObject]);
    return registration;
  }

  /** Updates natural-key fields for an already-registered object; native names are untouched. */
  async setNaturalKeyFields(type: CanonicalType, fields: string[]): Promise<void> {
    const normalized = validateNaturalKeyFields(type, fields);
    const result = await this.db.tenant(this.tenantId, async (client) =>
      client.query(
        `UPDATE object_mappings SET natural_key_fields = $3, updated_at = now()
         WHERE tenant_id = $1 AND canonical_object = $2`,
        [this.tenantId, type, normalized],
      ),
    );
    if (result.rowCount === 0) {
      throw new Error(`object "${type}" is not registered; create it before setting natural keys`);
    }
    this.config.configureNaturalKeyFields(type, normalized);
  }

  /**
   * Re-points an already-registered canonical object at a different native object on either
   * (or both) sides -- e.g. fixing "Account -> Contact" to "Account -> Company" without
   * deleting and recreating the whole registration (which would also lose polling config and
   * history). Field mappings and the natural key are the caller's responsibility to reset --
   * they describe the OLD native object's fields and rarely make sense on the new one.
   */
  async setNativeObjects(
    type: CanonicalType,
    input: { salesforceObject?: string; hubspotObject?: string },
  ): Promise<ObjectRegistration> {
    if (input.salesforceObject && !isNativeObjectId('salesforce', input.salesforceObject)) {
      throw new Error('invalid Salesforce object API name');
    }
    if (input.hubspotObject && !isNativeObjectId('hubspot', input.hubspotObject)) {
      throw new Error('invalid HubSpot object type ID');
    }
    const result = await this.db.tenant(this.tenantId, async (client) =>
      client.query<{ label: string }>(
        `UPDATE object_mappings SET salesforce_object = $3, hubspot_object = $4,
                natural_key_fields = '{}', updated_at = now()
         WHERE tenant_id = $1 AND canonical_object = $2
         RETURNING label`,
        [this.tenantId, type, input.salesforceObject ?? null, input.hubspotObject ?? null],
      ),
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`object "${type}" is not registered; create it before changing its native objects`);
    }
    const registration: ObjectRegistration = {
      canonicalObject: type,
      label: row.label,
      salesforceObject: input.salesforceObject,
      hubspotObject: input.hubspotObject,
    };
    this.config.publish((draft) => {
      draft.objects.set(type, { ...registration });
      delete draft.naturalKeys[type];
    }, [type]);
    return registration;
  }
}
