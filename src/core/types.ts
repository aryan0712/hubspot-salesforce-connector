/**
 * The canonical model is the lingua franca of the whole system.
 *
 * Neither Salesforce nor HubSpot talk to each other directly. Every record is translated
 * INTO a CanonicalRecord and OUT of a CanonicalRecord. This means:
 *   - the migration engine and the real-time sync engine share the exact same mapping code,
 *   - adding a third system later is "just" one more connector + mapping table,
 *   - conflict resolution reasons about one neutral shape rather than two vendor schemas.
 */

export type SystemId = 'salesforce' | 'hubspot';

/** The object types we support end-to-end. Extend as coverage grows. */
export type CanonicalType = 'contact' | 'company' | 'deal';

/** A vendor-agnostic scalar field value. */
export type FieldValue = string | number | boolean | null;

export interface CanonicalAssociation {
  /** Relationship name in the canonical model, e.g. company or primaryContact. */
  kind: string;
  /** Canonical id when the related record is already linked. */
  canonicalId?: string;
  /** Native id and system are retained while a migration is still resolving links. */
  source?: SystemId;
  sourceId?: string;
  label?: string;
}

export interface CanonicalRecord {
  /** Our own stable id (uuid). Survives even if a record is deleted in one system. */
  canonicalId: string;
  type: CanonicalType;
  /** Neutral field name -> value. See mapping.ts for the neutral vocabulary per type. */
  fields: Record<string, FieldValue>;
  /** Relationships travel beside the record so migration and live sync share the same path. */
  associations?: CanonicalAssociation[];
  /** Provenance + change-tracking metadata, filled in by connectors. */
  meta: RecordMeta;
}

export interface RecordMeta {
  /** Which system this snapshot was read from. */
  source: SystemId;
  /** The native record id in the source system. */
  sourceId: string;
  /** Source system's last-modified timestamp (ISO 8601), used for last-write-wins. */
  modifiedAt: string;
  /** Optional soft-delete flag propagated from the source. */
  deleted?: boolean;
}

/** A single change to apply to a target system. */
export interface UpsertResult {
  system: SystemId;
  type: CanonicalType;
  targetId: string;
  operation: 'created' | 'updated' | 'skipped' | 'deleted';
}

/** Cursor-based page of records for streaming large tables during migration. */
export interface RecordPage {
  records: CanonicalRecord[];
  /** Opaque cursor for the next page, or undefined when exhausted. */
  nextCursor?: string;
}

/** Normalized inbound change from a webhook, before it is fetched + canonicalized. */
export interface ChangeEvent {
  /** Stable delivery id used for idempotency. Connectors derive one when vendors omit it. */
  eventId?: string;
  system: SystemId;
  type: CanonicalType;
  sourceId: string;
  changeType: 'created' | 'updated' | 'deleted';
  /** When the source says the change happened (ISO 8601). */
  occurredAt: string;
}

export interface NaturalKeyQuery {
  /** Canonical field name, not a vendor property name. */
  field: string;
  /** Normalized value used for comparison. */
  value: string;
  /** Stable index representation stored in the ID map. */
  key: string;
  criteria: { field: string; value: string }[];
}

export interface SchemaField {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  readOnly?: boolean;
  createable?: boolean;
  updateable?: boolean;
  unique?: boolean;
  calculated?: boolean;
  custom?: boolean;
  description?: string;
  group?: string;
  options?: { value: string; label: string }[];
}

/** Vendor-neutral object metadata used by the migration workspace. */
export interface CRMObjectDescriptor {
  /** Stable native identifier: Salesforce API name or HubSpot object type id/name. */
  id: string;
  label: string;
  pluralLabel: string;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  /** Present only when the current canonical engine supports this object end-to-end. */
  canonicalType?: CanonicalType;
}

export interface SchemaRelationship {
  name: string;
  label: string;
  targetObjectId: string;
  kind: 'parent' | 'child' | 'association';
}

export interface CRMObjectMetadata {
  object: CRMObjectDescriptor;
  fields: SchemaField[];
  relationships: SchemaRelationship[];
}
