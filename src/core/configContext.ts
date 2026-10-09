import crypto from 'node:crypto';
import type {
  CanonicalRecord,
  CanonicalType,
  FieldValue,
  NaturalKeyQuery,
  SystemId,
} from './types.js';
import {
  applyFieldRules,
  readFieldRules,
  translateFromCanonical,
  translateToCanonical,
  validateFieldRules,
  type FieldRule,
  type ValueMapping,
} from './mapping.js';
import {
  buildNaturalKeyQuery,
  validateNaturalKeyFields,
} from './idMap.js';
import type { ObjectRegistration } from './objectRegistry.js';
import { DEFAULT_OBJECTS, isBuiltInObjectPair } from './defaultObjects.js';
import { isNativeObjectId } from './identifiers.js';

/**
 * CONFIGURATION CONTEXT
 * ---------------------
 * Everything that decides how a record is translated and matched -- object registrations,
 * field rules, value translations and natural-key rules -- lives in one instance-owned
 * context. Each app (a tenant's live app, the demo playground, a test) builds its own and
 * injects it into connectors, the reconciler, preflight and stores; nothing mutates shared
 * process state, so initializing the demo can never change a tenant's mappings.
 *
 * Reads are served from an immutable snapshot. Writers build a complete replacement and
 * swap it in with a single assignment (see publish()), so a reader never observes half of
 * a change, and each published snapshot carries a new revision number. Stores persist
 * first and publish afterwards, so a failed write never leaves an unsaved mapping live.
 */
export interface ConfigSnapshot {
  readonly revision: number;
  readonly objects: ReadonlyMap<CanonicalType, ObjectRegistration>;
  readonly fieldRules: Readonly<Record<SystemId, Readonly<Record<CanonicalType, FieldRule[]>>>>;
  readonly valueMappings: readonly ValueMapping[];
  readonly naturalKeys: Readonly<Record<CanonicalType, string[]>>;
}

export interface ConfigDraft {
  objects: Map<CanonicalType, ObjectRegistration>;
  fieldRules: Record<SystemId, Record<CanonicalType, FieldRule[]>>;
  valueMappings: ValueMapping[];
  naturalKeys: Record<CanonicalType, string[]>;
}

export type ConfigChangeListener = (change: {
  revision: number;
  previousRevision: number;
  types: CanonicalType[];
}) => void;

export class ConfigContext {
  private snapshot: ConfigSnapshot;
  private readonly listeners: ConfigChangeListener[] = [];

  constructor(readonly name: string, initial?: Partial<ConfigDraft>) {
    this.snapshot = freeze(
      {
        objects: new Map(initial?.objects ?? []),
        fieldRules: {
          salesforce: { ...(initial?.fieldRules?.salesforce ?? {}) },
          hubspot: { ...(initial?.fieldRules?.hubspot ?? {}) },
        },
        valueMappings: [...(initial?.valueMappings ?? [])],
        naturalKeys: { ...(initial?.naturalKeys ?? {}) },
      },
      1,
    );
  }

  /** One consistent view; hold on to it when several reads must agree with each other. */
  current(): ConfigSnapshot {
    return this.snapshot;
  }

  get revision(): number {
    return this.snapshot.revision;
  }

