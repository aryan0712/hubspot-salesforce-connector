import crypto from 'node:crypto';
import type { CRMConnector, ConnectorAssociation, QueryCondition } from '../../core/connector.js';
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
import {
  fieldRules,
  fromCanonicalFields,
  toCanonicalFields,
} from '../../core/mapping.js';
import { naturalKey } from '../../core/idMap.js';
import { canonicalObjectsFor } from '../../core/objectRegistry.js';
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
type NativeRecord = Record<string, FieldValue> & { __id: string; __modifiedAt: string };

export class MockConnector implements CRMConnector {
  readonly system: SystemId;
  private store = new Map<CanonicalType, Map<string, NativeRecord>>();
  private listeners: ((e: ChangeEvent) => void)[] = [];
  private associations = new Map<string, ConnectorAssociation[]>();
  private deletions = new Map<CanonicalType, { sourceId: string; occurredAt: string }[]>();

  constructor(system: SystemId) {
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
    const records = (await this.list(type)).records;
    return records.filter((record) => naturalKey(record) === query.key);
  }

  async describe(type: CanonicalType): Promise<SchemaField[]> {
    return fieldRules(this.system, type).map((rule) => ({
      name: rule.native,
      label: rule.native,
      type: 'string',
      readOnly: rule.readOnly,
    }));
  }

  async listObjects(): Promise<CRMObjectDescriptor[]> {
    const names: Record<CanonicalType, { salesforce: string; hubspot: string; label: string }> = {
      contact: { salesforce: 'Contact', hubspot: 'contacts', label: 'Contact' },
      company: { salesforce: 'Account', hubspot: 'companies', label: 'Company' },
      deal: { salesforce: 'Opportunity', hubspot: 'deals', label: 'Deal' },
    };
    const objects: CRMObjectDescriptor[] = (Object.keys(names) as CanonicalType[]).map((type) => ({
      id: names[type]![this.system],
      label: names[type]!.label,
      pluralLabel: `${names[type]!.label}s`,
      custom: false,
      queryable: true,
      createable: true,
      updateable: true,
      deletable: true,
      canonicalType: type,
    }));
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
    return {
      object,
      fields: object.canonicalType ? await this.describe(object.canonicalType) : [],
      relationships: object.canonicalType === 'contact'
        ? [{ name: 'company', label: 'Company', targetObjectId: 'company', kind: 'parent' }]
        : [],
    };
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
    const native = fromCanonicalFields(this.system, record.type, record.fields);
    const id = targetId ?? `${this.system}-${crypto.randomUUID().slice(0, 8)}`;
    const existing = this.bucket(record.type).get(id);
    const merged: NativeRecord = {
      ...(existing ?? {}),
      ...native,
      __id: id,
      __modifiedAt: new Date().toISOString(),
    };
    this.bucket(record.type).set(id, merged);
    const operation = existing ? 'updated' : 'created';
    this.emit({
      system: this.system,
      type: record.type,
      sourceId: id,
      changeType: existing ? 'updated' : 'created',
      occurredAt: merged.__modifiedAt,
    });
    return { system: this.system, type: record.type, targetId: id, operation } as const;
  }

  async remove(type: CanonicalType, sourceId: string) {
    this.bucket(type).delete(sourceId);
    const occurredAt = new Date().toISOString();
    const log = this.deletions.get(type) ?? [];
    log.push({ sourceId, occurredAt });
    this.deletions.set(type, log);
    this.emit({ system: this.system, type, sourceId, changeType: 'deleted', occurredAt });
    return { system: this.system, type, targetId: sourceId, operation: 'deleted' as const };
  }

  async parseWebhook(): Promise<ChangeEvent[]> {
    return []; // the mock injects events via onChange instead of HTTP
  }

  /** Mirrors readNativeFields for canonical types sharing one native object -- see CRMConnector. */
  async readNativeFields(
    nativeObject: string,
    sourceId: string,
    fields: string[],
  ): Promise<Record<string, unknown> | null> {
    for (const candidate of canonicalObjectsFor(this.system, nativeObject)) {
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
    const native = fromCanonicalFields(this.system, type, rec);
    const id = `${this.system}-${crypto.randomUUID().slice(0, 8)}`;
    this.bucket(type).set(id, { ...native, __id: id, __modifiedAt: new Date().toISOString() });
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
      fields: toCanonicalFields(this.system, type, n),
      meta: { source: this.system, sourceId: n.__id, modifiedAt: n.__modifiedAt },
    };
  }
}
