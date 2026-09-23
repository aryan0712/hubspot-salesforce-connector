import type {
  CanonicalRecord,
  CanonicalType,
  ChangeEvent,
  CRMObjectDescriptor,
  CRMObjectMetadata,
  RecordPage,
  NaturalKeyQuery,
  SchemaField,
  SystemId,
  UpsertResult,
} from './types.js';
import type { SyncCondition } from './syncConfig.js';

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

  /** Soft/hard delete by native id. */
  remove(type: CanonicalType, sourceId: string): Promise<UpsertResult>;

  /**
   * Parse & verify a raw inbound webhook request into normalized ChangeEvents.
   * Returns [] if the payload is valid but irrelevant; throws on signature failure.
   *
   * `resolveType` is consulted only when a native object is ambiguous (registered against
   * more than one canonical object) -- the connector itself only knows the single-match case.
   * The caller (server.ts) supplies it bound to a live syncConfig + connector, keeping
   * connectors themselves free of a SyncConfig dependency. Omitted in tests that don't
   * exercise the shared-native-object case; ambiguous events are then dropped with a warning
   * rather than guessed at.
   */
  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
    resolveType?: (nativeObjectId: string, sourceId: string) => Promise<CanonicalType | undefined>,
  ): Promise<ChangeEvent[]>;
}
