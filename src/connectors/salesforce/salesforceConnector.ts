import axios, { type AxiosInstance } from 'axios';
import crypto from 'node:crypto';
import type { CRMConnector, ConnectorAssociation } from '../../core/connector.js';
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
import { getAccessToken } from './auth.js';
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { installHttpPolicy } from '../../core/httpPolicy.js';

/** canonical type -> Salesforce sObject name */
const SOBJECT: Record<CanonicalType, string> = {
  contact: 'Contact',
  company: 'Account',
  deal: 'Opportunity',
};
const CANONICAL_BY_SOBJECT = Object.fromEntries(
  Object.entries(SOBJECT).map(([type, object]) => [object, type as CanonicalType]),
) as Record<string, CanonicalType>;

const API_VERSION = 'v61.0';

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

  async list(type: CanonicalType, cursor?: string): Promise<RecordPage> {
    // cursor, when present, is a nextRecordsUrl path returned by a prior query.
    const url = cursor
      ? cursor
      : `/query?q=${encodeURIComponent(this.soql(type))}`;
    const { data } = await this.http.get(cursor ? cursor.replace(`/services/data/${API_VERSION}`, '') : url);
    const records: CanonicalRecord[] = (data.records as Record<string, unknown>[]).map((r) =>
      this.canonicalize(type, r),
    );
    return { records, nextCursor: data.done ? undefined : data.nextRecordsUrl };
  }

  async read(type: CanonicalType, sourceId: string): Promise<CanonicalRecord | null> {
    try {
      const fields = nativeFields('salesforce', type).filter((f) => !f.includes('.'));
      const { data } = await this.http.get(
        `/sobjects/${SOBJECT[type]}/${sourceId}?fields=${['Id', 'LastModifiedDate', ...fields].join(',')}`,
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
    const fields = nativeFields('salesforce', type);
    const soql = `SELECT Id, LastModifiedDate, ${fields.join(', ')}
      FROM ${SOBJECT[type]} WHERE ${predicate} LIMIT 10`;
    const { data } = await this.http.get(`/query?q=${encodeURIComponent(soql)}`);
    return (data.records as Record<string, unknown>[]).map((record) =>
      this.canonicalize(type, record),
    );
  }

  async describe(type: CanonicalType): Promise<SchemaField[]> {
    return (await this.describeObject(SOBJECT[type])).fields;
  }

  async listObjects(): Promise<CRMObjectDescriptor[]> {
    const { data } = await this.http.get('/sobjects');
    return (data.sobjects as SfObject[])
      .filter((object) => object.queryable && !object.deprecatedAndHidden)
      .map((object) => ({
        id: object.name,
        label: object.label,
        pluralLabel: object.labelPlural,
        custom: object.custom,
        queryable: object.queryable,
        createable: object.createable,
        updateable: object.updateable,
        deletable: object.deletable,
        canonicalType: CANONICAL_BY_SOBJECT[object.name],
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
      canonicalType: CANONICAL_BY_SOBJECT[objectId],
    };
    return {
      object: descriptor,
      fields: (data.fields as SfField[]).map((field) => ({
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
      relationships: (data.childRelationships as SfRelationship[] | undefined ?? [])
        .filter((relationship) => relationship.relationshipName)
        .map((relationship) => ({
          name: relationship.relationshipName!,
          label: relationship.relationshipName!,
          targetObjectId: relationship.childSObject,
          kind: 'child' as const,
        })),
    };
  }

  async listAssociations(
    type: CanonicalType,
    sourceId: string,
  ): Promise<ConnectorAssociation[]> {
    if (type === 'contact') {
      const { data } = await this.http.get(`/sobjects/Contact/${sourceId}?fields=AccountId`);
      return data.AccountId
        ? [{ toType: 'company', toId: String(data.AccountId), kind: 'company' }]
        : [];
    }
    if (type === 'deal') {
      const output: ConnectorAssociation[] = [];
      const { data } = await this.http.get(
        `/sobjects/Opportunity/${sourceId}?fields=AccountId`,
      );
      if (data.AccountId) {
        output.push({ toType: 'company', toId: String(data.AccountId), kind: 'company' });
      }
      const query =
        `SELECT ContactId, Role FROM OpportunityContactRole ` +
        `WHERE OpportunityId = '${escapeSoql(sourceId)}'`;
      const contacts = await this.http.get(`/query?q=${encodeURIComponent(query)}`);
      for (const row of contacts.data.records ?? []) {
        output.push({
          toType: 'contact',
          toId: String(row.ContactId),
          kind: 'contact',
          label: row.Role ? String(row.Role) : undefined,
        });
      }
      return output;
    }
    return [];
  }

  async associate(
    fromType: CanonicalType,
    fromId: string,
    association: ConnectorAssociation,
  ): Promise<void> {
    if (fromType === 'contact' && association.toType === 'company') {
      await this.http.patch(`/sobjects/Contact/${fromId}`, { AccountId: association.toId });
      return;
    }
    if (fromType === 'deal' && association.toType === 'company') {
      await this.http.patch(`/sobjects/Opportunity/${fromId}`, {
        AccountId: association.toId,
      });
      return;
    }
    if (fromType === 'deal' && association.toType === 'contact') {
      const query =
        `SELECT Id FROM OpportunityContactRole WHERE OpportunityId = '${escapeSoql(fromId)}' ` +
        `AND ContactId = '${escapeSoql(association.toId)}' LIMIT 1`;
      const existing = await this.http.get(`/query?q=${encodeURIComponent(query)}`);
      if (!existing.data.records?.length) {
        await this.http.post('/sobjects/OpportunityContactRole', {
          OpportunityId: fromId,
          ContactId: association.toId,
          Role: association.label ?? undefined,
        });
      }
    }
  }

  async upsert(record: CanonicalRecord, targetId?: string): Promise<UpsertResult> {
    const body = fromCanonicalFields('salesforce', record.type, record.fields);
    if (targetId) {
      await this.http.patch(`/sobjects/${SOBJECT[record.type]}/${targetId}`, body);
      return { system: this.system, type: record.type, targetId, operation: 'updated' };
    }
    const { data } = await this.http.post(`/sobjects/${SOBJECT[record.type]}`, body);
    return { system: this.system, type: record.type, targetId: data.id, operation: 'created' };
  }

  async remove(type: CanonicalType, sourceId: string): Promise<UpsertResult> {
    await this.http.delete(`/sobjects/${SOBJECT[type]}/${sourceId}`);
    return { system: this.system, type, targetId: sourceId, operation: 'deleted' };
  }

  /**
   * Salesforce has no built-in outbound webhook to arbitrary URLs. The common pattern is
   * an Apex trigger (or Change Data Capture / Platform Event subscriber) that POSTs to us
   * with an HMAC signature over the raw body using a shared secret (SF_WEBHOOK_SECRET).
   * Expected JSON: { events: [{ sobject, recordId, changeType, occurredAt }] }
   */
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): ChangeEvent[] {
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
    const reverse = Object.fromEntries(
      Object.entries(SOBJECT).map(([k, v]) => [v, k as CanonicalType]),
    ) as Record<string, CanonicalType>;
    return (payload.events ?? [])
      .filter((e) => reverse[e.sobject])
      .map((e) => ({
        eventId: crypto
          .createHash('sha256')
          .update(`${e.sobject}:${e.recordId}:${e.changeType}:${e.occurredAt ?? ''}`)
          .digest('hex'),
        system: this.system,
        type: reverse[e.sobject]!,
        sourceId: e.recordId,
        changeType: (e.changeType as ChangeEvent['changeType']) ?? 'updated',
        occurredAt: e.occurredAt ?? new Date().toISOString(),
      }));
  }

  // ----------------- internals -----------------

  private soql(type: CanonicalType): string {
    const fields = nativeFields('salesforce', type);
    return `SELECT Id, LastModifiedDate, ${fields.join(', ')} FROM ${SOBJECT[type]}`;
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

interface SfRelationship {
  relationshipName?: string | null;
  childSObject: string;
}

function escapeSoql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
