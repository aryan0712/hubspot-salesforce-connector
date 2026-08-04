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

export interface ConnectorAssociation {
  toType: CanonicalType;
  toId: string;
  kind: string;
  label?: string;
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

  /** Stream every record of a type, page by page (for migration / initial backfill). */
  list(type: CanonicalType, cursor?: string): Promise<RecordPage>;

  /** Fetch a single record by its native id, canonicalized. Null if it no longer exists. */
  read(type: CanonicalType, sourceId: string): Promise<CanonicalRecord | null>;

  /**
   * Search the target itself before creating a record. Returning all candidates lets the
   * engine stop for human review instead of guessing when a natural key is ambiguous.
   */
  findByNaturalKey(type: CanonicalType, query: NaturalKeyQuery): Promise<CanonicalRecord[]>;

  /** Discover native fields for Mapping Studio and preflight validation. */
  describe(type: CanonicalType): Promise<SchemaField[]>;

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
   */
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): ChangeEvent[];
}
