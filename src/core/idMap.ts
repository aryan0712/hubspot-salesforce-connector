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
 * This reference implementation persists to a JSON file so the scaffold runs with zero
 * infra. Swap `FileIdMapStore` for a Postgres/Redis-backed store in production
 * (the interface is what the engines depend on).
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
  /** Persisted natural keys so the dedup index survives process restarts. */
  naturalKeys?: string[];
  updatedAt: string;
}

export interface IdMapStore {
  init(): Promise<void>;
  bySource(system: SystemId, sourceId: string): Promise<Link | undefined>;
  /** Find an existing link by a natural key (email/domain) to avoid duplicates on first sync. */
  byNaturalKey(type: CanonicalType, key: string): Promise<Link | undefined>;
  upsertLink(link: Link): Promise<void>;
}

/** Stable content hash of the canonical fields (order-independent). Drives echo detection. */
export function contentHash(fields: Record<string, FieldValue>): string {
  const normalized = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k] ?? ''}`)
    .join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** The natural key we use to match records across systems on the very first sync. */
export function naturalKey(record: CanonicalRecord): string | undefined {
  return naturalKeyQuery(record)?.key;
}

/**
 * Natural-key config per canonical object. No object type is pre-registered here — the
 * built-in defaults (contact/company/deal) are seeded as ordinary data by
 * core/defaultObjects.ts + the object mapping store, same as any custom object a tenant adds.
 */
const NATURAL_KEY_FIELDS: Record<CanonicalType, string[]> = {};

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

export function configureNaturalKeyFields(type: CanonicalType, fields: string[]): void {
  if (!fields.length) throw new Error('at least one natural-key field is required');
  if (fields.length > 3) throw new Error('natural keys can contain at most three fields');
  const unsafe = fields.find((field) => !isAllowedNaturalKeyField(type, field));
  if (unsafe) throw new Error(`unsafe natural-key field: ${unsafe}`);
  NATURAL_KEY_FIELDS[type] = [...new Set(fields)];
}

export function naturalKeyFields(type: CanonicalType): string[] {
  return [...(NATURAL_KEY_FIELDS[type] ?? [])];
}

/** Used when an object's native pairing changes -- the old natural key described the old native
 * object's fields and rarely makes sense on the new one, so it's cleared rather than kept stale. */
export function clearNaturalKeyFields(type: CanonicalType): void {
  delete NATURAL_KEY_FIELDS[type];
}

export function naturalKeyQuery(record: CanonicalRecord): NaturalKeyQuery | undefined {
  const f = record.fields;
  const criteria: { field: string; value: string }[] = [];
  for (const field of NATURAL_KEY_FIELDS[record.type] ?? []) {
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
  private sourceIndex = new Map<string, string>(); // `${system}:${sourceId}` -> canonicalId
  private naturalIndex = new Map<string, string>(); // `${type}:${key}` -> canonicalId
  private dirty = false;

  constructor(private readonly file = path.resolve('data/idmap.json')) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const arr: Link[] = JSON.parse(raw);
      for (const link of arr) this.index(link);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // Best-effort periodic flush.
    setInterval(() => void this.flush(), 2000).unref();
  }

  async bySource(system: SystemId, sourceId: string): Promise<Link | undefined> {
    const cid = this.sourceIndex.get(`${system}:${sourceId}`);
    return cid ? this.links.get(cid) : undefined;
  }

  async byNaturalKey(type: CanonicalType, key: string): Promise<Link | undefined> {
    const cid = this.naturalIndex.get(`${type}:${key}`);
    return cid ? this.links.get(cid) : undefined;
  }

  async upsertLink(link: Link): Promise<void> {
    link.updatedAt = new Date().toISOString();
    this.index(link);
    this.dirty = true;
    await this.flush();
  }

  private index(link: Link): void {
    this.links.set(link.canonicalId, link);
    for (const [system, id] of Object.entries(link.ids)) {
      if (id) this.sourceIndex.set(`${system}:${id}`, link.canonicalId);
    }
    for (const key of link.naturalKeys ?? []) {
      this.naturalIndex.set(`${link.type}:${key}`, link.canonicalId);
    }
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const arr = [...this.links.values()];
    await fs.writeFile(this.file, JSON.stringify(arr, null, 2));
  }

  /** Register a natural-key -> canonicalId mapping (called by the engine after matching). */
  indexNaturalKey(type: CanonicalType, key: string, canonicalId: string): void {
    this.naturalIndex.set(`${type}:${key}`, canonicalId);
  }
}

export function newCanonicalId(): string {
  return crypto.randomUUID();
}

function normalizeDomain(value: string): string {
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return value.trim().replace(/^www\./, '').toLowerCase();
  }
}

function normalizeKeyValue(field: string, value: string): string {
  if (field === 'domain') return normalizeDomain(value);
  return value.trim().toLowerCase();
}