  /** Notified after each publish -- used to invalidate approvals and canaries. */
  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  /**
   * Atomically replace the configuration. The mutator edits a private deep copy; it is
   * validated and published only if the mutator returns without throwing.
   */
  publish(mutator: (draft: ConfigDraft) => void, changedTypes: CanonicalType[] = []): ConfigSnapshot {
    const previous = this.snapshot;
    const draft = thaw(previous);
    mutator(draft);
    const next = freeze(draft, previous.revision + 1);
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      listener({ revision: next.revision, previousRevision: previous.revision, types: changedTypes });
    }
    return next;
  }

  // ---------------------------------------------------------------- object registry

  listCanonicalObjects(): ObjectRegistration[] {
    return [...this.snapshot.objects.values()].map((entry) => ({ ...entry }));
  }

  isRegisteredCanonicalObject(type: string): boolean {
    return this.snapshot.objects.has(type);
  }

  getObject(type: CanonicalType): ObjectRegistration | undefined {
    const entry = this.snapshot.objects.get(type);
    return entry ? { ...entry } : undefined;
  }

  nativeObjectName(system: SystemId, type: CanonicalType): string | undefined {
    const entry = this.snapshot.objects.get(type);
    return system === 'salesforce' ? entry?.salesforceObject : entry?.hubspotObject;
  }

  requireNativeObjectName(system: SystemId, type: CanonicalType): string {
    const native = this.nativeObjectName(system, type);
    if (!native) {
      throw new Error(`no ${system} object is registered for canonical object "${type}"`);
    }
    if (!isNativeObjectId(system, native)) throw new Error(`invalid ${system} object identifier`);
    return native;
  }

  canonicalObjectFor(system: SystemId, nativeObjectId: string): CanonicalType | undefined {
    return this.canonicalObjectsFor(system, nativeObjectId)[0]?.canonicalObject;
  }

  /**
   * All canonical objects registered against one native object. A native object can back
   * several canonical objects (each disambiguated by its own sync condition -- see
   * engine/typeResolver.ts); callers needing one answer must resolve against a record.
   */
  canonicalObjectsFor(system: SystemId, nativeObjectId: string): ObjectRegistration[] {
    const matches: ObjectRegistration[] = [];
    for (const entry of this.snapshot.objects.values()) {
      if ((system === 'salesforce' ? entry.salesforceObject : entry.hubspotObject) === nativeObjectId) {
        matches.push({ ...entry });
      }
    }
    return matches;
  }

  /** Turns a human label into a stable canonical key, deduped against what's registered. */
  slugifyCanonicalObject(label: string): string {
    const base = label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'object';
    if (!this.snapshot.objects.has(base)) return base;
    let suffix = 2;
    while (this.snapshot.objects.has(`${base}_${suffix}`)) suffix += 1;
    return `${base}_${suffix}`;
  }

  configureObjectMappings(registrations: ObjectRegistration[]): void {
    validateRegistrations(registrations);
    this.publish(
      (draft) => {
        draft.objects = new Map(registrations.map((entry) => [entry.canonicalObject, { ...entry }]));
      },
      registrations.map((entry) => entry.canonicalObject),
    );
  }

  registerObjectMapping(registration: ObjectRegistration): void {
    validateRegistrations([registration]);
    this.publish((draft) => {
      draft.objects.set(registration.canonicalObject, { ...registration });
    }, [registration.canonicalObject]);
  }

  // ---------------------------------------------------------------- field mapping

  fieldRules(system: SystemId, type: CanonicalType): FieldRule[] {
    return readFieldRules(this.snapshot.fieldRules, system, type);
  }

  configureFieldRules(system: SystemId, type: CanonicalType, rules: FieldRule[]): void {
    validateFieldRules(rules);
    this.publish((draft) => applyFieldRules(draft.fieldRules, system, type, rules), [type]);
  }

  configureValueMappings(mappings: ValueMapping[]): void {
    const types = [...new Set(mappings.map((mapping) => mapping.type))];
    this.publish((draft) => {
      draft.valueMappings = mappings.map((mapping) => ({ ...mapping }));
    }, types);
  }

  toCanonicalFields(
    system: SystemId,
    type: CanonicalType,
    native: Record<string, unknown>,
  ): Record<string, FieldValue> {
    return translateToCanonical(this.snapshot, system, type, native,
      !isBuiltInObjectPair(this.snapshot.objects.get(type)));
  }

  fromCanonicalFields(
    system: SystemId,
    type: CanonicalType,
    fields: Record<string, FieldValue>,
  ): Record<string, FieldValue> {
    return translateFromCanonical(this.snapshot, system, type, fields,
      !isBuiltInObjectPair(this.snapshot.objects.get(type)));
  }

  /**
   * Native field names to request for a type, de-duplicated case-insensitively: two
   * canonical fields may alias one native field, but a query may name it only once.
   */
  nativeFields(system: SystemId, type: CanonicalType): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const rule of this.snapshot.fieldRules[system][type] ?? []) {
      const key = rule.native.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rule.native);
    }
    return out;
  }

  nativeField(system: SystemId, type: CanonicalType, canonical: string): string | undefined {
    return (this.snapshot.fieldRules[system][type] ?? []).find((rule) => rule.canonical === canonical)?.native;
  }

  valueMappings(type?: CanonicalType, field?: string): ValueMapping[] {
    return this.snapshot.valueMappings
      .filter((mapping) => (!type || mapping.type === type) && (!field || mapping.canonicalField === field))
      .map((mapping) => ({ ...mapping }));
  }

  // ---------------------------------------------------------------- natural keys

  naturalKeyFields(type: CanonicalType): string[] {
    return [...(this.snapshot.naturalKeys[type] ?? [])];
  }

  configureNaturalKeyFields(type: CanonicalType, fields: string[]): void {
    const normalized = validateNaturalKeyFields(type, fields);
    this.publish((draft) => {
      draft.naturalKeys[type] = normalized;
    }, [type]);
  }

  /** Used when an object's native pairing changes and the old key no longer applies. */
  clearNaturalKeyFields(type: CanonicalType): void {
    this.publish((draft) => {
      delete draft.naturalKeys[type];
    }, [type]);
  }

  naturalKeyQuery(record: CanonicalRecord): NaturalKeyQuery | undefined {
    return buildNaturalKeyQuery(record, this.snapshot.naturalKeys[record.type] ?? []);
  }

  naturalKey(record: CanonicalRecord): string | undefined {
    return this.naturalKeyQuery(record)?.key;
  }

  // ---------------------------------------------------------------- approval binding

  /**
   * A deterministic fingerprint of everything that affects how the given objects are read,
   * translated, matched and written. Approvals and canaries record it; any mapping change
   * that could alter an approved write changes the fingerprint and invalidates them.
   */
  fingerprint(types?: CanonicalType[]): string {
    const selected = (types ?? [...this.snapshot.objects.keys()]).slice().sort();
    const body = selected.map((type) => ({
      type,
      object: this.snapshot.objects.get(type) ?? null,
      salesforce: this.snapshot.fieldRules.salesforce[type] ?? [],
      hubspot: this.snapshot.fieldRules.hubspot[type] ?? [],
      naturalKeys: this.snapshot.naturalKeys[type] ?? [],
      values: this.snapshot.valueMappings
        .filter((mapping) => mapping.type === type)
        .map((mapping) => [
          mapping.canonicalField,
          mapping.canonicalValue,
          mapping.salesforceValue ?? null,
          mapping.hubspotValue ?? null,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    }));
    return crypto.createHash('sha256').update(stableJson(body)).digest('hex');
  }
}

/** A fresh context seeded with the built-in contact/company/deal objects (no persistence). */
export function createDefaultConfigContext(name = 'defaults'): ConfigContext {
  const context = new ConfigContext(name);
  applyDefaultObjectsTo(context);
  return context;
}

/** Applies the built-in default objects to one context in a single atomic publish. */
export function applyDefaultObjectsTo(context: ConfigContext): void {
  for (const object of DEFAULT_OBJECTS) {
    validateFieldRules(object.fieldRules.salesforce);
    validateFieldRules(object.fieldRules.hubspot);
    validateNaturalKeyFields(object.canonicalObject, object.naturalKeyFields);
  }
  context.publish((draft) => {
    draft.objects = new Map(
      DEFAULT_OBJECTS.map((object) => [
        object.canonicalObject,
        {
          canonicalObject: object.canonicalObject,
          label: object.label,
          salesforceObject: object.salesforceObject,
          hubspotObject: object.hubspotObject,
        },
      ]),
    );
    for (const object of DEFAULT_OBJECTS) {
      applyFieldRules(draft.fieldRules, 'salesforce', object.canonicalObject, object.fieldRules.salesforce);
      applyFieldRules(draft.fieldRules, 'hubspot', object.canonicalObject, object.fieldRules.hubspot);
      draft.naturalKeys[object.canonicalObject] = [...new Set(object.naturalKeyFields)];
    }
  }, DEFAULT_OBJECTS.map((object) => object.canonicalObject));
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

function validateRegistrations(registrations: ObjectRegistration[]): void {
  for (const registration of registrations) {
    if (!registration.canonicalObject.trim()) throw new Error('canonical object name is required');
    if (registration.salesforceObject && !isNativeObjectId('salesforce', registration.salesforceObject)) {
      throw new Error('invalid Salesforce object API name');
    }
    if (registration.hubspotObject && !isNativeObjectId('hubspot', registration.hubspotObject)) {
      throw new Error('invalid HubSpot object type ID');
    }
  }
}

function thaw(snapshot: ConfigSnapshot): ConfigDraft {
  return {
    objects: new Map([...snapshot.objects].map(([key, value]) => [key, { ...value }])),
    fieldRules: {
      salesforce: cloneRules(snapshot.fieldRules.salesforce),
      hubspot: cloneRules(snapshot.fieldRules.hubspot),
    },
    valueMappings: snapshot.valueMappings.map((mapping) => ({ ...mapping })),
    naturalKeys: Object.fromEntries(
      Object.entries(snapshot.naturalKeys).map(([key, fields]) => [key, [...fields]]),
    ),
  };
}

function freeze(draft: ConfigDraft, revision: number): ConfigSnapshot {
  return Object.freeze({
    revision,
    objects: new Map([...draft.objects].map(([key, value]) => [key, Object.freeze({ ...value })])),
    fieldRules: Object.freeze({
      salesforce: Object.freeze(cloneRules(draft.fieldRules.salesforce)),
      hubspot: Object.freeze(cloneRules(draft.fieldRules.hubspot)),
    }),
    valueMappings: Object.freeze(draft.valueMappings.map((mapping) => Object.freeze({ ...mapping }))),
    naturalKeys: Object.freeze(
      Object.fromEntries(Object.entries(draft.naturalKeys).map(([key, fields]) => [key, [...fields]])),
    ),
  });
}

function cloneRules(source: Readonly<Record<CanonicalType, FieldRule[]>>): Record<CanonicalType, FieldRule[]> {
  return Object.fromEntries(
    Object.entries(source).map(([type, rules]) => [type, rules.map((rule) => ({ ...rule }))]),
  );
}
