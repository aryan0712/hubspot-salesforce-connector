import type { CanonicalType, FieldValue, SystemId } from './types.js';

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
  | 'epoch-millis'
  | 'phone';

export type FieldSourceOfTruth = SystemId | 'last-write-wins';

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
  /** Optional owner or conflict strategy used when both systems change this field concurrently. */
  sourceOfTruth?: FieldSourceOfTruth;
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

export const LITERAL_FIELD_PREFIX = 'literal:';

/** True when `native` encodes a literal text or picklist/dropdown value rather than a CRM field API name. */
export function isLiteralNative(native: string): boolean {
  if (native.startsWith(LITERAL_FIELD_PREFIX)) return true;
  const trimmed = native.trim();
  return (
    (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'"))
  );
}

/** Extracts the literal string value when `isLiteralNative(native)` is true, or undefined for a normal field name. */
export function parseLiteralNative(native: string): string | undefined {
  if (native.startsWith(LITERAL_FIELD_PREFIX)) {
    return native.slice(LITERAL_FIELD_PREFIX.length);
  }
  const trimmed = native.trim();
  if (
    (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

/** Encodes a literal text or picklist/dropdown value for storage in `FieldRule.native`. */
export function toLiteralNative(value: string): string {
  return `${LITERAL_FIELD_PREFIX}${value}`;
}

export function validateFieldRules(rules: FieldRule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule.canonical?.trim() || !rule.native?.trim()) {
      throw new Error('mapping canonical and native names are required');
    }
    if (seen.has(rule.canonical)) throw new Error(`duplicate canonical field: ${rule.canonical}`);
    seen.add(rule.canonical);
  }
}

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
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const rule of config.fieldRules[system][type] ?? []) {
    const literal = parseLiteralNative(rule.native);
    const raw = literal !== undefined ? literal : getPath(native, rule.native);
    const value = coerce(raw);
    out[rule.canonical] = toCanonicalValue(
      config.valueMappings,
      system,
      type,
      rule.canonical,
      transform(rule.toCanonical, value, 'toCanonical'),
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
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const rule of config.fieldRules[system][type] ?? []) {
    if (rule.readOnly || isLiteralNative(rule.native)) continue;
    if (!(rule.canonical in fields)) continue;
    // Native field can be a dotted path on read; on write we only support flat props.
    if (rule.native.includes('.')) continue;
    out[rule.native] = transform(
      rule.fromCanonical,
      fromCanonicalValue(config.valueMappings, system, type, rule.canonical, fields[rule.canonical] ?? null),
      'fromCanonical',
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
export function transform(
  id: TransformId | undefined,
  value: FieldValue,
  direction?: 'toCanonical' | 'fromCanonical',
): FieldValue {
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
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
    return Boolean(value);
  }
  if (id === 'yes-no') {
    if (value === null || value === undefined || value === '') return null;
    if (direction === 'fromCanonical') {
      // Outgoing to target CRM: native field expects string "yes" or "no" (e.g. HubSpot enumeration)
      if (typeof value === 'boolean') return value ? 'yes' : 'no';
      if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (['yes', 'true', '1'].includes(lower)) return 'yes';
        if (['no', 'false', '0'].includes(lower)) return 'no';
        return value;
      }
      return value ? 'yes' : 'no';
    }
    if (direction === 'toCanonical') {
      // Incoming from native field: normalize "yes"/"no" strings into canonical boolean
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (['yes', 'true', '1'].includes(lower)) return true;
        if (['no', 'false', '0'].includes(lower)) return false;
      }
      return Boolean(value);
    }
    // Direction unspecified fallback
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (typeof value === 'string') return ['yes', 'true', '1'].includes(value.trim().toLowerCase());
    return value;
  }
  if (id === 'true-false') {
    if (value === null || value === undefined || value === '') return null;
    if (direction === 'fromCanonical') {
      // Outgoing to target CRM: native field expects literal string "true" or "false"
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (['true', '1', 'yes'].includes(lower)) return 'true';
        if (['false', '0', 'no'].includes(lower)) return 'false';
        return value;
      }
      return value ? 'true' : 'false';
    }
    if (direction === 'toCanonical') {
      // Incoming from native field: normalize "true"/"false" strings into canonical boolean
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (['true', '1', 'yes'].includes(lower)) return true;
        if (['false', '0', 'no'].includes(lower)) return false;
      }
      return Boolean(value);
    }
    // Direction unspecified fallback
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
    return value;
  }
  if (id === 'iso-date') {
    if (typeof value !== 'string' && typeof value !== 'number') return value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (id === 'epoch-millis') {
    if (direction === 'fromCanonical') {
      if (typeof value === 'number') return value;
      if (typeof value === 'string') {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.getTime();
      }
      return value;
    }
    if (direction === 'toCanonical') {
      if (typeof value === 'number' || typeof value === 'string') {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
      }
      return value;
    }
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
  const sysKey = `${system}Value` as 'salesforceValue' | 'hubspotValue';
  const fieldMappings = mappings.filter(
    (mapping) => mapping.type === type && mapping.canonicalField === field,
  );
  if (fieldMappings.length === 0) return value;

  const translateSingle = (val: string): string => {
    const valTrimmed = val.trim();
    const valLower = valTrimmed.toLowerCase();
    const row = fieldMappings.find(
      (m) => m[sysKey] === valTrimmed || m[sysKey]?.trim().toLowerCase() === valLower,
    );
    return row?.canonicalValue || row?.[sysKey] || val;
  };

  if (value.includes(';')) {
    return value.split(';').map(translateSingle).join(';');
  }
  return translateSingle(value);
}

function fromCanonicalValue(
  mappings: readonly ValueMapping[],
  system: SystemId,
  type: CanonicalType,
  field: string,
  value: FieldValue,
): FieldValue {
  if (typeof value !== 'string') return value;
  const sysKey = `${system}Value` as 'salesforceValue' | 'hubspotValue';
  const otherSysKey = system === 'salesforce' ? 'hubspotValue' : 'salesforceValue';
  const fieldMappings = mappings.filter(
    (mapping) => mapping.type === type && mapping.canonicalField === field,
  );
  if (fieldMappings.length === 0) return value;

  const translateSingle = (val: string): string => {
    const valTrimmed = val.trim();
    const valLower = valTrimmed.toLowerCase();
    // 1. Try exact or case-insensitive match on canonicalValue
    let row = fieldMappings.find(
      (m) =>
        m.canonicalValue === valTrimmed ||
        m.canonicalValue?.trim().toLowerCase() === valLower,
    );
    // 2. Fallback: match on counterpart system's value (e.g. if canonical record held other system's native value directly)
    if (!row) {
      row = fieldMappings.find(
        (m) =>
          m[otherSysKey] === valTrimmed ||
          m[otherSysKey]?.trim().toLowerCase() === valLower,
      );
    }
    return row?.[sysKey] ?? val;
  };

  if (value.includes(';')) {
    return value.split(';').map(translateSingle).join(';');
  }
  return translateSingle(value);
}

