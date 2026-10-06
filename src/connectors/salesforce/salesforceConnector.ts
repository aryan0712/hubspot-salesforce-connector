import axios, { type AxiosInstance } from 'axios';
import crypto from 'node:crypto';
import type { CRMConnector, ConnectorAssociation, QueryCondition } from '../../core/connector.js';
import type {
  CanonicalRecord,
  CanonicalType,
  ChangeEvent,
  CRMObjectDescriptor,
  CRMObjectMetadata,
  RecordPage,
  NaturalKeyQuery,
  SchemaField,
  UpsertResult,
} from '../../core/types.js';
import {
  fromCanonicalFields,
  nativeField,
  nativeFields,
  toCanonicalFields,
} from '../../core/mapping.js';
import { canonicalObjectFor, canonicalObjectsFor, requireNativeObjectName } from '../../core/objectRegistry.js';
import { getAccessToken } from './auth.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { installHttpPolicy } from '../../core/httpPolicy.js';
import type { SyncCondition } from '../../core/syncConfig.js';
 
const API_VERSION = 'v61.0';

// Every query already selects these explicitly; if a field mapping's native name happens to
// collide with one of them (e.g. a rule mapped to "Id"), Salesforce rejects the query with
// "duplicate field selected" -- so they're always excluded from the mapped field list.
const ALWAYS_QUERIED_FIELDS = new Set(['id', 'lastmodifieddate']);

function excludeAlwaysQueriedFields(fields: string[]): string[] {
  return fields.filter((field) => !ALWAYS_QUERIED_FIELDS.has(field.toLowerCase()));
}

export class SalesforceConnector implements CRMConnector {
  readonly system = 'salesforce' as const;
  private http!: AxiosInstance;

