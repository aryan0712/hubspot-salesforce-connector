import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  CanonicalRecord,
  CanonicalType,
  FieldValue,
  NaturalKeyQuery,
  SystemId,
} from './types.js';

/**
 * The ID MAP is the memory of the sync system. For every logically-identical record it
 * stores the native id in each system plus the last content-hash we wrote there.
 *
 * It solves three problems at once:
 *   1. ROUTING       - given a Salesforce id, what's the matching HubSpot id (and vice versa)?
 *   2. LOOP PREVENTION - when a webhook fires, is this change one WE just wrote (an echo)?
 *      If the incoming content-hash equals the hash we last pushed, we drop it.
 *   3. CONFLICT INPUT - we keep each side's last-seen modifiedAt for last-write-wins.
 *
 * Identity rules every store enforces (R05):
 *   - native ids are unique per (system, object type) -- not per system -- because HubSpot
 *     ids repeat across object types;
 *   - a natural key has at most one CURRENT owner; claiming a key another link owns throws
 *     NaturalKeyCollisionError instead of silently reassigning it;
 *   - a key a link no longer carries is RETIRED, not deleted, so a reused value (a recycled
 *     email) can later identify a different record without rewriting history.
 */

export interface Link {
  canonicalId: string;
  type: CanonicalType;
  /** native id in each system, if known */
  ids: Partial<Record<SystemId, string>>;
  /** last content-hash we observed/wrote per system (for echo detection) */
  hashes: Partial<Record<SystemId, string>>;
  /** last modifiedAt we observed per system (ISO 8601) */
  modifiedAt: Partial<Record<SystemId, string>>;
  /** The link's CURRENT natural keys. Keys removed from this list are retired by the store. */
  naturalKeys?: string[];
  updatedAt: string;
}

export interface IdMapStore {
  init(): Promise<void>;
  /**
   * Find the link for a native record. Pass the canonical `type`: native ids are only
   * unique within one object type (a HubSpot contact and company can share an id).
   */
  bySource(system: SystemId, sourceId: string, type?: CanonicalType): Promise<Link | undefined>;
  /** The link that CURRENTLY owns a natural key (retired keys are ignored). */
  byNaturalKey(type: CanonicalType, key: string): Promise<Link | undefined>;
  /**
   * Persist a link. Throws NaturalKeyCollisionError if one of its natural keys is currently
   * owned by another link, or NativeIdCollisionError if a native id is already linked
   * elsewhere for the same object type. Keys no longer listed are retired.
   */
  upsertLink(link: Link): Promise<void>;
}

/** A natural key is already the current identity of another link; needs operator review. */
export class NaturalKeyCollisionError extends Error {
  constructor(
    readonly type: CanonicalType,
    readonly key: string,
    readonly ownerLinkId: string,
  ) {
    super(`natural key ${key} already identifies another ${type} record`);
    this.name = 'NaturalKeyCollisionError';
  }
}

/** A native record is already linked to a different canonical record. */
export class NativeIdCollisionError extends Error {
  constructor(system: SystemId, type: CanonicalType, nativeId: string) {
    super(`${system} ${type} ${nativeId} is already linked to another record`);
    this.name = 'NativeIdCollisionError';
  }
}

/**
 * Content hash format version. v2 is a full SHA-256 over a typed, JSON-encoded, key-sorted
 * representation of the canonical fields, so distinct values can never collide by
 * concatenation ({a:'x|b=y'} vs {a:'x', b:'y'}) and null, '' , 0, false, '0' and an absent
 * field all hash differently. Only canonical fields are hashed -- record metadata such as
 * modified timestamps or native ids is deliberately excluded, so an unchanged record keeps
 * an unchanged hash.
 */
export const CONTENT_HASH_VERSION = 'v2';

export function contentHash(fields: Record<string, FieldValue | undefined>): string {
  const encoded = JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((key) => [key, typedValue(fields[key])]),
  );
  return `${CONTENT_HASH_VERSION}:${crypto.createHash('sha256').update(encoded).digest('hex')}`;
}

function typedValue(value: FieldValue | undefined): unknown[] {
  if (value === undefined) return ['absent'];
  if (value === null) return ['null'];
  if (typeof value === 'string') return ['s', value];
  if (typeof value === 'boolean') return ['b', value];
  // Numbers keep their exact text (JSON cannot carry NaN/Infinity).
  return ['n', Number.isFinite(value) ? value : String(value)];
}

