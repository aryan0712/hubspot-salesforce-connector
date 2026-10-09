import type { CanonicalType, FieldValue, SystemId } from './types.js';
import { isNativeFieldPath } from './identifiers.js';

/**
 * FIELD MAPPING
 * -------------
 * The neutral vocabulary (left-hand canonical field names) is defined implicitly by the
 * union of all configured rules. To add a field: add a rule to each system's list for the
 * same canonical key. To add a whole object type: register it and give it rules per system.
 *
 * A FieldRule can optionally transform values in each direction (e.g. picklist value
 * normalization, phone formatting, currency scaling). Keep transforms pure & total.
 *
 * This module holds NO built-in object data and NO module state: every canonical object
 * (including the built-in contact/company/deal) is configured at runtime on a per-app
 * ConfigContext (core/configContext.ts), seeded from core/defaultObjects.ts. The functions
 * here are the pure mechanism that context uses to validate, store and translate rules.
 */

export type TransformId =
  | 'identity'
  | 'domain'
  | 'lowercase'
  | 'trim'
  | 'number'
  | 'boolean'
  | 'yes-no'
  | 'true-false'
  | 'iso-date'
  | 'date-only'
  | 'epoch-millis'
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

export interface ValueMapping {
  type: CanonicalType;
  canonicalField: string;
  canonicalValue: string;
  salesforceValue?: string;
  hubspotValue?: string;
}

export type FieldRuleTables = Record<SystemId, Record<CanonicalType, FieldRule[]>>;

/** The parts of a configuration snapshot that translation reads. */
export interface TranslationConfig {
  readonly fieldRules: Readonly<Record<SystemId, Readonly<Record<CanonicalType, FieldRule[]>>>>;
  readonly valueMappings: readonly ValueMapping[];
}

const identity = (v: FieldValue): FieldValue => v;

export function validateFieldRules(rules: FieldRule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule.canonical?.trim() || !rule.native?.trim()) {
      throw new Error('mapping canonical and native names are required');
    }
    if (!isNativeFieldPath(rule.native)) throw new Error(`invalid native field name: ${rule.native}`);
    if (rule.toCanonical && !TRANSFORM_IDS.has(rule.toCanonical)) throw new Error(`unknown transform: ${rule.toCanonical}`);
    if (rule.fromCanonical && !TRANSFORM_IDS.has(rule.fromCanonical)) throw new Error(`unknown transform: ${rule.fromCanonical}`);
    if (seen.has(rule.canonical)) throw new Error(`duplicate canonical field: ${rule.canonical}`);
    seen.add(rule.canonical);
  }
}

const TRANSFORM_IDS: ReadonlySet<string> = new Set([
  'identity', 'domain', 'lowercase', 'trim', 'number', 'boolean', 'yes-no',
  'true-false', 'iso-date', 'date-only', 'epoch-millis', 'phone',
]);

export function applyFieldRules(
  tables: FieldRuleTables,
  system: SystemId,
  type: CanonicalType,
  rules: FieldRule[],
): void {
  validateFieldRules(rules);
  tables[system][type] = rules.map((rule) => ({ ...rule }));
}

export function readFieldRules(
  tables: TranslationConfig['fieldRules'],
  system: SystemId,
  type: CanonicalType,
): FieldRule[] {
  return (tables[system][type] ?? []).map((rule) => ({ ...rule }));
}

/** Translate a native record (as returned by the API) into canonical fields. */
export function translateToCanonical(
  config: TranslationConfig,
  system: SystemId,
  type: CanonicalType,
  native: Record<string, unknown>,
  strict = false,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const rule of config.fieldRules[system][type] ?? []) {
    const raw = getPath(native, rule.native);
    if (strict && raw !== null && raw !== undefined &&
        !['string', 'number', 'boolean'].includes(typeof raw)) {
      throw new Error(`unsupported compound value in ${rule.native}`);
    }
    if (strict && typeof raw === 'number' && !Number.isFinite(raw)) {
      throw new Error(`non-finite number in ${rule.native}`);
    }
    const value = coerce(raw);
    out[rule.canonical] = toCanonicalValue(
      config.valueMappings,
      system,
      type,
      rule.canonical,
      checkedTransform(rule.toCanonical, value, strict, rule.native),
    );
  }
  return out;
}