  async init(): Promise<void> {
    const session = await getAccessToken();
    this.http = axios.create({
      baseURL: `${session.instanceUrl}/services/data/${API_VERSION}`,
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    installHttpPolicy(this.http, {
      requestsPerSecond: env.SALESFORCE_REQUESTS_PER_SECOND,
      name: 'salesforce',
    });
    // Refresh the bearer on 401 once.
    this.http.interceptors.response.use(undefined, async (error) => {
      if (error.response?.status === 401) {
        const s = await getAccessToken();
        this.http.defaults.headers.Authorization = `Bearer ${s.accessToken}`;
        this.http.defaults.baseURL = `${s.instanceUrl}/services/data/${API_VERSION}`;
        return this.http.request(error.config);
      }
      throw error;
    });
    logger.info('Salesforce connector ready');
  }

  async list(
    type: CanonicalType,
    cursor?: string,
    modifiedSince?: string,
    condition?: QueryCondition,
  ): Promise<RecordPage> {
    // cursor, when present, is a nextRecordsUrl path returned by a prior query (it already
    // encodes any WHERE clause from the query that started the page sequence).
    const url = cursor
      ? cursor
      : `/query?q=${encodeURIComponent(this.soql(type, modifiedSince, condition))}`;
    const { data } = await this.http.get(cursor ? cursor.replace(`/services/data/${API_VERSION}`, '') : url);
    const records: CanonicalRecord[] = (data.records as Record<string, unknown>[]).map((r) =>
      this.canonicalize(type, r),
    );
    return { records, nextCursor: data.done ? undefined : data.nextRecordsUrl };
  }

  /**
   * Uses Salesforce's recycle-bin listing (retained ~15 days), scoped to this object type.
   * The recycle bin only returns id + deletion timestamp, never field values, so a sync
   * condition can't be re-checked here -- when a native object backs more than one canonical
   * object, the caller (syncPoller) disambiguates a deleted id via the id map instead (only
   * one of the sibling canonical objects could ever have linked it, since each one's own
   * create/update poll is already condition-scoped at the query).
   */
  async listDeletedSince(
    type: CanonicalType,
    since: string,
  ): Promise<{ sourceId: string; occurredAt: string }[]> {
    const sobject = requireNativeObjectName('salesforce', type);
    const { data } = await this.http.get(`/sobjects/${sobject}/deleted`, {
      params: { start: since, end: new Date().toISOString() },
    });
    const records = (data.deletedRecords as { id: string; deletedDate: string }[] | undefined) ?? [];
    return records.map((r) => ({ sourceId: r.id, occurredAt: r.deletedDate }));
  }

  /** Raw native fields by native object name, bypassing canonical mapping -- see CRMConnector. */
  async readNativeFields(
    nativeObjectName: string,
    sourceId: string,
    fields: string[],
  ): Promise<Record<string, unknown> | null> {
    try {
      const selected = [...new Set(['Id', ...fields])];
      const { data } = await this.http.get(
        `/sobjects/${nativeObjectName}/${sourceId}?fields=${selected.join(',')}`,
      );
      return data as Record<string, unknown>;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  async read(type: CanonicalType, sourceId: string): Promise<CanonicalRecord | null> {
    try {
      const sobject = requireNativeObjectName('salesforce', type);
      const fields = excludeAlwaysQueriedFields(nativeFields('salesforce', type).filter((f) => !f.includes('.')));
      const { data } = await this.http.get(
        `/sobjects/${sobject}/${sourceId}?fields=${['Id', 'LastModifiedDate', ...fields].join(',')}`,
      );
      return this.canonicalize(type, data);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  async findByNaturalKey(
    type: CanonicalType,
    query: NaturalKeyQuery,
  ): Promise<CanonicalRecord[]> {
    const predicates = query.criteria.map((criterion) => {
      const field = nativeField('salesforce', type, criterion.field);
      if (!field || field.includes('.')) return undefined;
      const escaped = escapeSoql(criterion.value);
      return criterion.field === 'domain'
        ? `${field} LIKE '%${escaped}%'`
        : `${field} = '${escaped}'`;
    });
    if (predicates.some((predicate) => !predicate)) return [];
    const predicate = predicates.join(' AND ');
    const fields = excludeAlwaysQueriedFields(nativeFields('salesforce', type));
    const sobject = requireNativeObjectName('salesforce', type);
    const soql = `SELECT Id, LastModifiedDate, ${fields.join(', ')}
      FROM ${sobject} WHERE ${predicate} LIMIT 10`;
    const { data } = await this.http.get(`/query?q=${encodeURIComponent(soql)}`);
    return (data.records as Record<string, unknown>[]).map((record) =>
      this.canonicalize(type, record),
    );
  }

  async describe(type: CanonicalType): Promise<SchemaField[]> {
    return (await this.describeObject(requireNativeObjectName('salesforce', type))).fields;
  }

  async listObjects(): Promise<CRMObjectDescriptor[]> {
    const { data } = await this.http.get('/sobjects');
    return (data.sobjects as SfObject[])
      .filter((object) => object.queryable && !object.deprecatedAndHidden && !isInternalCompanionObject(object))
      .map((object) => ({
        id: object.name,
        label: object.label,
        pluralLabel: object.labelPlural,
        custom: object.custom,
        queryable: object.queryable,
        createable: object.createable,
        updateable: object.updateable,
        deletable: object.deletable,
        canonicalType: canonicalObjectFor('salesforce', object.name),
      }))
      .sort((a, b) => Number(Boolean(b.canonicalType)) - Number(Boolean(a.canonicalType)) ||
        a.label.localeCompare(b.label));
  }

  async describeObject(objectId: string): Promise<CRMObjectMetadata> {
    const { data } = await this.http.get(`/sobjects/${encodeURIComponent(objectId)}/describe`);
    const descriptor: CRMObjectDescriptor = {
      id: String(data.name ?? objectId),
      label: String(data.label ?? objectId),
      pluralLabel: String(data.labelPlural ?? data.label ?? objectId),
      custom: Boolean(data.custom),
      queryable: Boolean(data.queryable),
      createable: Boolean(data.createable),
      updateable: Boolean(data.updateable),
      deletable: Boolean(data.deletable),
      canonicalType: canonicalObjectFor('salesforce', objectId),
    };
    const fields = data.fields as SfField[];
    // Parent lookups come from this object's own reference-type fields (e.g. Contact.AccountId
    // -> Account); child relationships come from the describe response's childRelationships.
    // Together these are enough to drive associations generically for any object, standard or
    // custom, without a hardcoded per-pair graph.
    const parentRelationships = fields
      .filter((field) => field.type === 'reference' && field.referenceTo?.length)
      .map((field) => ({
        name: field.name,
        label: field.relationshipName ?? field.label,
        targetObjectId: field.referenceTo![0]!,
        kind: 'parent' as const,
      }));
    const childRelationships = (data.childRelationships as SfRelationship[] | undefined ?? [])
      .filter((relationship) => relationship.relationshipName)
      .map((relationship) => ({
        name: relationship.relationshipName!,
        label: relationship.relationshipName!,
        targetObjectId: relationship.childSObject,
        kind: 'child' as const,
      }));
    return {
      object: descriptor,
      fields: fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: !field.nillable && !field.defaultedOnCreate,
        readOnly: !field.updateable,
        createable: field.createable,
        updateable: field.updateable,
        unique: field.unique,
        calculated: field.calculated,
        custom: field.custom,
        options: field.picklistValues?.filter((option) => option.active !== false).map((option) => ({
          value: option.value,
          label: option.label,
        })),
      })),
      relationships: [...parentRelationships, ...childRelationships],
    };
  }

  /**
   * Generic via parent-lookup fields (e.g. Contact.AccountId, custom lookup fields on any
   * object). Many-to-many associations that go through a junction object (e.g. Salesforce's
   * built-in OpportunityContactRole) aren't auto-discoverable from describe() metadata alone
   * and are out of scope here — they'd need an explicit junction-object mapping.
   */
  async listAssociations(
    type: CanonicalType,
    sourceId: string,
  ): Promise<ConnectorAssociation[]> {
    const sobject = requireNativeObjectName('salesforce', type);
    const metadata = await this.describeObject(sobject);
    const parentLookups = metadata.relationships.filter(
      (relationship) =>
        relationship.kind === 'parent' && canonicalObjectFor('salesforce', relationship.targetObjectId),
    );
    if (!parentLookups.length) return [];
    const fieldNames = parentLookups.map((lookup) => lookup.name);
    const { data } = await this.http.get(`/sobjects/${sobject}/${sourceId}?fields=${fieldNames.join(',')}`);
    const output: ConnectorAssociation[] = [];
    for (const lookup of parentLookups) {
      const value = data[lookup.name];
      const toType = canonicalObjectFor('salesforce', lookup.targetObjectId);
      if (!value || !toType) continue;
      output.push({ toType, toId: String(value), kind: lookup.label ?? lookup.name });
    }
    return output;          
  }

  async associate(
    fromType: CanonicalType,
    fromId: string,
    association: ConnectorAssociation,
  ): Promise<void> {
    const sobject = requireNativeObjectName('salesforce', fromType);
    const metadata = await this.describeObject(sobject);
    const lookup = metadata.relationships.find(
      (relationship) =>
        relationship.kind === 'parent' &&
        canonicalObjectFor('salesforce', relationship.targetObjectId) === association.toType,
    );
    if (!lookup) return; // no direct lookup field; junction-object associations aren't handled here
    await this.http.patch(`/sobjects/${sobject}/${fromId}`, { [lookup.name]: association.toId });
  }

  async upsert(record: CanonicalRecord, targetId?: string): Promise<UpsertResult> {
    const sobject = requireNativeObjectName('salesforce', record.type);
    const body = fromCanonicalFields('salesforce', record.type, record.fields);
    if (targetId) {
      await this.http.patch(`/sobjects/${sobject}/${targetId}`, body);
      return { system: this.system, type: record.type, targetId, operation: 'updated' };
    }
    const { data } = await this.http.post(`/sobjects/${sobject}`, body);
    return { system: this.system, type: record.type, targetId: data.id, operation: 'created' };
  }

  async remove(type: CanonicalType, sourceId: string): Promise<UpsertResult> {
    const sobject = requireNativeObjectName('salesforce', type);
    await this.http.delete(`/sobjects/${sobject}/${sourceId}`);
    return { system: this.system, type, targetId: sourceId, operation: 'deleted' };
  }

  /**
   * Salesforce has no built-in outbound webhook to arbitrary URLs. The common pattern is
   * an Apex trigger (or Change Data Capture / Platform Event subscriber) that POSTs to us
   * with an HMAC signature over the raw body using a shared secret (SF_WEBHOOK_SECRET).
   * Expected JSON: { events: [{ sobject, recordId, changeType, occurredAt }] }
   */
  async parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
    resolveType?: (nativeObjectId: string, sourceId: string) => Promise<CanonicalType | undefined>,
  ): Promise<ChangeEvent[]> {
    const secret = env.SF_WEBHOOK_SECRET;
    if (!secret && !env.ALLOW_UNSIGNED_WEBHOOKS) {
      throw new Error('Salesforce webhook secret unavailable');
    }
    if (secret) {
      const provided = String(headers['x-signature'] ?? '');
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      if (!safeEqual(provided, expected)) throw new Error('Salesforce webhook signature mismatch');
    }
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      events?: { sobject: string; recordId: string; changeType: string; occurredAt?: string }[];
    };
    const events: ChangeEvent[] = [];
    for (const e of payload.events ?? []) {
      const candidates = canonicalObjectsFor('salesforce', e.sobject);
      const type =
        candidates.length <= 1
          ? candidates[0]?.canonicalObject
          : await resolveType?.(e.sobject, e.recordId);
      if (!type) continue;
      events.push({
        eventId: crypto
          .createHash('sha256')
          .update(`${e.sobject}:${e.recordId}:${e.changeType}:${e.occurredAt ?? ''}`)
          .digest('hex'),
        system: this.system,
        type,
        sourceId: e.recordId,
        changeType: (e.changeType as ChangeEvent['changeType']) ?? 'updated',
        occurredAt: e.occurredAt ?? new Date().toISOString(),
      });
    }
    return events;
  }

  // ----------------- internals -----------------

  private soql(
    type: CanonicalType,
    modifiedSince?: string,
    condition?: QueryCondition,
  ): string {
    const fields = excludeAlwaysQueriedFields(nativeFields('salesforce', type));
    const sobject = requireNativeObjectName('salesforce', type);
    const clauses = [
      modifiedSince ? `LastModifiedDate > ${modifiedSince}` : undefined,
      ...(condition?.conditions ?? []).map(compileConditionSoql),
      condition?.rawCondition ? `(${condition.rawCondition})` : undefined,
    ].filter((clause): clause is string => Boolean(clause));
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return `SELECT Id, LastModifiedDate, ${fields.join(', ')} FROM ${sobject}${where}`;
  }

  private canonicalize(type: CanonicalType, native: Record<string, unknown>): CanonicalRecord {
    return {
      canonicalId: '', // assigned by the engine via the id map
      type,
      fields: toCanonicalFields('salesforce', type, native),
      meta: {
        source: 'salesforce',
        sourceId: String(native.Id ?? ''),
        modifiedAt: String(native.LastModifiedDate ?? new Date().toISOString()),
      },
    };
  }
}

interface SfField {
  name: string;
  label: string;
  type: string;
  nillable: boolean;
  defaultedOnCreate: boolean;
  updateable: boolean;
  createable?: boolean;
  unique?: boolean;
  calculated?: boolean;
  custom?: boolean;
  referenceTo?: string[];
  relationshipName?: string | null;
  picklistValues?: { value: string; label: string; active?: boolean }[];
}

interface SfObject {
  name: string;
  label: string;
  labelPlural: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  deprecatedAndHidden?: boolean;
}

// Every standard and custom object automatically gets several auto-generated companion
// objects (feed/history/sharing/change-data-capture) that are queryable but were never meant
// to be picked as a sync/migration object in their own right -- without this, listObjects()
// returns thousands of entries buried in noise (a real org: ~2000, only a few hundred of
// which are actual business objects). A handful of well-known Salesforce-generated suffixes
// catches essentially all of them; a genuine custom object always ends in "__c" first, so
// e.g. "Payment_History__c" is untouched -- only the exact auto-generated companion names
// (e.g. "AccountHistory", "MyObject__Share") match.
const INTERNAL_COMPANION_SUFFIXES = ['History', 'Feed', 'Share', 'ChangeEvent', 'Tag'];
function isInternalCompanionObject(object: SfObject): boolean {
  if (object.label.includes('__MISSING LABEL__')) return true;
  return INTERNAL_COMPANION_SUFFIXES.some(
    (suffix) => object.name.endsWith(suffix) || object.name.endsWith(`__${suffix}`),
  );
}

interface SfRelationship {
  relationshipName?: string | null;
  childSObject: string;
}

/** One structured condition row -> a single SOQL comparison, values escaped per SOQL literal rules. */
function compileConditionSoql(condition: SyncCondition): string {
  const literal = (value: unknown): string => {
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    return `'${escapeSoql(String(value ?? ''))}'`;
  };
  switch (condition.operator) {
    case 'is_null':
      return `${condition.field} = null`;
    case 'is_not_null':
      return `${condition.field} != null`;
    case 'eq':
      return `${condition.field} = ${literal(condition.value)}`;
    case 'ne':
      return `${condition.field} != ${literal(condition.value)}`;
    case 'gt':
      return `${condition.field} > ${literal(condition.value)}`;
    case 'lt':
      return `${condition.field} < ${literal(condition.value)}`;
    case 'contains':
      return `${condition.field} LIKE '%${escapeSoql(String(condition.value ?? ''))}%'`;
    default:
      return '';
  }
}

function escapeSoql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
