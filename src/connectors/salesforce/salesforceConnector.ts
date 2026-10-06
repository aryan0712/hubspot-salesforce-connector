import axios, { type AxiosInstance } from 'axios';
import {
  ConditionalWriteRejectedError,
  IncompleteCandidateSetError,
  UnsupportedAssociationError,
  type CRMConnector,
  type ConnectorAssociation,
  type NativeWebhookEvent,
  type QueryCondition,
  type WriteOptions,
} from '../../core/connector.js';
import { connections } from '../../core/connectionStore.js';
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
  UpsertResult,
} from '../../core/types.js';
import type { ConfigContext } from '../../core/configContext.js';
import { getAccessToken, refreshAfterRejection } from './auth.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { installHttpPolicy, type ConnectorHealth, type HttpPolicyControls } from '../../core/httpPolicy.js';
import type { SyncCondition } from '../../core/syncConfig.js';
 
const API_VERSION = 'v61.0';
/** Broad natural-key searches beyond this many candidates are treated as incomplete. */
const NATURAL_KEY_CANDIDATE_LIMIT = 50;

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
  private policy?: HttpPolicyControls;

  constructor(
    private readonly config: ConfigContext,
    private readonly tenantKey = 'local',
  ) {}

  /** Circuit/health state of this connector's vendor calls (R07). */
  health(): ConnectorHealth | undefined {
    return this.policy?.health();
  }

  /** Cancels in-flight vendor requests (graceful shutdown). */
  abortRequests(): void {
    this.policy?.abortAll();
  }

  async init(): Promise<void> {
    const session = await getAccessToken();
    this.http = axios.create({
      baseURL: `${session.instanceUrl}/services/data/${API_VERSION}`,
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    this.policy = installHttpPolicy(this.http, {
      requestsPerSecond: env.SALESFORCE_REQUESTS_PER_SECOND,
      name: 'salesforce',
      limiterKey: `salesforce:${this.tenantKey}`,
      // SOQL is sent as GET /query; creates are POST /sobjects/<type>.
      refreshToken: async (rejected) => {
        const fresh = await refreshAfterRejection(rejected);
        this.http.defaults.baseURL = `${fresh.instanceUrl}/services/data/${API_VERSION}`;
        return fresh.accessToken;
      },
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
    const sobject = this.config.requireNativeObjectName('salesforce', type);
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
      const sobject = this.config.requireNativeObjectName('salesforce', type);
      const fields = excludeAlwaysQueriedFields(this.config.nativeFields('salesforce', type).filter((f) => !f.includes('.')));
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
      const field = this.config.nativeField('salesforce', type, criterion.field);
      if (!field || field.includes('.')) return undefined;
      const escaped = escapeSoql(criterion.value);
      return criterion.field === 'domain'
        ? `${field} LIKE '%${escaped}%'`
        : `${field} = '${escaped}'`;
    });
    if (predicates.some((predicate) => !predicate)) return [];
    const predicate = predicates.join(' AND ');
    const fields = excludeAlwaysQueriedFields(this.config.nativeFields('salesforce', type));
    const sobject = this.config.requireNativeObjectName('salesforce', type);
    // LIKE on Website is only a broad candidate search (the column holds full URLs); every
    // candidate is then verified against the exact normalised key, so example.com never
    // matches notexample.com. Hitting the limit means the set may be incomplete.
    const soql = `SELECT Id, LastModifiedDate, ${fields.join(', ')}
      FROM ${sobject} WHERE ${predicate} LIMIT ${NATURAL_KEY_CANDIDATE_LIMIT + 1}`;
    const { data } = await this.http.get(`/query?q=${encodeURIComponent(soql)}`);
    const records = data.records as Record<string, unknown>[];
    if (records.length > NATURAL_KEY_CANDIDATE_LIMIT || data.done === false) {
      throw new IncompleteCandidateSetError(
        `more than ${NATURAL_KEY_CANDIDATE_LIMIT} Salesforce ${type} candidates match ${query.key}`,
      );
    }
    return records
      .map((record) => this.canonicalize(type, record))
      .filter((record) => this.config.naturalKey(record) === query.key);
  }

  async describe(type: CanonicalType): Promise<SchemaField[]> {
    return (await this.describeObject(this.config.requireNativeObjectName('salesforce', type))).fields;
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
        canonicalType: this.config.canonicalObjectFor('salesforce', object.name),
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
      canonicalType: this.config.canonicalObjectFor('salesforce', objectId),
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
    const sobject = this.config.requireNativeObjectName('salesforce', type);
    const metadata = await this.describeObject(sobject);
    const parentLookups = metadata.relationships.filter(
      (relationship) =>
        relationship.kind === 'parent' && this.config.canonicalObjectFor('salesforce', relationship.targetObjectId),
    );
    if (!parentLookups.length) return [];
    const fieldNames = parentLookups.map((lookup) => lookup.name);
    const { data } = await this.http.get(`/sobjects/${sobject}/${sourceId}?fields=${fieldNames.join(',')}`);
    const output: ConnectorAssociation[] = [];
    for (const lookup of parentLookups) {
      const value = data[lookup.name];
      const toType = this.config.canonicalObjectFor('salesforce', lookup.targetObjectId);
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
    const sobject = this.config.requireNativeObjectName('salesforce', fromType);
    const metadata = await this.describeObject(sobject);
    const lookup = metadata.relationships.find(
      (relationship) =>
        relationship.kind === 'parent' &&
        this.config.canonicalObjectFor('salesforce', relationship.targetObjectId) === association.toType,
    );
    if (!lookup) {
      // Junction-object relationships (e.g. OpportunityContactRole) have no direct lookup.
      throw new UnsupportedAssociationError(
        `Salesforce ${sobject} has no lookup field to ${association.toType}; the relationship needs a junction object`,
      );
    }
    // A parent lookup is single-valued: the destination's current parent is replaced.
    await this.http.patch(`/sobjects/${sobject}/${fromId}`, { [lookup.name]: association.toId });
  }

  async upsert(record: CanonicalRecord, targetId?: string): Promise<UpsertResult> {
    const body = this.config.fromCanonicalFields('salesforce', record.type, record.fields);
    const { conditional: _conditional, ...result } = await this.write(record.type, body, targetId);
    return result;
  }

  /**
   * Exact-payload write. Updates can be conditional: Salesforce answers 412 when the row's
   * LastModifiedDate is later than If-Unmodified-Since, which we surface as
   * ConditionalWriteRejectedError so the approved write is stopped rather than applied to
   * a record that changed after review. Creates cannot be conditional.
   */
  async write(
    type: CanonicalType,
    payload: Record<string, FieldValue>,
    targetId?: string,
    options: WriteOptions = {},
  ): Promise<UpsertResult & { conditional: boolean }> {
    const sobject = this.config.requireNativeObjectName('salesforce', type);
    if (targetId) {
      const conditional = Boolean(options.ifUnmodifiedSince);
      try {
        await this.http.patch(`/sobjects/${sobject}/${targetId}`, payload, {
          headers: conditional
            ? { 'If-Unmodified-Since': new Date(options.ifUnmodifiedSince!).toUTCString() }
            : undefined,
        });
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 412) {
          throw new ConditionalWriteRejectedError();
        }
        throw err;
      }
      return { system: this.system, type, targetId, operation: 'updated', conditional };
    }
    const { data } = await this.http.post(`/sobjects/${sobject}`, payload);
    return { system: this.system, type, targetId: data.id, operation: 'created', conditional: false };
  }

  async accountIdentity(): Promise<string | undefined> {
    const connection = await connections.get('salesforce');
    if (!connection) return undefined;
    return `salesforce:${connection.environment}:${connection.accountId ?? connection.instanceUrl ?? connection.accountLabel ?? 'unknown'}`;
  }

  async remove(type: CanonicalType, sourceId: string): Promise<UpsertResult> {
    const sobject = this.config.requireNativeObjectName('salesforce', type);
    await this.http.delete(`/sobjects/${sobject}/${sourceId}`);
    return { system: this.system, type, targetId: sourceId, operation: 'deleted' };
  }

  /**
   * R12: maps a verified webhook event (sender contract and verification in
   * src/webhooks/salesforce.ts) to a ChangeEvent through the object registry.
   */
  async resolveWebhookEvent(
    event: NativeWebhookEvent,
    resolveType?: (nativeObjectId: string, sourceId: string) => Promise<CanonicalType | undefined>,
  ): Promise<ChangeEvent | null> {
    const candidates = this.config.canonicalObjectsFor('salesforce', event.nativeObject);
    const type =
      candidates.length <= 1
        ? candidates[0]?.canonicalObject
        : await resolveType?.(event.nativeObject, event.sourceId);
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

  // ----------------- internals -----------------

  private soql(
    type: CanonicalType,
    modifiedSince?: string,
    condition?: QueryCondition,
  ): string {
    const fields = excludeAlwaysQueriedFields(this.config.nativeFields('salesforce', type));
    const sobject = this.config.requireNativeObjectName('salesforce', type);
    const clauses = [
      // Inclusive: a record modified exactly at the boundary is not skipped (re-reads are
      // deduplicated by event id).
      modifiedSince ? `LastModifiedDate >= ${modifiedSince}` : undefined,
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
      fields: this.config.toCanonicalFields('salesforce', type, native),
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
