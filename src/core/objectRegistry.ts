import type { CanonicalType } from './types.js';
import type { ConfigContext } from './configContext.js';
import { validateNaturalKeyFields } from './idMap.js';
import { isNativeObjectId } from './identifiers.js';

/**
 * The OBJECT REGISTRY answers one question: for a canonical object (e.g. "contact", or a
 * custom object a tenant registered), what is its native name in each CRM? Registrations
 * live on each app's ConfigContext (core/configContext.ts) -- populated from Postgres at
 * boot and on every write -- so connectors never hardcode object names and two apps (a
 * tenant and the demo, or two tenants) never share one registry.
 */
export interface ObjectRegistration {
  canonicalObject: CanonicalType;
  label: string;
  salesforceObject?: string;
  hubspotObject?: string;
}

export interface NewObjectMapping extends ObjectRegistration {
  naturalKeyFields?: string[];
}

export interface ObjectMappingStore {
  init(): Promise<void>;
  list(): ObjectRegistration[];
  getNaturalKeyFields(type: CanonicalType): string[];
  create(input: NewObjectMapping): Promise<ObjectRegistration>;
  setNaturalKeyFields(type: CanonicalType, fields: string[]): Promise<void>;
  setNativeObjects(type: CanonicalType, input: {
    salesforceObject?: string;
    hubspotObject?: string;
  }): Promise<ObjectRegistration>;
}

/** Credential-free object registration for the mock dashboard and browser tests. */
export class InMemoryObjectMappingStore implements ObjectMappingStore {
  constructor(private readonly config: ConfigContext) {}

  async init(): Promise<void> { /* ConfigContext is already initialized by FileMappingStore. */ }

  list(): ObjectRegistration[] { return this.config.listCanonicalObjects(); }
  getNaturalKeyFields(type: CanonicalType): string[] { return this.config.naturalKeyFields(type); }

  async create(input: NewObjectMapping): Promise<ObjectRegistration> {
    if (this.config.isRegisteredCanonicalObject(input.canonicalObject)) throw new Error('object already registered');
    validateNativeObjects(input);
    const keyFields = input.naturalKeyFields?.length
      ? validateNaturalKeyFields(input.canonicalObject, input.naturalKeyFields) : [];
    const registration: ObjectRegistration = {
      canonicalObject: input.canonicalObject, label: input.label,
      salesforceObject: input.salesforceObject, hubspotObject: input.hubspotObject,
    };
    this.config.registerObjectMapping(registration);
    if (keyFields.length) this.config.configureNaturalKeyFields(input.canonicalObject, keyFields);
    return registration;
  }

  async setNaturalKeyFields(type: CanonicalType, fields: string[]): Promise<void> {
    if (!this.config.isRegisteredCanonicalObject(type)) throw new Error(`object ${type} is not registered`);
    this.config.configureNaturalKeyFields(type, fields);
  }

  async setNativeObjects(type: CanonicalType, input: {
    salesforceObject?: string; hubspotObject?: string;
  }): Promise<ObjectRegistration> {
    validateNativeObjects(input);
    const current = this.config.getObject(type);
    if (!current) throw new Error(`object ${type} is not registered`);
    const next = { ...current, ...input };
    this.config.registerObjectMapping(next);
    this.config.clearNaturalKeyFields(type);
    return next;
  }
}

function validateNativeObjects(input: { salesforceObject?: string; hubspotObject?: string }): void {
  if (input.salesforceObject && !isNativeObjectId('salesforce', input.salesforceObject)) {
    throw new Error('invalid Salesforce object API name');
  }
  if (input.hubspotObject && !isNativeObjectId('hubspot', input.hubspotObject)) {
    throw new Error('invalid HubSpot object type ID');
  }
}
