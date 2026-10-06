import crypto from 'node:crypto';
import type { CanonicalRecord, ChangeEvent, FieldValue, SystemId } from '../core/types.js';

export interface ConflictRecord {
  linkId?: string;
  type: CanonicalRecord['type'];
  source: CanonicalRecord;
  target: CanonicalRecord;
  strategy: string;
  resolution: CanonicalRecord;
  /** Field-level decision: which side won and which destination values were kept. */
  decision?: {
    winner: SystemId | 'merged';
    keptDestinationFields: string[];
    fieldOwners?: Record<string, SystemId>;
  };
}

/** A conflict as stored for inspection (R10). */
export interface StoredConflict extends ConflictRecord {
  id: string;
  status: 'open' | 'resolved' | 'ignored';
  resolutionSource: 'automatic' | 'manual';
  resolvedBy?: string;
  createdAt: string;
}

/**
 * R10: an approved (or policy-driven) delete leaves a tombstone on the link. While it is
 * active, delayed events, replays and later migrations must not recreate the record; an
 * explicit, audited restore lifts it. Approval provenance is kept.
 */
export interface Tombstone {
  id: string;
  linkId: string;
  type: string;
  deletedSystem: SystemId;
  deletedSourceId: string;
  targetSystem: SystemId;
  targetId?: string;
  policy: 'ignore' | 'cascade' | 'manual-review';
  approvedBy?: string;
  syncEventId?: string;
  createdAt: string;
  restoredAt?: string;
  restoredBy?: string;
}

export type NewTombstone = Omit<Tombstone, 'id' | 'createdAt' | 'restoredAt' | 'restoredBy'>;

export interface GovernanceStore {
  recordConflict(conflict: ConflictRecord): Promise<void>;
  listConflicts(limit?: number): Promise<StoredConflict[]>;
  getConflict(id: string): Promise<StoredConflict | undefined>;
  /** Marks a conflict as deliberately resolved by an operator. */
  resolveConflict(id: string, actorId: string | undefined, winner: SystemId): Promise<boolean>;
  recordDeletion(input: {
    jobId: string;
    event: ChangeEvent;
    targetSystem: SystemId;
    targetId?: string;
    policy: 'ignore' | 'cascade' | 'manual-review';
  }): Promise<void>;
  completeDeletion(jobId: string, actorId?: string): Promise<void>;
  tombstone(input: NewTombstone): Promise<void>;
  activeTombstone(linkId: string): Promise<Tombstone | undefined>;
  /** The most recent tombstone of a link, active or restored. */
  latestTombstone(linkId: string): Promise<Tombstone | undefined>;
  restoreTombstone(linkId: string, actorId?: string): Promise<boolean>;
  listTombstones(limit?: number): Promise<Tombstone[]>;
}

export class InMemoryGovernanceStore implements GovernanceStore {
  readonly conflicts: StoredConflict[] = [];
  readonly tombstones: Tombstone[] = [];

  async recordConflict(conflict: ConflictRecord): Promise<void> {
    this.conflicts.push({
      ...structuredClone(conflict),
      id: crypto.randomUUID(),
      status: 'resolved',
      resolutionSource: 'automatic',
      createdAt: new Date().toISOString(),
    });
  }

  async listConflicts(limit = 100): Promise<StoredConflict[]> {
    return this.conflicts.slice(-limit).reverse().map((conflict) => structuredClone(conflict));
  }

  async getConflict(id: string): Promise<StoredConflict | undefined> {
    const conflict = this.conflicts.find((item) => item.id === id);
    return conflict ? structuredClone(conflict) : undefined;
  }

  async resolveConflict(id: string, actorId: string | undefined, winner: SystemId): Promise<boolean> {
    const conflict = this.conflicts.find((item) => item.id === id);
    if (!conflict) return false;
    conflict.status = 'resolved';
    conflict.resolutionSource = 'manual';
    conflict.resolvedBy = actorId;
    conflict.decision = { ...(conflict.decision ?? { keptDestinationFields: [] }), winner };
    return true;
  }

  async recordDeletion(): Promise<void> {}
  async completeDeletion(): Promise<void> {}

  async tombstone(input: NewTombstone): Promise<void> {
    if (this.tombstones.some((item) => item.linkId === input.linkId && !item.restoredAt)) return;
    this.tombstones.push({ ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
  }

  async activeTombstone(linkId: string): Promise<Tombstone | undefined> {
    const tombstone = this.tombstones.find((item) => item.linkId === linkId && !item.restoredAt);
    return tombstone ? { ...tombstone } : undefined;
  }

  async latestTombstone(linkId: string): Promise<Tombstone | undefined> {
    const tombstone = [...this.tombstones].reverse().find((item) => item.linkId === linkId);
    return tombstone ? { ...tombstone } : undefined;
  }

  async restoreTombstone(linkId: string, actorId?: string): Promise<boolean> {
    const tombstone = this.tombstones.find((item) => item.linkId === linkId && !item.restoredAt);
    if (!tombstone) return false;
    tombstone.restoredAt = new Date().toISOString();
    tombstone.restoredBy = actorId;
    return true;
  }

  async listTombstones(limit = 100): Promise<Tombstone[]> {
    return this.tombstones.slice(-limit).reverse().map((item) => ({ ...item }));
  }
}

/** Shape used for field-level conflict display (values kept vs written). */
export type FieldDecision = { field: string; source: FieldValue | undefined; destination: FieldValue | undefined; kept: 'source' | 'destination' };
