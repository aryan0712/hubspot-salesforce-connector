import type { FieldRule } from './mapping.js';

/**
 * Seed data for the three built-in canonical objects. This is the ONLY place this data is
 * defined — core/mapping.ts and core/idMap.ts carry no object-specific data, only mechanism.
 * Consumers:
 *   - db/migrations/008_open_object_model.sql inserts this same shape for existing tenants
 *     (kept in sync by hand since SQL can't import TS — see that migration's comment).
 *   - db/tenantRepository.ts seeds a brand new tenant with it.
 *   - cli/demo.ts and test/ fixtures configure it directly for zero-Postgres runs.
 */
export interface DefaultObject {
  canonicalObject: string;
  label: string;
  salesforceObject: string;
  hubspotObject: string;
  naturalKeyFields: string[];
  fieldRules: {
    salesforce: FieldRule[];
    hubspot: FieldRule[];
  };
}

export const DEFAULT_OBJECTS: DefaultObject[] = [
  {
    canonicalObject: 'contact',
    label: 'Contact',
    salesforceObject: 'Contact',
    hubspotObject: 'contacts',
    naturalKeyFields: ['email'],
    fieldRules: {
      salesforce: [
        { canonical: 'firstName', native: 'FirstName' },
        { canonical: 'lastName', native: 'LastName' },
        { canonical: 'email', native: 'Email' },
        { canonical: 'phone', native: 'Phone' },
        { canonical: 'title', native: 'Title' },
        { canonical: 'ownerId', native: 'OwnerId' },
        { canonical: 'companyName', native: 'Account.Name', readOnly: true },
      ],
      hubspot: [
        { canonical: 'firstName', native: 'firstname' },
        { canonical: 'lastName', native: 'lastname' },
        { canonical: 'email', native: 'email' },
        { canonical: 'phone', native: 'phone' },
        { canonical: 'title', native: 'jobtitle' },
        { canonical: 'companyName', native: 'company' },
        { canonical: 'ownerId', native: 'hubspot_owner_id' },
      ],
    },
  },
  {
    canonicalObject: 'company',
    label: 'Company',
    salesforceObject: 'Account',
    hubspotObject: 'companies',
    naturalKeyFields: ['domain'],
    fieldRules: {
      salesforce: [
        { canonical: 'name', native: 'Name' },
        { canonical: 'domain', native: 'Website', toCanonical: 'domain' },
        { canonical: 'phone', native: 'Phone' },
        { canonical: 'industry', native: 'Industry' },
        { canonical: 'employeeCount', native: 'NumberOfEmployees' },
        { canonical: 'ownerId', native: 'OwnerId' },
      ],
      hubspot: [
        { canonical: 'name', native: 'name' },
        { canonical: 'domain', native: 'domain', toCanonical: 'domain' },
        { canonical: 'phone', native: 'phone' },
        { canonical: 'industry', native: 'industry' },
        { canonical: 'employeeCount', native: 'numberofemployees' },
        { canonical: 'ownerId', native: 'hubspot_owner_id' },
      ],
    },
  },
  {
    canonicalObject: 'deal',
    label: 'Deal',
    salesforceObject: 'Opportunity',
    hubspotObject: 'deals',
    naturalKeyFields: ['name', 'closeDate'],
    fieldRules: {
      salesforce: [
        { canonical: 'name', native: 'Name' },
        { canonical: 'amount', native: 'Amount' },
        { canonical: 'stage', native: 'StageName', toCanonical: 'lowercase' },
        { canonical: 'closeDate', native: 'CloseDate' },
        { canonical: 'pipeline', native: 'RecordTypeId', readOnly: true },
        { canonical: 'ownerId', native: 'OwnerId' },
      ],
      hubspot: [
        { canonical: 'name', native: 'dealname' },
        { canonical: 'amount', native: 'amount' },
        { canonical: 'stage', native: 'dealstage', toCanonical: 'lowercase' },
        { canonical: 'closeDate', native: 'closedate' },
        { canonical: 'pipeline', native: 'pipeline' },
        { canonical: 'ownerId', native: 'hubspot_owner_id' },
      ],
    },
  },
];

/** Applies the default objects to the in-process registry + mapping caches (no Postgres). */
export async function applyDefaultObjects(): Promise<void> {
  const { configureFieldRules } = await import('./mapping.js');
  const { configureNaturalKeyFields } = await import('./idMap.js');
  const { configureObjectMappings } = await import('./objectRegistry.js');

  configureObjectMappings(
    DEFAULT_OBJECTS.map((object) => ({
      canonicalObject: object.canonicalObject,
      label: object.label,
      salesforceObject: object.salesforceObject,
      hubspotObject: object.hubspotObject,
    })),
  );
  for (const object of DEFAULT_OBJECTS) {
    configureFieldRules('salesforce', object.canonicalObject, object.fieldRules.salesforce);
    configureFieldRules('hubspot', object.canonicalObject, object.fieldRules.hubspot);
    configureNaturalKeyFields(object.canonicalObject, object.naturalKeyFields);
  }
}
