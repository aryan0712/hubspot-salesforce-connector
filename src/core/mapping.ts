import type { CanonicalType, FieldValue, SystemId } from './types.js';

/**
 * FIELD MAPPING
 * -------------
 * The neutral vocabulary (left-hand canonical field names) is defined implicitly by the
 * union of all mappings below. To add a field: add a row to each system's table for the
 * same canonical key. To add a whole object type: add an entry under each system.
 *
 * A FieldMap row can optionally transform values in each direction (e.g. picklist value
 * normalization, phone formatting, currency scaling). Keep transforms pure & total.
 */

export type TransformId =
  | 'identity'
  | 'domain'
  | 'lowercase'
  | 'trim'
  | 'number'
  | 'boolean'
  | 'iso-date'
  | 'phone';

export interface FieldRule {
  /** Canonical (neutral) field name. */
  canonical: string;
  /** Native field/property name in the given system. */
  native: string;
  /** native value -> canonical value. Defaults to identity. */
  toCanonical?: TransformId;
  /** canonical value -> native value. Defaults to identity. */
  fromCanonical?: TransformId;
  /** If true, never write this field back to this system (read-only source field). */
  readOnly?: boolean;
  /** Optional owner used when both systems change this field concurrently. */
  sourceOfTruth?: SystemId;
}

type SystemMappings = Record<CanonicalType, FieldRule[]>;

export interface ValueMapping {
  type: CanonicalType;
  canonicalField: string;
  canonicalValue: string;
  salesforceValue?: string;
  hubspotValue?: string;
}

const identity = (v: FieldValue): FieldValue => v;

/**
 * Field mapping tables hold NO built-in object data — every canonical object (including the
 * built-in contact/company/deal) is configured at runtime via configureFieldRules(), seeded
 * from core/defaultObjects.ts into Postgres per tenant. This keeps the mapping engine itself
 * generic: it only knows how to store and translate whatever rules it's given.
 */
const TABLES: Record<SystemId, SystemMappings> = { salesforce: {}, hubspot: {} };
let VALUE_MAPPINGS: ValueMapping[] = [];

export function configureValueMappings(mappings: ValueMapping[]): void {
  VALUE_MAPPINGS = mappings.map((mapping) => ({ ...mapping }));
}

export function fieldRules(system: SystemId, type: CanonicalType): FieldRule[] {
  return (TABLES[system][type] ?? []).map((rule) => ({ ...rule }));
}

export function configureFieldRules(
  system: SystemId,
  type: CanonicalType,
  rules: FieldRule[],
): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule.canonical.trim() || !rule.native.trim()) {
      throw new Error('mapping canonical and native names are required');
    }
    if (seen.has(rule.canonical)) throw new Error(`duplicate canonical field: ${rule.canonical}`);
    seen.add(rule.canonical);
  }
  TABLES[system][type] = rules.map((rule) => ({ ...rule }));
}

export function resetFieldRules(): void {
  TABLES.salesforce = {};
  TABLES.hubspot = {};
}

/** Translate a native record (as returned by the API) into canonical fields. */
export function toCanonicalFields(
  system: SystemId,
  type: CanonicalType,
  native: Record<string, unknown>,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const rule of TABLES[system][type] ?? []) {
    const raw = getPath(native, rule.native);
    const value = coerce(raw);
    out[rule.canonical] = toCanonicalValue(
      system,
      type,
      rule.canonical,
      transform(rule.toCanonical, value),
    );
  }
  return out;
}

/** Translate canonical fields into a writable native payload for the target system. */
export function fromCanonicalFields(
  system: SystemId,
  type: CanonicalType,
  fields: Record<string, FieldValue>,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const rule of TABLES[system][type] ?? []) {
    if (rule.readOnly) continue;
    if (!(rule.canonical in fields)) continue;
    // Native field can be a dotted path on read; on write we only support flat props.
    if (rule.native.includes('.')) continue;
    out[rule.native] = transform(
      rule.fromCanonical,
      fromCanonicalValue(system, type, rule.canonical, fields[rule.canonical] ?? null),
    );
  }
  return out;
}

/** The set of native field names to request from an API for a given type (read projection). */
export function nativeFields(system: SystemId, type: CanonicalType): string[] {
  return (TABLES[system][type] ?? []).map((r) => r.native);
}

export function nativeField(
  system: SystemId,
  type: CanonicalType,
  canonical: string,
): string | undefined {
  return (TABLES[system][type] ?? []).find((rule) => rule.canonical === canonical)?.native;
}

// ----------------- helpers / transforms -----------------

function coerce(v: unknown): FieldValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return obj[path];
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/** Strip protocol/path from a website to compare companies by domain. */
function toDomain(v: FieldValue): FieldValue {
  if (typeof v !== 'string' || v === '') return v;
  try {
    const url = v.includes('://') ? new URL(v) : new URL(`http://${v}`);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return v.toLowerCase();
  }
}

/**
 * Deal/opportunity stages differ per portal. This is a placeholder that lower-cases; in
 * practice you'd map each portal's picklist to a shared pipeline model. See ARCHITECTURE.md.
 */
function transform(id: TransformId | undefined, value: FieldValue): FieldValue {
  if (!id || id === 'identity') return identity(value);
  if (id === 'domain') return toDomain(value);
  if (id === 'lowercase') return typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (id === 'trim') return typeof value === 'string' ? value.trim() : value;
  if (id === 'number') {
    if (value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (id === 'boolean') {
    if (typeof value === 'boolean' || value === null) return value;
    if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
    return Boolean(value);
  }
  if (id === 'iso-date') {
    if (typeof value !== 'string' && typeof value !== 'number') return value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (id === 'phone') {
    return typeof value === 'string' ? value.trim().replace(/[^\d+]/g, '') : value;
  }
  return value;
}

function toCanonicalValue(
  system: SystemId,
  type: CanonicalType,
  field: string,
  value: FieldValue,
): FieldValue {
  if (typeof value !== 'string') return value;
  const row = VALUE_MAPPINGS.find(
    (mapping) =>
      mapping.type === type &&
      mapping.canonicalField === field &&
      mapping[`${system}Value` as 'salesforceValue' | 'hubspotValue'] === value,
  );
  return row?.canonicalValue ?? value;
}

function fromCanonicalValue(
  system: SystemId,
  type: CanonicalType,
  field: string,
  value: FieldValue,
): FieldValue {
  if (typeof value !== 'string') return value;
  const row = VALUE_MAPPINGS.find(
    (mapping) =>
      mapping.type === type &&
      mapping.canonicalField === field &&
      mapping.canonicalValue === value,
  );
  return row?.[`${system}Value` as 'salesforceValue' | 'hubspotValue'] ?? value;
}
