import crypto from 'node:crypto';
import type { CRMConnector, ConnectorAssociation } from '../../core/connector.js';
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
  private store = new Map<CanonicalType, Map<string, NativeRecord>>([
    ['contact', new Map()],
    ['company', new Map()],
    ['deal', new Map()],
  ]);
  private listeners: ((e: ChangeEvent) => void)[] = [];
  private associations = new Map<string, ConnectorAssociation[]>();

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

  async list(type: CanonicalType, cursor?: string): Promise<RecordPage> {
    const all = [...this.store.get(type)!.values()];
    const pageSize = 100;
    const start = cursor ? Number(cursor) : 0;
    const slice = all.slice(start, start + pageSize);
    const records = slice.map((n) => this.canonicalize(type, n));
    const next = start + pageSize;
    return { records, nextCursor: next < all.length ? String(next) : undefined };
  }

  async read(type: CanonicalType, sourceId: string): Promise<CanonicalRecord | null> {
    const n = this.store.get(type)!.get(sourceId);
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
      id: names[type][this.system],
      label: names[type].label,
      pluralLabel: `${names[type].label}s`,
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
    const existing = this.store.get(record.type)!.get(id);
    const merged: NativeRecord = {
      ...(existing ?? {}),
      ...native,
      __id: id,
      __modifiedAt: new Date().toISOString(),
    };
    this.store.get(record.type)!.set(id, merged);
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
    this.store.get(type)!.delete(sourceId);
    return { system: this.system, type, targetId: sourceId, operation: 'deleted' as const };
  }

  parseWebhook(): ChangeEvent[] {
    return []; // the mock injects events via onChange instead of HTTP
  }

  /** Test helper: seed a native record directly (simulating data already in the CRM). */
  seed(type: CanonicalType, fields: Record<string, FieldValue>): string {
    const rec = { ...fields } as unknown as CanonicalRecord['fields'];
    const native = fromCanonicalFields(this.system, type, rec);
    const id = `${this.system}-${crypto.randomUUID().slice(0, 8)}`;
    this.store.get(type)!.set(id, { ...native, __id: id, __modifiedAt: new Date().toISOString() });
    return id;
  }

  /** Test helper: force a record's modified timestamp (to script conflict scenarios). */
  setModifiedAt(type: CanonicalType, id: string, iso: string): void {
    const n = this.store.get(type)!.get(id);
    if (n) n.__modifiedAt = iso;
  }

  /** Test helper: read the raw native value of a field. */
  peek(type: CanonicalType, id: string, nativeField: string): FieldValue | undefined {
    return this.store.get(type)!.get(id)?.[nativeField];
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
