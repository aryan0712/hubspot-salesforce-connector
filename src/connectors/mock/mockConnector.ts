import crypto from 'node:crypto';
import {
  ConditionalWriteRejectedError,
  type CRMConnector,
  type ConnectorAssociation,
  type NativeWebhookEvent,
  type QueryCondition,
  type WriteOptions,
} from '../../core/connector.js';
import type {
  CanonicalRecord,
  CanonicalType,
  ChangeEvent,
  CRMObjectDescriptor,
  CRMObjectMetadata,
  FieldValue,
  RecordPage,
  NaturalKeyQuery,
  SchemaField,
  SystemId,
} from '../../core/types.js';
import type { ConfigContext } from '../../core/configContext.js';
import { isBuiltInObjectPair } from '../../core/defaultObjects.js';
import { evaluateConditions } from '../../core/syncConfig.js';

/**
 * An in-memory CRM that behaves like a real connector but needs no credentials. It stores
 * NATIVE-shaped records (using the same mapping tables as the real connectors) so the demo
 * and tests exercise the actual translation code paths. Pretend it "is" Salesforce or
 * HubSpot by passing the system id — that selects which mapping table it uses.
 *
 * It also emits ChangeEvents whenever a record is written, so a test harness can simulate
 * webhooks. Emits are labeled so a test can distinguish user edits from sync-driven writes.
 */
type NativeRecord = Record<string, FieldValue> & { __id: string; __modifiedAt: string; __createdAt?: string };

export class MockConnector implements CRMConnector {
  readonly system: SystemId;
  private store = new Map<CanonicalType, Map<string, NativeRecord>>();
  private listeners: ((e: ChangeEvent) => void)[] = [];
  private associations = new Map<string, ConnectorAssociation[]>();
  private deletions = new Map<CanonicalType, { sourceId: string; occurredAt: string }[]>();
  private keyIndex = new Map<string, Set<string>>();
  private keyOf = new Map<string, string>();
  private nativeMetadata = new Map<string, CRMObjectMetadata>();
  private indexedRevision = -1;

  private ensureKeyIndex(): void {
    if (this.indexedRevision === this.config.revision) return;
    this.keyIndex.clear();
    this.keyOf.clear();
    this.indexedRevision = this.config.revision;
    for (const [type, bucket] of this.store) {
      for (const id of bucket.keys()) this.reindex(type, id);
    }
  }

  private reindex(type: CanonicalType, id: string): void {
    if (this.indexedRevision !== this.config.revision) return; // rebuilt lazily on next search
    const composite = `${type}:${id}`;
    const previous = this.keyOf.get(composite);
    if (previous) this.keyIndex.get(previous)?.delete(id);
    this.keyOf.delete(composite);
    const native = this.bucket(type).get(id);
    if (!native) return;
    const key = this.config.naturalKey(this.canonicalize(type, native));
    if (!key) return;
    const indexKey = `${type}|${key}`;
    let ids = this.keyIndex.get(indexKey);
    if (!ids) {
      ids = new Set();
      this.keyIndex.set(indexKey, ids);
    }
    ids.add(id);
    this.keyOf.set(composite, indexKey);
  }

  /** Test knob: how long a newly created record stays invisible to findByNaturalKey. */
  searchVisibilityMs = 0;
  /** Distinguishes two mock accounts of the same system (e.g. the demo vs a test app). */
  readonly accountId = crypto.randomUUID().slice(0, 8);

  constructor(
    system: SystemId,
    private readonly config: ConfigContext,
  ) {
    this.system = system;
  }

  async init(): Promise<void> {
    /* nothing to authorize */
  }

  /** Subscribe to change events this system emits (stand-in for a webhook stream). */
  onChange(fn: (e: ChangeEvent) => void): void {
    this.listeners.push(fn);
  }

  /** Lazily creates the per-type bucket so any canonical type works, not just a fixed set. */
  private bucket(type: CanonicalType): Map<string, NativeRecord> {
    let map = this.store.get(type);
    if (!map) {
      map = new Map();
      this.store.set(type, map);
    }
    return map;
  }

