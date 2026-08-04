import type { CanonicalRecord, ChangeEvent, SystemId } from '../core/types.js';

export interface ConflictRecord {
  linkId?: string;
  type: CanonicalRecord['type'];
  source: CanonicalRecord;
  target: CanonicalRecord;
  strategy: string;
  resolution: CanonicalRecord;
}

export interface GovernanceStore {
  recordConflict(conflict: ConflictRecord): Promise<void>;
  recordDeletion(input: {
    jobId: string;
    event: ChangeEvent;
    targetSystem: SystemId;
    targetId?: string;
    policy: 'ignore' | 'cascade' | 'manual-review';
  }): Promise<void>;
  completeDeletion(jobId: string, actorId?: string): Promise<void>;
}

export class InMemoryGovernanceStore implements GovernanceStore {
  readonly conflicts: ConflictRecord[] = [];
  async recordConflict(conflict: ConflictRecord): Promise<void> {
    this.conflicts.push(structuredClone(conflict));
  }
  async recordDeletion(): Promise<void> {}
  async completeDeletion(): Promise<void> {}
}
