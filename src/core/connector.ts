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
  UpsertResult,
} from './types.js';
import type { SyncCondition } from './syncConfig.js';

export interface WriteOptions {
  /** Reject an update if the record was modified after this ISO instant (when supported). */
  ifUnmodifiedSince?: string;
}

/** The vendor rejected a conditional write because the record changed after review. */
export class ConditionalWriteRejectedError extends Error {
  constructor(message = 'record changed after it was reviewed') {
    super(message);
    this.name = 'ConditionalWriteRejectedError';
  }
}

/**
 * A natural-key search returned a truncated candidate set (vendor page/limit reached), so
 * "no other match exists" cannot be proven. Matching must stop for review rather than
 * accept an incomplete candidate list.
 */
export class IncompleteCandidateSetError extends Error {
  constructor(message = 'the destination search returned an incomplete candidate set') {
    super(message);
    this.name = 'IncompleteCandidateSetError';
  }
}

/** The destination cannot represent this relationship (no lookup field, unknown label, junction). */
export class UnsupportedAssociationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedAssociationError';
  }
}

/**
 * A verified vendor webhook event before object-type resolution (R12). `nativeObject` is what
 * the vendor names: a HubSpot objectTypeId (e.g. "0-1") or a Salesforce sObject API name.
 */
export interface NativeWebhookEvent {
  system: SystemId;
  /** Stable per vendor event, so redeliveries are recognized as the same event. */
  deliveryId: string;
  accountId?: string;
  nativeObject: string;
  sourceId: string;
  changeType: 'created' | 'updated' | 'deleted';
  occurredAt: string;
}

export interface ConnectorAssociation {
  toType: CanonicalType;
  toId: string;
  kind: string;
  label?: string;
}

/** Which native records are eligible for sync, scoped to one system's native schema. */
export interface QueryCondition {
  conditions?: SyncCondition[];
  /** Salesforce-only advanced raw SOQL WHERE fragment; ignored by connectors without one. */
  rawCondition?: string;
}

/**
 * Every CRM we integrate implements this one interface. The engines (migration + sync)
 * are written entirely against CRMConnector and never import a vendor SDK directly.
 *
 * Contract notes:
 *  - read/list return records ALREADY canonicalized (native -> canonical happens inside).
 *  - upsert takes a CanonicalRecord and maps canonical -> native internally.
 *  - upsert MUST be idempotent given the same canonical input (safe to retry).
 */
export interface CRMConnector {
  readonly system: SystemId;

  /** Verify credentials / refresh tokens. Throws if the connector can't be used. */
  init(): Promise<void>;

  /**
   * Stream every record of a type, page by page (for migration / initial backfill).
   * @param modifiedSince  when set, restricts to records changed at/after this ISO timestamp
   *   (used for incremental polling instead of a full scan).
   * @param condition  optional sync-condition filter, applied at the query itself.
   */
  list(
    type: CanonicalType,
    cursor?: string,
    modifiedSince?: string,
    condition?: QueryCondition,
  ): Promise<RecordPage>;

  /**
   * Native ids removed/archived at or after `since` (ISO timestamp), for deletion polling.
   * A deleted record's field values are gone, so this can't be condition-filtered at the
   * source; when a native object backs more than one canonical object, the caller
   * disambiguates a deleted id via the id map instead (see engine/syncPoller.ts).
   */
  listDeletedSince(
    type: CanonicalType,
    since: string,
  ): Promise<{ sourceId: string; occurredAt: string }[]>;

  /** Fetch a single record by its native id, canonicalized. Null if it no longer exists. */
  read(type: CanonicalType, sourceId: string): Promise<CanonicalRecord | null>;

  /**
   * Search the target itself before creating a record. Returning all candidates lets the
   * engine stop for human review instead of guessing when a natural key is ambiguous.
   */
  findByNaturalKey(type: CanonicalType, query: NaturalKeyQuery): Promise<CanonicalRecord[]>;

  /** Discover native fields for Mapping Studio and preflight validation. */
  describe(type: CanonicalType): Promise<SchemaField[]>;

  /**
   * Read a handful of raw native field values by native object name + id, bypassing canonical
   * mapping entirely. Used only to disambiguate which of several canonical objects a native
   * object backs (see engine/typeResolver.ts) -- at that point the canonical `type` isn't known
   * yet, so `read()` (which requires it) can't be used. Null if the record no longer exists.
   */
  readNativeFields(
    nativeObjectName: string,
    sourceId: string,
    fields: string[],
  ): Promise<Record<string, unknown> | null>;

  /** Discover the broader native object catalog for migration planning. */
  listObjects(): Promise<CRMObjectDescriptor[]>;

  /** Describe one native object without leaking its vendor response shape. */
  describeObject(objectId: string): Promise<CRMObjectMetadata>;

  /** Read native record relationships in a normalized shape. */
  listAssociations(type: CanonicalType, sourceId: string): Promise<ConnectorAssociation[]>;

  /** Idempotently create/update a relationship between two native records. */
  associate(
    fromType: CanonicalType,
    fromId: string,
    association: ConnectorAssociation,
  ): Promise<void>;

  /**
   * Create or update a record in this system from a canonical snapshot.
   * @param targetId  the known native id in THIS system, if we've synced it before.
   */
  upsert(record: CanonicalRecord, targetId?: string): Promise<UpsertResult>;

  /**
   * Send an exact, already-translated native payload. Approved migration plans are executed
   * through this method so the bytes written are the bytes the operator reviewed -- no
   * re-mapping happens at execution time.
   *
   * `ifUnmodifiedSince` asks the vendor to reject an update when the record changed after
   * that instant (Salesforce honors If-Unmodified-Since); connectors without a conditional
   * write report `conditional: false` so the caller knows a residual race remained.
   */
  write(
    type: CanonicalType,
    payload: Record<string, FieldValue>,
    targetId?: string,
    options?: WriteOptions,
  ): Promise<UpsertResult & { conditional: boolean }>;

  /**
   * A stable description of the connected account (org/portal), used to bind approvals to
   * the exact account they were reviewed against. Undefined when not connected.
   */
  accountIdentity(): Promise<string | undefined>;

  /** Soft/hard delete by native id. */
  remove(type: CanonicalType, sourceId: string): Promise<UpsertResult>;

  /**
   * Maps an already verified, persisted webhook event (R12: verification, validation and
   * account routing happen at ingress, src/webhooks/) to a ChangeEvent, or null when the
   * native object is not one this workspace syncs. Runs on an initialized worker, so it may
   * use connector metadata (e.g. HubSpot custom object type ids).
   *
   * `resolveType` is consulted only when a native object is ambiguous (registered against
   * more than one canonical object); without it such events are not guessed at.
   */
  resolveWebhookEvent(
    event: NativeWebhookEvent,
    resolveType?: (nativeObjectId: string, sourceId: string) => Promise<CanonicalType | undefined>,
  ): Promise<ChangeEvent | null>;
}
