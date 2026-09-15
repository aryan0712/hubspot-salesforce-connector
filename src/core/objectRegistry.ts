import type { CanonicalType, SystemId } from './types.js';

/**
 * The OBJECT REGISTRY answers one question: for a canonical object (e.g. "contact", or a
 * custom object a tenant registered), what is its native name in each CRM? This mirrors the
 * configureFieldRules/fieldRules pattern in mapping.ts — an in-memory cache populated from
 * Postgres at boot and on every write, so connectors never hardcode object names.
 */

export interface ObjectRegistration {
  canonicalObject: CanonicalType;
  label: string;
  salesforceObject?: string;
  hubspotObject?: string;
}

const REGISTRY = new Map<CanonicalType, ObjectRegistration>();

export function configureObjectMappings(registrations: ObjectRegistration[]): void {
  REGISTRY.clear();
  for (const registration of registrations) {
    REGISTRY.set(registration.canonicalObject, { ...registration });
  }
}

export function registerObjectMapping(registration: ObjectRegistration): void {
  REGISTRY.set(registration.canonicalObject, { ...registration });
}

export function nativeObjectName(system: SystemId, type: CanonicalType): string | undefined {
  const entry = REGISTRY.get(type);
  return system === 'salesforce' ? entry?.salesforceObject : entry?.hubspotObject;
}

export function requireNativeObjectName(system: SystemId, type: CanonicalType): string {
  const native = nativeObjectName(system, type);
  if (!native) {
    throw new Error(`no ${system} object is registered for canonical object "${type}"`);
  }
  return native;
}

export function canonicalObjectFor(system: SystemId, nativeObjectId: string): CanonicalType | undefined {
  return canonicalObjectsFor(system, nativeObjectId)[0]?.canonicalObject;
}

/**
 * All canonical objects registered against one native object in a system. Usually a single
 * entry, but a native object can legitimately back more than one canonical object at once
 * (e.g. Salesforce Account -> both "company" and a separately-registered "person_account"
 * routed to HubSpot contacts) -- each disambiguated at sync time by its own condition. Callers
 * that need a single answer for an ambiguous native object should resolve it against a real
 * record's fields (see engine/typeResolver.ts) rather than guessing from this list's order.
 */
export function canonicalObjectsFor(system: SystemId, nativeObjectId: string): ObjectRegistration[] {
  const matches: ObjectRegistration[] = [];
  for (const entry of REGISTRY.values()) {
    if ((system === 'salesforce' ? entry.salesforceObject : entry.hubspotObject) === nativeObjectId) {
      matches.push({ ...entry });
    }
  }
  return matches;
}

export function listCanonicalObjects(): ObjectRegistration[] {
  return [...REGISTRY.values()].map((entry) => ({ ...entry }));
}

export function isRegisteredCanonicalObject(type: string): boolean {
  return REGISTRY.has(type);
}

export function resetObjectRegistry(): void {
  REGISTRY.clear();
}

/** Turns a human label into a stable canonical key, deduped against what's already registered. */
export function slugifyCanonicalObject(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'object';
  if (!REGISTRY.has(base)) return base;
  let suffix = 2;
  while (REGISTRY.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}