  // rawCondition is ignored -- there's no SOQL/search-filter engine to fake it against here;
  // structured conditions run through the same evaluateConditions() the real connectors'
  // compiled SOQL/search filters are checked against, so a test asserting "this condition
  // matches N records" behaves the same way it would against a live CRM.
  async list(
    type: CanonicalType,
    cursor?: string,
    modifiedSince?: string,
    condition?: QueryCondition,
  ): Promise<RecordPage> {
    const sinceMs = modifiedSince ? Date.parse(modifiedSince) : undefined;
    const all = [...this.bucket(type).values()].filter(
      (n) =>
        (sinceMs === undefined || Date.parse(n.__modifiedAt) >= sinceMs) &&
        evaluateConditions(condition?.conditions, n),
    );
    const pageSize = 100;
    const start = cursor ? Number(cursor) : 0;
    const slice = all.slice(start, start + pageSize);
    const records = slice.map((n) => this.canonicalize(type, n));
    const next = start + pageSize;
    return { records, nextCursor: next < all.length ? String(next) : undefined };
  }

  async listDeletedSince(
    type: CanonicalType,
    since: string,
  ): Promise<{ sourceId: string; occurredAt: string }[]> {
    const sinceMs = Date.parse(since);
    return (this.deletions.get(type) ?? []).filter((d) => Date.parse(d.occurredAt) >= sinceMs);
  }

  async read(type: CanonicalType, sourceId: string): Promise<CanonicalRecord | null> {
    const n = this.bucket(type).get(sourceId);
    return n ? this.canonicalize(type, n) : null;
  }

  async findByNaturalKey(
    type: CanonicalType,
    query: NaturalKeyQuery,
  ): Promise<CanonicalRecord[]> {
    // Models vendor search indexing lag: a just-created record is readable by id but not
    // yet returned by search for `searchVisibilityMs`. Uses a natural-key index (like a
    // vendor search index) so large synthetic runs stay linear.
    this.ensureKeyIndex();
    const visibleBefore = Date.now() - this.searchVisibilityMs;
    const out: CanonicalRecord[] = [];
    for (const id of this.keyIndex.get(`${type}|${query.key}`) ?? []) {
      const native = this.bucket(type).get(id);
      if (!native || Date.parse(native.__createdAt ?? '0') > visibleBefore) continue;
      out.push(this.canonicalize(type, native));
    }
    return out;
  }

  async describe(type: CanonicalType): Promise<SchemaField[]> {
    const nativeId = this.config.nativeObjectName(this.system, type);
    const metadata = nativeId ? this.nativeMetadata.get(nativeId) : undefined;
    if (metadata) return metadata.fields.map((field) => ({ ...field }));
    return this.config.fieldRules(this.system, type).map((rule) => ({
      name: rule.native,
      label: rule.native,
      type: 'string',
      readOnly: rule.readOnly,
    }));
  }

  async listObjects(): Promise<CRMObjectDescriptor[]> {
    const registered: CRMObjectDescriptor[] = this.config.listCanonicalObjects()
      .filter((registration) => Boolean(this.config.nativeObjectName(this.system, registration.canonicalObject)))
      .map((registration) => ({
      ...(this.nativeMetadata.get(this.config.requireNativeObjectName(this.system, registration.canonicalObject))?.object ?? {
        id: this.config.requireNativeObjectName(this.system, registration.canonicalObject),
        label: registration.label,
        pluralLabel: `${registration.label}s`,
        custom: !isBuiltInObjectPair(registration),
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
      }),
      canonicalType: registration.canonicalObject,
    }));
    const objects = [...registered, ...[...this.nativeMetadata.values()].map((metadata) => ({
      ...metadata.object,
      canonicalType: this.config.canonicalObjectFor(this.system, metadata.object.id),
    }))].filter((object, index, all) => all.findIndex((candidate) => candidate.id === object.id) === index);
    objects.push({
      id: this.system === 'salesforce' ? 'Case' : 'tickets',
      label: 'Ticket',
      pluralLabel: 'Tickets',
      custom: false,
      queryable: true,
      createable: true,
      updateable: true,
      deletable: true,
    });
    return objects;
  }

