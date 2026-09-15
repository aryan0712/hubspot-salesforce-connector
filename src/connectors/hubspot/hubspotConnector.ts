import axios, { type AxiosInstance } from 'axios';
import crypto from 'node:crypto';
import type { CRMConnector, ConnectorAssociation, QueryCondition } from '../../core/connector.js';
import type { SyncCondition } from '../../core/syncConfig.js';
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
import {
  canonicalObjectFor,
  canonicalObjectsFor,
  listCanonicalObjects,
  nativeObjectName,
  requireNativeObjectName,
} from '../../core/objectRegistry.js';
import { getAccessToken, getAppSecret } from './auth.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { RateLimiter } from '../../core/rateLimiter.js';
import { installHttpPolicy } from '../../core/httpPolicy.js';

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

  constructor(appSecret = '') {
    this.appSecret = appSecret;
  }

  async init(): Promise<void> {
    const token = await getAccessToken();
    this.appSecret = await getAppSecret();
    this.http = axios.create({
      baseURL: 'https://api.hubapi.com',
      headers: { Authorization: `Bearer ${token}` },
    });
    installHttpPolicy(this.http, {
      requestsPerSecond: env.HUBSPOT_REQUESTS_PER_SECOND,
      name: 'hubspot',
    });
    this.http.interceptors.response.use(undefined, async (error) => {
      if (error.response?.status === 401) {
        const t = await getAccessToken();
        this.http.defaults.headers.Authorization = `Bearer ${t}`;
        return this.http.request(error.config);
      }
      throw error;
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
    const object = requireNativeObjectName('hubspot', type);
    const properties = nativeFields('hubspot', type);
    const conditionFilters = (condition?.conditions ?? []).map(compileConditionFilter);
    if (modifiedSince || conditionFilters.length) {
      await this.searchLimiter.acquire();
      const filters = [
        ...(modifiedSince
          ? [{ propertyName: 'hs_lastmodifieddate', operator: 'GT', value: Date.parse(modifiedSince) }]
          : []),
        ...conditionFilters,
      ];
      const { data } = await this.http.post(`/crm/v3/objects/${object}/search`, {
        filterGroups: [{ filters }],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
        properties,
        limit: 100,
        after: cursor,
      });
      const records: CanonicalRecord[] = (data.results as HsObject[]).map((r) =>
        this.canonicalize(type, r),
      );
      return { records, nextCursor: data.paging?.next?.after };
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
    const object = requireNativeObjectName('hubspot', type);
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
      const object = requireNativeObjectName('hubspot', type);
      const properties = nativeFields('hubspot', type);
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
      propertyName: nativeField('hubspot', type, criterion.field),
      operator: 'EQ',
      value: criterion.value,
    }));
    if (filters.some((filter) => !filter.propertyName || filter.propertyName.includes('.'))) {
      return [];
    }
    await this.searchLimiter.acquire();
    const object = requireNativeObjectName('hubspot', type);
    const properties = nativeFields('hubspot', type);
    const { data } = await this.http.post(`/crm/v3/objects/${object}/search`, {
      filterGroups: [
        {
          filters,
        },
      ],
      properties,
      limit: 10,
    });
    return (data.results as HsObject[]).map((record) => this.canonicalize(type, record));
  }

  async describe(type: CanonicalType): Promise<SchemaField[]> {
    return (await this.describeObject(requireNativeObjectName('hubspot', type))).fields;
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
    }
    return [...HUBSPOT_STANDARD_OBJECTS, ...custom]
      .map((object) => ({ ...object, canonicalType: canonicalObjectFor('hubspot', object.id) }))
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
    const object = requireNativeObjectName('hubspot', type);
    const targets = listCanonicalObjects()
      .map((entry) => entry.canonicalObject)
      .filter((candidate) => candidate !== type);
    const output: ConnectorAssociation[] = [];
    for (const toType of targets) {
      const toObject = nativeObjectName('hubspot', toType);
      if (!toObject) continue;
      try {
        const { data } = await this.http.get(
          `/crm/v4/objects/${object}/${sourceId}/associations/${toObject}`,
          { params: { limit: 500 } },
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
    const fromObject = requireNativeObjectName('hubspot', fromType);
    const toObject = requireNativeObjectName('hubspot', association.toType);
    await this.http.put(
      `/crm/v4/objects/${fromObject}/${fromId}/associations/default/${toObject}/${association.toId}`,
    );
  }

  async upsert(record: CanonicalRecord, targetId?: string): Promise<UpsertResult> {
    const object = requireNativeObjectName('hubspot', record.type);
    const properties = fromCanonicalFields('hubspot', record.type, record.fields);
    if (targetId) {
      await this.http.patch(`/crm/v3/objects/${object}/${targetId}`, { properties });
      return { system: this.system, type: record.type, targetId, operation: 'updated' };
    }
    const { data } = await this.http.post(`/crm/v3/objects/${object}`, { properties });
    return { system: this.system, type: record.type, targetId: data.id, operation: 'created' };
  }

  async remove(type: CanonicalType, sourceId: string): Promise<UpsertResult> {
    // HubSpot DELETE archives the record.
    const object = requireNativeObjectName('hubspot', type);
    await this.http.delete(`/crm/v3/objects/${object}/${sourceId}`);
    return { system: this.system, type, targetId: sourceId, operation: 'deleted' };
  }

  /**
   * HubSpot webhooks POST an array of events and sign with X-HubSpot-Signature-v3
   * (HMAC-SHA256 over method + uri + body + timestamp, base64). We validate before trusting.
   */
  async parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
    resolveType?: (nativeObjectId: string, sourceId: string) => Promise<CanonicalType | undefined>,
  ): Promise<ChangeEvent[]> {
    const secret = this.appSecret || env.HUBSPOT_APP_SECRET;
    if (!secret && !env.ALLOW_UNSIGNED_WEBHOOKS) {
      throw new Error('HubSpot webhook secret unavailable');
    }
    if (secret) {
      const signature = String(headers['x-hubspot-signature-v3'] ?? '');
      const timestamp = String(headers['x-hubspot-request-timestamp'] ?? '');
      const uri = `${env.PUBLIC_BASE_URL}/webhooks/hubspot`;
      const base = `POST${uri}${rawBody.toString('utf8')}${timestamp}`;
      const expected = crypto.createHmac('sha256', secret).update(base).digest('base64');
      if (!safeEqual(signature, expected)) throw new Error('HubSpot webhook signature mismatch');
    }
    const rawEvents = JSON.parse(rawBody.toString('utf8')) as HsWebhookEvent[];
    const events: ChangeEvent[] = [];
    for (const e of rawEvents) {
      const mapped = await this.mapEvent(e, resolveType);
      if (mapped) events.push(mapped);
    }
    return events;
  }

  // ----------------- internals -----------------

  private async mapEvent(
    e: HsWebhookEvent,
    resolveType?: (nativeObjectId: string, sourceId: string) => Promise<CanonicalType | undefined>,
  ): Promise<ChangeEvent | null> {
    // Resolve the native object name from the numeric objectTypeId (portal-specific for custom
    // objects, constant for standard ones) via the cache warmed in init()/listObjects(), then
    // map that to a canonical object through the registry — no hardcoded object list here.
    const objectName = this.objectTypeIds.get(e.objectTypeId ?? '');
    if (!objectName) return null;
    const candidates = canonicalObjectsFor('hubspot', objectName);
    const type =
      candidates.length <= 1
        ? candidates[0]?.canonicalObject
        : await resolveType?.(objectName, String(e.objectId));
    if (!type) return null;
    const changeType = e.subscriptionType?.endsWith('creation')
      ? 'created'
      : e.subscriptionType?.endsWith('deletion')
        ? 'deleted'
        : 'updated';
    return {
      eventId: crypto
        .createHash('sha256')
        .update(
          `${e.portalId ?? ''}:${e.subscriptionId ?? ''}:${e.eventId ?? ''}:` +
            `${e.subscriptionType}:${e.objectId}:${e.occurredAt ?? ''}`,
        )
        .digest('hex'),
      system: this.system,
      type,
      sourceId: String(e.objectId),
      changeType,
      occurredAt: e.occurredAt ? new Date(e.occurredAt).toISOString() : new Date().toISOString(),
    };
  }

  private canonicalize(type: CanonicalType, native: HsObject): CanonicalRecord {
    const flat = { ...native.properties, id: native.id } as Record<string, unknown>;
    return {
      canonicalId: '',
      type,
      fields: toCanonicalFields('hubspot', type, flat),
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

interface HsWebhookEvent {
  eventId?: number | string;
  portalId?: number | string;
  subscriptionId?: number | string;
  objectId: number | string;
  subscriptionType?: string; // e.g. "contact.propertyChange", "deal.creation"
  objectTypeId?: string;
  occurredAt?: number;
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

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
