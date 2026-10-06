import axios, { type AxiosInstance } from 'axios';
import {
  IncompleteCandidateSetError,
  UnsupportedAssociationError,
  type CRMConnector,
  type ConnectorAssociation,
  type NativeWebhookEvent,
  type QueryCondition,
  type WriteOptions,
} from '../../core/connector.js';

/** HubSpot search page size used for natural-key lookups (vendor maximum is 200). */
const NATURAL_KEY_CANDIDATE_LIMIT = 100;
import { connections } from '../../core/connectionStore.js';
import type { SyncCondition } from '../../core/syncConfig.js';
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
import { getAccessToken, getAppSecret, refreshAfterRejection } from './auth.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { RateLimiter } from '../../core/rateLimiter.js';
import { installHttpPolicy, type ConnectorHealth, type HttpPolicyControls } from '../../core/httpPolicy.js';

const HUBSPOT_STANDARD_OBJECTS: CRMObjectDescriptor[] = [
  ['contacts', 'Contacts', 'Contact'],
  ['companies', 'Companies', 'Company'],
  ['deals', 'Deals', 'Deal'],
  ['tickets', 'Tickets', 'Ticket'],
  ['products', 'Products', 'Product'],
  ['line_items', 'Line items', 'Line item'],
  ['quotes', 'Quotes', 'Quote'],
  ['calls', 'Calls', 'Call'],
  ['emails', 'Emails', 'Email'],
  ['meetings', 'Meetings', 'Meeting'],
  ['notes', 'Notes', 'Note'],
  ['tasks', 'Tasks', 'Task'],
].map(([id, pluralLabel, label]) => ({
  id: id!,
  label: label!,
  pluralLabel: pluralLabel!,
  custom: false,
  queryable: true,
  createable: true,
  updateable: true,
  deletable: true,
}));

export class HubSpotConnector implements CRMConnector {
  readonly system = 'hubspot' as const;
  private http!: AxiosInstance;
  private appSecret: string;
  private readonly searchLimiter = new RateLimiter(5);
  // Resolves a webhook's numeric objectTypeId back to HubSpot's object type name. Seeded with
  // the standard-object ids (constant across every portal) and extended from /crm/v3/schemas
  // whenever listObjects() runs, so custom objects resolve too once discovered at least once.
  private readonly objectTypeIds = new Map<string, string>([
    ['0-1', 'contacts'],
    ['0-2', 'companies'],
    ['0-3', 'deals'],
  ]);

  private policy?: HttpPolicyControls;

  constructor(
    private readonly config: ConfigContext,
    appSecret = '',
    private readonly tenantKey = 'local',
  ) {
    this.appSecret = appSecret;
  }

  /** Circuit/health state of this connector's vendor calls (R07). */
  health(): ConnectorHealth | undefined {
    return this.policy?.health();
  }

  /** Cancels in-flight vendor requests (graceful shutdown). */
  abortRequests(): void {
    this.policy?.abortAll();
  }