  async describeObject(objectId: string): Promise<CRMObjectMetadata> {
    const object = (await this.listObjects()).find((candidate) => candidate.id === objectId);
    if (!object) throw new Error(`unknown mock object ${objectId}`);
    const metadata = this.nativeMetadata.get(objectId);
    if (metadata) return { object, fields: metadata.fields.map((field) => ({ ...field })),
      relationships: metadata.relationships.map((relationship) => ({ ...relationship })) };
    return {
      object,
      fields: object.canonicalType ? await this.describe(object.canonicalType) : [],
      relationships: object.canonicalType === 'contact'
        ? [{ name: 'company', label: 'Company', targetObjectId: 'company', kind: 'parent' }]
        : [],
    };
  }

  /** Test/demo helper: add a native object before an operator registers a canonical pair. */
  defineNativeObject(metadata: CRMObjectMetadata): void {
    this.nativeMetadata.set(metadata.object.id, structuredClone(metadata));
  }

  async listAssociations(
    type: CanonicalType,
    sourceId: string,
  ): Promise<ConnectorAssociation[]> {
    return (this.associations.get(`${type}:${sourceId}`) ?? []).map((item) => ({ ...item }));
  }

  async associate(
    fromType: CanonicalType,
    fromId: string,
    association: ConnectorAssociation,
  ): Promise<void> {
    const key = `${fromType}:${fromId}`;
    const current = this.associations.get(key) ?? [];
    if (
      !current.some(
        (item) =>
          item.toType === association.toType &&
          item.toId === association.toId &&
          item.kind === association.kind &&
          item.label === association.label,
      )
    ) {
      current.push({ ...association });
      this.associations.set(key, current);
    }
  }

  async upsert(record: CanonicalRecord, targetId?: string) {
    const native = this.config.fromCanonicalFields(this.system, record.type, record.fields);
    return this.writeNative(record.type, native, targetId, true);
  }

  async write(
    type: CanonicalType,
    payload: Record<string, FieldValue>,
    targetId?: string,
    options: WriteOptions = {},
  ) {
    const existing = targetId ? this.bucket(type).get(targetId) : undefined;
    if (targetId && !existing) {
      throw new Error(`mock ${this.system} ${type} ${targetId} not found`);
    }
    // Behaves like Salesforce's If-Unmodified-Since so tests can exercise conditional writes.
    if (
      existing &&
      options.ifUnmodifiedSince &&
      Date.parse(existing.__modifiedAt) > Date.parse(options.ifUnmodifiedSince)
    ) {
      throw new ConditionalWriteRejectedError();
    }
    this.writes.push({ type, targetId, payload: { ...payload } });
    return { ...(await this.writeNative(type, payload, targetId, false)), conditional: true };
  }

  async accountIdentity(): Promise<string | undefined> {
    return `mock:${this.system}:${this.accountId}`;
  }

  /** Test helper: every exact-payload write this connector received, in order. */
  readonly writes: { type: CanonicalType; targetId?: string; payload: Record<string, FieldValue> }[] = [];

