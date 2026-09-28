import type { CanonicalType } from './types.js';

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