  async init(): Promise<void> {
    const token = await getAccessToken();
    this.appSecret = await getAppSecret();
    this.http = axios.create({
      baseURL: 'https://api.hubapi.com',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.policy = installHttpPolicy(this.http, {
      requestsPerSecond: env.HUBSPOT_REQUESTS_PER_SECOND,
      name: 'hubspot',
      limiterKey: `hubspot:${this.tenantKey}`,
      // POST /search is a read and may be retried; POST /objects/<type> is a create.
      refreshToken: (rejected) => refreshAfterRejection(rejected),
    });
    // Warms the objectTypeId cache so custom-object webhooks resolve from the first event.
    await this.listObjects();
    logger.info('HubSpot connector ready');
  }

  async list(
    type: CanonicalType,
    cursor?: string,
    modifiedSince?: string,
    condition?: QueryCondition,
  ): Promise<RecordPage> {
    const object = this.config.requireNativeObjectName('hubspot', type);
    const properties = this.config.nativeFields('hubspot', type);
    const conditionFilters = (condition?.conditions ?? []).map(compileConditionFilter);
    if (modifiedSince || conditionFilters.length) {
      await this.searchLimiter.acquire();
      // HubSpot search cannot page past SEARCH_RESULT_CAP results. A "ts:<iso>" cursor
      // restarts the search from the last seen modified time (inclusive; the overlap is
      // deduplicated by event id), so large incremental polls are neither truncated nor fail.
      let since = modifiedSince;
      let after = cursor;
      if (cursor?.startsWith('ts:')) {
        since = cursor.slice(3);
        after = undefined;
      }
      const filters = [
        ...(since
          ? [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: Date.parse(since) }]
          : []),
        ...conditionFilters,
      ];
      const { data } = await this.http.post(`/crm/v3/objects/${object}/search`, {
        filterGroups: [{ filters }],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
        properties,
        limit: 100,
        after,
      });
      const records: CanonicalRecord[] = (data.results as HsObject[]).map((r) =>
        this.canonicalize(type, r),
      );
      return { records, nextCursor: searchNextCursor(data.paging?.next?.after, records, since) };
    }
    const { data } = await this.http.get(`/crm/v3/objects/${object}`, {
      params: { limit: 100, after: cursor, properties: properties.join(',') },
    });
    const records: CanonicalRecord[] = (data.results as HsObject[]).map((r) =>
      this.canonicalize(type, r),
    );
    return { records, nextCursor: data.paging?.next?.after };
  }

  /**
   * HubSpot has no dedicated "recently deleted" listing; archived (soft-deleted) records stay
   * retrievable for ~90 days via the archived=true flag. There's no separate archive timestamp,
   * so hs_lastmodifieddate (set when the record was archived) is used as the deletion time.
   */
  async listDeletedSince(
    type: CanonicalType,
    since: string,
  ): Promise<{ sourceId: string; occurredAt: string }[]> {
    const object = this.config.requireNativeObjectName('hubspot', type);
    const sinceMs = Date.parse(since);
    const out: { sourceId: string; occurredAt: string }[] = [];
    let after: string | undefined;
    do {
      const { data } = await this.http.get(`/crm/v3/objects/${object}`, {
        params: { limit: 100, after, archived: true, properties: 'hs_lastmodifieddate' },
      });
      for (const record of (data.results as HsObject[]) ?? []) {
        const modifiedAt = record.properties?.hs_lastmodifieddate;
        if (modifiedAt && Date.parse(modifiedAt) >= sinceMs) {
          out.push({ sourceId: record.id, occurredAt: new Date(Date.parse(modifiedAt)).toISOString() });
        }
      }
      after = data.paging?.next?.after;
    } while (after);
    return out;
  }

  async read(type: CanonicalType, sourceId: string): Promise<CanonicalRecord | null> {
    try {
      const object = this.config.requireNativeObjectName('hubspot', type);
      const properties = this.config.nativeFields('hubspot', type);
      const { data } = await this.http.get(`/crm/v3/objects/${object}/${sourceId}`, {
        params: { properties: properties.join(',') },
      });
      return this.canonicalize(type, data as HsObject);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  /** Raw native properties by native object name, bypassing canonical mapping -- see CRMConnector. */
  async readNativeFields(
    nativeObjectName: string,
    sourceId: string,
    fields: string[],
  ): Promise<Record<string, unknown> | null> {
    try {
      const { data } = await this.http.get(`/crm/v3/objects/${nativeObjectName}/${sourceId}`, {
        params: { properties: fields.join(',') },
      });
      return (data as HsObject).properties ?? {};
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  async findByNaturalKey(
    type: CanonicalType,
    query: NaturalKeyQuery,
  ): Promise<CanonicalRecord[]> {
    const filters = query.criteria.map((criterion) => ({
      propertyName: this.config.nativeField('hubspot', type, criterion.field),
      operator: 'EQ',
      value: criterion.value,
    }));
    if (filters.some((filter) => !filter.propertyName || filter.propertyName.includes('.'))) {
      return [];
    }
    await this.searchLimiter.acquire();
    const object = this.config.requireNativeObjectName('hubspot', type);
    const properties = this.config.nativeFields('hubspot', type);
    const { data } = await this.http.post(`/crm/v3/objects/${object}/search`, {
      filterGroups: [
        {
          filters,
        },
      ],
      properties,
      limit: NATURAL_KEY_CANDIDATE_LIMIT,
    });
    const results = data.results as HsObject[];
    // HubSpot reports the full match count; anything beyond one page is incomplete.
    if (Number(data.total ?? results.length) > results.length || data.paging?.next?.after) {
      throw new IncompleteCandidateSetError(
        `${data.total} HubSpot ${type} candidates match ${query.key}; the search result is incomplete`,
      );
    }
    return results
      .map((record) => this.canonicalize(type, record))
      .filter((record) => this.config.naturalKey(record) === query.key);
  }

  async describe(type: CanonicalType): Promise<SchemaField[]> {
    return (await this.describeObject(this.config.requireNativeObjectName('hubspot', type))).fields;
  }

  async listObjects(): Promise<CRMObjectDescriptor[]> {
    let custom: CRMObjectDescriptor[] = [];
    try {
      const { data } = await this.http.get('/crm/v3/schemas');
      const schemas = data.results as HsSchema[] | undefined ?? [];
      for (const schema of schemas) {
        const id = schema.fullyQualifiedName ?? schema.name;
        if (schema.objectTypeId) this.objectTypeIds.set(schema.objectTypeId, id);
      }
      custom = schemas.map((schema) => ({
        id: schema.fullyQualifiedName ?? schema.name,
        label: schema.labels?.singular ?? schema.name,
        pluralLabel: schema.labels?.plural ?? schema.name,
        custom: true,
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
      }));
    } catch (err: unknown) {
      if (!axios.isAxiosError(err) || ![401, 403, 404].includes(err.response?.status ?? 0)) throw err;
      // Missing the crm.schemas.custom.read scope (or no custom objects defined yet) both land
      // here as a 403/404 -- silently returning zero custom objects either way used to look
      // identical to "this portal genuinely has none," which is exactly the kind of silent
      // failure this app is supposed to avoid. Surfacing which one it actually is.
      logger.warn(
        { status: err.response?.status, data: err.response?.data },
        'could not list HubSpot custom object schemas -- likely a missing scope on the connected app/token',
      );
    }
    return [...HUBSPOT_STANDARD_OBJECTS, ...custom]
      .map((object) => ({ ...object, canonicalType: this.config.canonicalObjectFor('hubspot', object.id) }))
      .sort((a, b) => Number(Boolean(b.canonicalType)) - Number(Boolean(a.canonicalType)) ||
        a.label.localeCompare(b.label));
  }

  async describeObject(objectId: string): Promise<CRMObjectMetadata> {
    const descriptor =
      (await this.listObjects()).find((object) => object.id === objectId) ?? {
        id: objectId,
        label: objectId,
        pluralLabel: objectId,
        custom: objectId.startsWith('2-') || objectId.startsWith('p_'),
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
      };
    const { data } = await this.http.get(`/crm/v3/properties/${encodeURIComponent(objectId)}`);
    return {
      object: descriptor,
      fields: (data.results as HsProperty[]).map((field) => ({
        name: field.name,
        label: field.label,
        description: field.description,
        group: field.groupName,
        type: field.type,
        required: field.required,
        readOnly: field.modificationMetadata?.readOnlyValue,
        createable: !field.modificationMetadata?.readOnlyValue,
        updateable: !field.modificationMetadata?.readOnlyValue,
        unique: field.hasUniqueValue,
        calculated: field.calculated,
        custom: field.hubspotDefined === false,
        options: field.options?.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      })),
      relationships: [],
    };
  }

  /**
   * HubSpot's v4 associations API is generic for any object pair already — no hardcoded
   * pair graph needed. We just try every other registered canonical object as a candidate
   * target (a missing association type 404s harmlessly and is skipped).
   */
  async listAssociations(
    type: CanonicalType,
    sourceId: string,
  ): Promise<ConnectorAssociation[]> {
    const object = this.config.requireNativeObjectName('hubspot', type);
    const targets = this.config.listCanonicalObjects()
      .map((entry) => entry.canonicalObject)
      .filter((candidate) => candidate !== type);
    const output: ConnectorAssociation[] = [];
    for (const toType of targets) {
      const toObject = this.config.nativeObjectName('hubspot', toType);
      if (!toObject) continue;
      try {
        // Page through every association (not just the first 500).
        let after: string | undefined;
        do {
          const { data } = await this.http.get(
            `/crm/v4/objects/${object}/${sourceId}/associations/${toObject}`,
            { params: { limit: 500, after } },
          );
          for (const item of data.results ?? []) {
            const types = item.associationTypes as
              | { label?: string | null; category?: string }[]
              | undefined;
            const custom = types?.find((candidate) => candidate.label);
            output.push({
              toType,
              toId: String(item.toObjectId),
              kind: toType,
              label: custom?.label ?? undefined,
            });
          }
          after = data.paging?.next?.after;
        } while (after);
      } catch (err: unknown) {
        if (!axios.isAxiosError(err) || err.response?.status !== 404) throw err;
      }
    }
    return output;
  }

  async associate(
    fromType: CanonicalType,
    fromId: string,
    association: ConnectorAssociation,
  ): Promise<void> {
    const fromObject = this.config.requireNativeObjectName('hubspot', fromType);
    const toObject = this.config.requireNativeObjectName('hubspot', association.toType);
    if (!association.label) {
      await this.http.put(
        `/crm/v4/objects/${fromObject}/${fromId}/associations/default/${toObject}/${association.toId}`,
      );
      return;
    }
    // Preserve the label: resolve it to this portal's association type id; a label the
    // portal does not define cannot be represented and is reported, not silently dropped.
    const { data } = await this.http.get(`/crm/v4/associations/${fromObject}/${toObject}/labels`);
    const definition = (data.results as { label?: string; typeId: number; category: string }[] | undefined)
      ?.find((candidate) => candidate.label?.toLowerCase() === association.label!.toLowerCase());
    if (!definition) {
      throw new UnsupportedAssociationError(
        `HubSpot has no "${association.label}" association label between ${fromObject} and ${toObject}`,
      );
    }
    await this.http.put(
      `/crm/v4/objects/${fromObject}/${fromId}/associations/${toObject}/${association.toId}`,
      [{ associationCategory: definition.category, associationTypeId: definition.typeId }],
    );
  }

  async upsert(record: CanonicalRecord, targetId?: string): Promise<UpsertResult> {
    const properties = this.config.fromCanonicalFields('hubspot', record.type, record.fields);
    const { conditional: _conditional, ...result } = await this.write(record.type, properties, targetId);
    return result;
  }

  /**
   * Exact-payload write. HubSpot's CRM object API offers no conditional update
   * (no If-Match/If-Unmodified-Since), so `conditional` is always false: callers re-read
   * immediately before writing and treat the remaining window as a documented residual race.
   */
  async write(
    type: CanonicalType,
    payload: Record<string, FieldValue>,
    targetId?: string,
    _options: WriteOptions = {},
  ): Promise<UpsertResult & { conditional: boolean }> {
    const object = this.config.requireNativeObjectName('hubspot', type);
    if (targetId) {
      await this.http.patch(`/crm/v3/objects/${object}/${targetId}`, { properties: payload });
      return { system: this.system, type, targetId, operation: 'updated', conditional: false };
    }
    const { data } = await this.http.post(`/crm/v3/objects/${object}`, { properties: payload });
    return { system: this.system, type, targetId: data.id, operation: 'created', conditional: false };
  }

  async accountIdentity(): Promise<string | undefined> {
    const connection = await connections.get('hubspot');
    if (!connection) return undefined;
    return `hubspot:${connection.environment}:${connection.accountId ?? connection.accountLabel ?? 'unknown'}`;
  }

  async remove(type: CanonicalType, sourceId: string): Promise<UpsertResult> {
    // HubSpot DELETE archives the record.
    const object = this.config.requireNativeObjectName('hubspot', type);
    await this.http.delete(`/crm/v3/objects/${object}/${sourceId}`);
    return { system: this.system, type, targetId: sourceId, operation: 'deleted' };
  }

  /**
   * R12: maps a verified webhook event (see src/webhooks/hubspot.ts) to a ChangeEvent. The
   * native object name comes from the objectTypeId cache warmed in init()/listObjects()
   * (portal-specific for custom objects), then the registry -- no hardcoded object list.
   */
  async resolveWebhookEvent(
    event: NativeWebhookEvent,
    resolveType?: (nativeObjectId: string, sourceId: string) => Promise<CanonicalType | undefined>,
  ): Promise<ChangeEvent | null> {
    const objectName = this.objectTypeIds.get(event.nativeObject);
    if (!objectName) return null;
    const candidates = this.config.canonicalObjectsFor('hubspot', objectName);
    const type =
      candidates.length <= 1
        ? candidates[0]?.canonicalObject
        : await resolveType?.(objectName, event.sourceId);
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

  private canonicalize(type: CanonicalType, native: HsObject): CanonicalRecord {
    const flat = { ...native.properties, id: native.id } as Record<string, unknown>;
    return {
      canonicalId: '',
      type,
      fields: this.config.toCanonicalFields('hubspot', type, flat),
      meta: {
        source: 'hubspot',
        sourceId: String(native.id),
        modifiedAt: String(native.updatedAt ?? native.properties?.hs_lastmodifieddate ?? new Date().toISOString()),
      },
    };
  }
}

interface HsObject {
  id: string;
  properties: Record<string, string>;
  updatedAt?: string;
}

interface HsProperty {
  name: string;
  label: string;
  type: string;
  description?: string;
  groupName?: string;
  required?: boolean;
  hasUniqueValue?: boolean;
  calculated?: boolean;
  hubspotDefined?: boolean;
  options?: { value: string; label: string }[];
  modificationMetadata?: { readOnlyValue?: boolean };
}

interface HsSchema {
  name: string;
  objectTypeId?: string;
  fullyQualifiedName?: string;
  labels?: { singular?: string; plural?: string };
}

/** HubSpot search returns at most this many results for one query, however it is paged. */
export const SEARCH_RESULT_CAP = 10_000;

/**
 * Next cursor for a modified-since search. Near the result cap the search is restarted from
 * the last record's modified time instead of paging further (which HubSpot rejects).
 */
export function searchNextCursor(
  after: string | undefined,
  records: CanonicalRecord[],
  since: string | undefined,
): string | undefined {
  if (!after) return undefined;
  if (Number(after) + 100 < SEARCH_RESULT_CAP || !since) return after;
  const last = records.at(-1)?.meta.modifiedAt;
  if (!last) return undefined;
  if (Date.parse(last) <= Date.parse(since)) {
    throw new Error(
      `more than ${SEARCH_RESULT_CAP} HubSpot records share modified time ${last}; narrow the sync condition`,
    );
  }
  return `ts:${last}`;
}

/** One structured condition row -> a single HubSpot Search API filter. */
function compileConditionFilter(
  condition: SyncCondition,
): { propertyName: string; operator: string; value?: unknown } {
  switch (condition.operator) {
    case 'is_null':
      return { propertyName: condition.field, operator: 'NOT_HAS_PROPERTY' };
    case 'is_not_null':
      return { propertyName: condition.field, operator: 'HAS_PROPERTY' };
    case 'eq':
      return { propertyName: condition.field, operator: 'EQ', value: condition.value };
    case 'ne':
      return { propertyName: condition.field, operator: 'NEQ', value: condition.value };
    case 'gt':
      return { propertyName: condition.field, operator: 'GT', value: condition.value };
    case 'lt':
      return { propertyName: condition.field, operator: 'LT', value: condition.value };
    case 'contains':
      return { propertyName: condition.field, operator: 'CONTAINS_TOKEN', value: condition.value };
    default:
      return { propertyName: condition.field, operator: 'HAS_PROPERTY' };
  }
}