/**
 * The pre-R05 hash (16 hex chars of SHA-256 over "k=v|k=v"). Kept ONLY to recognise hashes
 * already stored in the id map, so upgrading never mistakes unchanged content for a change
 * (which would trigger a mass rewrite). Never used to write new hashes.
 */
export function legacyContentHash(fields: Record<string, FieldValue | undefined>): string {
  const normalized = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k] ?? ''}`)
    .join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function isLegacyHash(hash: string | undefined): boolean {
  return Boolean(hash) && !hash!.startsWith(`${CONTENT_HASH_VERSION}:`);
}

/**
 * Whether a stored hash describes these fields. A legacy hash is compared in its own
 * format; callers then rebaseline it to v2 from this read-only observation.
 */
export function hashMatches(stored: string | undefined, fields: Record<string, FieldValue | undefined>): boolean {
  if (!stored) return false;
  return isLegacyHash(stored) ? stored === legacyContentHash(fields) : stored === contentHash(fields);
}

/**
 * Natural-key rules live on each app's ConfigContext (core/configContext.ts); nothing here
 * is pre-registered. The built-in defaults (contact/company/deal) are seeded as ordinary
 * data by core/defaultObjects.ts, the same as any custom object a tenant adds.
 */
export function isAllowedNaturalKeyField(_type: CanonicalType, field: string): boolean {
  const key = field.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!key) return false;
  if (key.includes('external') && key.endsWith('id')) return true;
  if (
    key === 'id' ||
    ['type', 'industry', 'website', 'annualrevenue', 'revenue'].includes(key) ||
    /(modified|activity|created|updated|timestamp|description|notes?|ownerid|recordtype|status|stage|pipeline|amount|employee|count|isdeleted)/.test(key)
  ) {
    return false;
  }
  return true;
}

/** Validates a natural-key definition and returns it de-duplicated; throws when unsafe. */
export function validateNaturalKeyFields(type: CanonicalType, fields: string[]): string[] {
  if (!fields.length) throw new Error('at least one natural-key field is required');
  if (fields.length > 3) throw new Error('natural keys can contain at most three fields');
  const unsafe = fields.find((field) => !isAllowedNaturalKeyField(type, field));
  if (unsafe) throw new Error(`unsafe natural-key field: ${unsafe}`);
  return [...new Set(fields)];
}

/** Fields that identify a person or deal only weakly: they change or repeat in practice. */
const WEAK_KEY_FIELDS = /^(name|firstname|lastname|fullname|title|phone|mobilephone|closedate|city|companyname)$/i;

/** True when a natural key relies only on weak, mutable or commonly repeated values. */
export function isWeakNaturalKey(fields: readonly string[]): boolean {
  return fields.length > 0 && fields.every((field) => WEAK_KEY_FIELDS.test(field.replace(/[^a-z0-9]/gi, '')));
}

/** Builds the natural-key lookup for one record from its object's configured key fields. */
export function buildNaturalKeyQuery(
  record: CanonicalRecord,
  keyFields: readonly string[],
): NaturalKeyQuery | undefined {
  const f = record.fields;
  const criteria: { field: string; value: string }[] = [];
  for (const field of keyFields) {
    const raw = f[field];
    if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
    const value = normalizeKeyValue(field, String(raw));
    if (!value) return undefined;
    criteria.push({ field, value });
  }
  const first = criteria[0];
  if (!first) return undefined;
  return {
    field: first.field,
    value: first.value,
    criteria,
    key: criteria.map((item) => `${item.field}:${item.value}`).join('|'),
  };
}

export class FileIdMapStore implements IdMapStore {
  private links = new Map<string, Link>();
  private sourceIndex = new Map<string, string>(); // `${system}:${type}:${sourceId}` -> canonicalId
  private naturalIndex = new Map<string, string>(); // `${type}:${key}` -> current owner canonicalId
  /** Retired keys per link (provenance only; never used for matching). */
  private retired = new Map<string, Set<string>>();
  private dirty = false;

  /** Pass `null` for a purely in-memory store (load tests); nothing touches the disk. */
  constructor(private readonly file: string | null = path.resolve('data/idmap.json')) {}

  async init(): Promise<void> {
    if (this.file === null) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const arr: (Link & { retiredNaturalKeys?: string[] })[] = JSON.parse(raw);
      for (const link of arr) {
        this.links.set(link.canonicalId, link);
        this.indexSides(link);
        for (const key of link.naturalKeys ?? []) {
          if (!this.naturalIndex.has(`${link.type}:${key}`)) this.naturalIndex.set(`${link.type}:${key}`, link.canonicalId);
        }
        if (link.retiredNaturalKeys?.length) this.retired.set(link.canonicalId, new Set(link.retiredNaturalKeys));
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // Best-effort periodic flush.
    setInterval(() => void this.flush(), 2000).unref();
  }

  async bySource(system: SystemId, sourceId: string, type?: CanonicalType): Promise<Link | undefined> {
    if (type) {
      const cid = this.sourceIndex.get(`${system}:${type}:${sourceId}`);
      return this.copy(cid);
    }
    for (const link of this.links.values()) {
      if (link.ids[system] === sourceId) return structuredClone(link);
    }
    return undefined;
  }

  async byNaturalKey(type: CanonicalType, key: string): Promise<Link | undefined> {
    const cid = this.naturalIndex.get(`${type}:${key}`);
    return this.copy(cid);
  }

  /** Callers mutate the links they receive; they must go through upsertLink to persist. */
  private copy(canonicalId: string | undefined): Link | undefined {
    const link = canonicalId ? this.links.get(canonicalId) : undefined;
    return link ? structuredClone(link) : undefined;
  }

  async upsertLink(link: Link): Promise<void> {
    for (const key of link.naturalKeys ?? []) {
      const owner = this.naturalIndex.get(`${link.type}:${key}`);
      if (owner && owner !== link.canonicalId) {
        throw new NaturalKeyCollisionError(link.type, key, owner);
      }
    }
    for (const [system, id] of Object.entries(link.ids) as [SystemId, string | undefined][]) {
      const owner = id ? this.sourceIndex.get(`${system}:${link.type}:${id}`) : undefined;
      if (owner && owner !== link.canonicalId) throw new NativeIdCollisionError(system, link.type, id!);
    }
    const previous = this.links.get(link.canonicalId);
    link.updatedAt = new Date().toISOString();
    if (previous) {
      for (const [system, id] of Object.entries(previous.ids) as [SystemId, string | undefined][]) {
        if (id && link.ids[system] !== id) this.sourceIndex.delete(`${system}:${previous.type}:${id}`);
      }
      const current = new Set(link.naturalKeys ?? []);
      for (const key of previous.naturalKeys ?? []) {
        if (current.has(key)) continue;
        if (this.naturalIndex.get(`${previous.type}:${key}`) === link.canonicalId) {
          this.naturalIndex.delete(`${previous.type}:${key}`);
        }
        const retired = this.retired.get(link.canonicalId) ?? new Set<string>();
        retired.add(key);
        this.retired.set(link.canonicalId, retired);
      }
    }
    const stored = structuredClone(link);
    this.links.set(link.canonicalId, stored);
    this.indexSides(stored);
    for (const key of stored.naturalKeys ?? []) {
      this.naturalIndex.set(`${stored.type}:${key}`, stored.canonicalId);
      this.retired.get(stored.canonicalId)?.delete(key);
    }
    this.dirty = true;
    await this.flush();
  }

  /** Retired keys of one link (provenance, e.g. an email a contact used to have). */
  retiredKeys(canonicalId: string): string[] {
    return [...(this.retired.get(canonicalId) ?? [])];
  }

  private indexSides(link: Link): void {
    for (const [system, id] of Object.entries(link.ids)) {
      if (id) this.sourceIndex.set(`${system}:${link.type}:${id}`, link.canonicalId);
    }
  }

  private async flush(): Promise<void> {
    if (!this.dirty || this.file === null) return;
    this.dirty = false;
    const arr = [...this.links.values()].map((link) => ({
      ...link,
      retiredNaturalKeys: [...(this.retired.get(link.canonicalId) ?? [])],
    }));
    await fs.writeFile(this.file, JSON.stringify(arr, null, 2));
  }
}

export function newCanonicalId(): string {
  return crypto.randomUUID();
}

/**
 * Normalises a company domain for EXACT comparison: scheme, "www.", path, port and case
 * are removed; nothing else. `example.com` and `notexample.com` stay different.
 */
export function normalizeDomain(value: string): string {
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.replace(/^www\./, '').replace(/\.$/, '').toLowerCase();
  } catch {
    return value.trim().replace(/^www\./, '').toLowerCase();
  }
}

function normalizeKeyValue(field: string, value: string): string {
  if (field === 'domain') return normalizeDomain(value);
  return value.trim().toLowerCase();
}