  private async writeNative(
    type: CanonicalType,
    native: Record<string, FieldValue>,
    targetId: string | undefined,
    createIfMissing: boolean,
  ) {
    const id = targetId ?? `${this.system}-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    if (targetId && !createIfMissing && !this.bucket(type).has(targetId)) {
      throw new Error(`mock ${this.system} ${type} ${targetId} not found`);
    }
    const existing = this.bucket(type).get(id);
    const merged: NativeRecord = {
      ...(existing ?? {}),
      ...native,
      __id: id,
      __modifiedAt: nextTimestamp(existing?.__modifiedAt),
      __createdAt: existing?.__createdAt ?? new Date().toISOString(),
    };
    this.bucket(type).set(id, merged);
    this.reindex(type, id);
    const operation = existing ? 'updated' : 'created';
    this.emit({
      system: this.system,
      type,
      sourceId: id,
      changeType: existing ? 'updated' : 'created',
      occurredAt: merged.__modifiedAt,
    });
    return { system: this.system, type, targetId: id, operation } as const;
  }

  async remove(type: CanonicalType, sourceId: string) {
    this.bucket(type).delete(sourceId);
    this.reindex(type, sourceId);
    const occurredAt = new Date().toISOString();
    const log = this.deletions.get(type) ?? [];
    log.push({ sourceId, occurredAt });
    this.deletions.set(type, log);
    this.emit({ system: this.system, type, sourceId, changeType: 'deleted', occurredAt });
    return { system: this.system, type, targetId: sourceId, operation: 'deleted' as const };
  }

  /** The mock usually emits events via onChange; webhook events map through the registry. */
  async resolveWebhookEvent(
    event: NativeWebhookEvent,
    resolveType?: (nativeObjectId: string, sourceId: string) => Promise<CanonicalType | undefined>,
  ): Promise<ChangeEvent | null> {
    // HubSpot deliveries name standard objects by type id.
    const standard: Record<string, string> = {
      '0-1': 'contacts', '0-2': 'companies', '0-3': 'deals', '0-5': 'tickets',
    };
    const nativeObject = (this.system === 'hubspot' ? standard[event.nativeObject] : undefined) ??
      (this.config.isRegisteredCanonicalObject(event.nativeObject)
        ? this.config.nativeObjectName(this.system, event.nativeObject) : undefined) ?? event.nativeObject;
    const candidates = this.config.canonicalObjectsFor(this.system, nativeObject);
    const type = resolveType
      ? await resolveType(nativeObject, event.sourceId)
      : candidates.length === 1 ? candidates[0]!.canonicalObject : undefined;
    if (!type) return null;
    return {
      eventId: event.deliveryId,
      system: this.system,
      type,
      sourceId: event.sourceId,
      changeType: event.changeType,
      occurredAt: event.occurredAt,
    };
  }

  /** Mirrors readNativeFields for canonical types sharing one native object -- see CRMConnector. */
  async readNativeFields(
    nativeObject: string,
    sourceId: string,
    fields: string[],
  ): Promise<Record<string, unknown> | null> {
    for (const candidate of this.config.canonicalObjectsFor(this.system, nativeObject)) {
      const record = this.bucket(candidate.canonicalObject).get(sourceId);
      if (record) {
        return Object.fromEntries(fields.map((f) => [f, record[f] ?? null]));
      }
    }
    return null;
  }

  /** Test helper: seed a native record directly (simulating data already in the CRM). */
  seed(type: CanonicalType, fields: Record<string, FieldValue>): string {
    const rec = { ...fields } as unknown as CanonicalRecord['fields'];
    const native = this.config.fromCanonicalFields(this.system, type, rec);
    const id = `${this.system}-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.bucket(type).set(id, { ...native, __id: id, __modifiedAt: new Date().toISOString() });
    this.reindex(type, id);
    return id;
  }

  /** Test helper: force a record's modified timestamp (to script conflict scenarios). */
  setModifiedAt(type: CanonicalType, id: string, iso: string): void {
    const n = this.bucket(type).get(id);
    if (n) n.__modifiedAt = iso;
  }

  /** Test helper: read the raw native value of a field. */
  peek(type: CanonicalType, id: string, nativeField: string): FieldValue | undefined {
    return this.bucket(type).get(id)?.[nativeField];
  }

  /** Test helper for relationship migration. */
  link(
    fromType: CanonicalType,
    fromId: string,
    toType: CanonicalType,
    toId: string,
    kind = toType,
    label?: string,
  ): void {
    void this.associate(fromType, fromId, { toType, toId, kind, label });
  }

  /** Total records held across all types (used by the dashboard for demo counts). */
  size(): number {
    let n = 0;
    for (const m of this.store.values()) n += m.size;
    return n;
  }

  private emit(e: ChangeEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  private canonicalize(type: CanonicalType, n: NativeRecord): CanonicalRecord {
    return {
      canonicalId: '',
      type,
      fields: this.config.toCanonicalFields(this.system, type, n),
      meta: { source: this.system, sourceId: n.__id, modifiedAt: n.__modifiedAt },
    };
  }
}

/**
 * A write always advances a record's modified time, even within the same millisecond, the
 * way a real CRM's system timestamp does -- otherwise conditional-write tests could not tell
 * "changed after review" from "unchanged".
 */
function nextTimestamp(previous?: string): string {
  const now = Date.now();
  const floor = previous ? Date.parse(previous) + 1 : now;
  return new Date(Math.max(now, floor)).toISOString();
}