/** Translate canonical fields into a writable native payload for the target system. */
export function translateFromCanonical(
  config: TranslationConfig,
  system: SystemId,
  type: CanonicalType,
  fields: Record<string, FieldValue>,
  strict = false,
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const rule of config.fieldRules[system][type] ?? []) {
    if (rule.readOnly) continue;
    if (!(rule.canonical in fields)) continue;
    // Native field can be a dotted path on read; on write we only support flat props.
    if (rule.native.includes('.')) continue;
    out[rule.native] = checkedTransform(
      rule.fromCanonical,
      fromCanonicalValue(config.valueMappings, system, type, rule.canonical, fields[rule.canonical] ?? null),
      strict,
      rule.native,
    );
  }
  return out;
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
function checkedTransform(
  id: TransformId | undefined,
  value: FieldValue,
  strict: boolean,
  field: string,
): FieldValue {
  if (strict && typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`non-finite number in ${field}`);
  }
  if (!strict || !id || id === 'identity' || value === null) return transform(id, value);
  if (typeof value === 'string' && value.trim() === '' &&
      ['number', 'boolean', 'yes-no', 'true-false', 'iso-date', 'date-only', 'epoch-millis'].includes(id)) {
    return null;
  }
  if (id === 'number' && (typeof value === 'boolean' || !Number.isFinite(Number(value)))) {
    throw new Error(`invalid numeric value in ${field}`);
  }
  if (['boolean', 'yes-no', 'true-false'].includes(id)) {
    const allowed = id === 'true-false' ? ['true', 'false'] : ['true', 'false', 'yes', 'no', '1', '0'];
    if ((typeof value === 'string' && !allowed.includes(value.toLowerCase())) ||
        (typeof value === 'number' && (id !== 'boolean' || ![0, 1].includes(value)))) {
      throw new Error(`invalid boolean value in ${field}`);
    }
  }
  if (['iso-date', 'date-only', 'epoch-millis'].includes(id)) {
    const date = new Date(value as string | number);
    if (Number.isNaN(date.getTime()) ||
        (id === 'date-only' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          date.toISOString().slice(0, 10) !== value)) {
      throw new Error(`invalid date value in ${field}`);
    }
  }
  return transform(id, value);
}

function transform(id: TransformId | undefined, value: FieldValue): FieldValue {
  if (!id || id === 'identity') return identity(value);
  if (id === 'domain') return toDomain(value);
  if (id === 'lowercase') return typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (id === 'trim') return typeof value === 'string' ? value.trim() : value;
  if (id === 'number') {
    if (value === null || value === '') return null;
    const parsed = Number(value);
    // A value that doesn't parse as a plain number (e.g. a duration string like "0:0")
    // can't be sent to a numeric field either way -- drop it rather than forwarding
    // something the target system will reject.
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (id === 'boolean') {
    if (typeof value === 'boolean' || value === null) return value;
    if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
    return Boolean(value);
  }
  if (id === 'yes-no') {
    // Same transform id works in both directions -- the input's own type tells us which way
    // we're going: a native "yes"/"no" string coming in becomes a canonical boolean, and a
    // canonical boolean going out becomes the literal "yes"/"no" string the field expects
    // (e.g. a HubSpot custom property defined as an enumeration with options [yes, no]).
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (typeof value === 'string') return ['yes', 'true', '1'].includes(value.toLowerCase());
    return value;
  }
  if (id === 'true-false') {
    // Same shape as yes-no, for the other common enumeration encoding: a dropdown/checkbox
    // property whose option values are the literal strings "true"/"false" rather than "yes"/"no".
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return value;
  }
  if (id === 'iso-date') {
    if (typeof value !== 'string' && typeof value !== 'number') return value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (id === 'date-only') {
    if (typeof value !== 'string' && typeof value !== 'number') return value;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
  }
  if (id === 'epoch-millis') {
    // Bidirectional by input type, like yes-no/true-false: a native epoch-ms number becomes
    // a canonical ISO string, and a canonical ISO string becomes a native epoch-ms number --
    // for the (uncommon) custom date property that stores a long instead of an ISO datetime.
    if (typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }
    if (typeof value === 'string') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? value : parsed.getTime();
    }
    return value;
  }
  if (id === 'phone') {
    return typeof value === 'string' ? value.trim().replace(/[^\d+]/g, '') : value;
  }
  return value;
}

function toCanonicalValue(
  mappings: readonly ValueMapping[],
  system: SystemId,
  type: CanonicalType,
  field: string,
  value: FieldValue,
): FieldValue {
  if (typeof value !== 'string') return value;
  const row = mappings.find(
    (mapping) =>
      mapping.type === type &&
      mapping.canonicalField === field &&
      mapping[`${system}Value` as 'salesforceValue' | 'hubspotValue'] === value,
  );
  return row?.canonicalValue ?? value;
}

function fromCanonicalValue(
  mappings: readonly ValueMapping[],
  system: SystemId,
  type: CanonicalType,
  field: string,
  value: FieldValue,
): FieldValue {
  if (typeof value !== 'string') return value;
  const row = mappings.find(
    (mapping) =>
      mapping.type === type &&
      mapping.canonicalField === field &&
      mapping.canonicalValue === value,
  );
  return row?.[`${system}Value` as 'salesforceValue' | 'hubspotValue'] ?? value;
}
