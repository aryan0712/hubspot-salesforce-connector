import crypto from 'node:crypto';
import type { CanonicalType, FieldValue, SystemId } from '../core/types.js';

export type MigrationPlanStatus =
  | 'draft'
  | 'validated'
  | 'previewed'
  | 'executing'
  | 'completed'
  | 'failed';

export interface MigrationPlanConfig {
  objectSettings?: Partial<Record<CanonicalType, {
    included?: boolean;
  }>>;
}

/** One record's expected-versus-actual evidence from a canary read-back. */
export interface CanaryItemEvidence {
  type: CanonicalType;
  sourceId: string;
  action: string;
  targetId?: string;
  /** True when the canary actually wrote this record (not skipped/linked only). */
  wrote: boolean;
  expected: Record<string, FieldValue>;
  actual?: Record<string, FieldValue>;
  mismatches: { field: string; expected: FieldValue; actual: FieldValue | undefined }[];
  error?: string;
}

/** R04: what a canary proved, bound to the configuration and accounts it ran under. */
export interface CanaryVerification {
  passed: boolean;
  reasons: string[];
  checkedAt: string;
  previewRunId: string;
  executionRunId?: string;
  configFingerprint: string;
  accounts: Partial<Record<SystemId, string>>;
  /** Objects whose mapping was exercised by a representative write. */
  testedTypes: CanonicalType[];
  representativeWrite: boolean;
  items: CanaryItemEvidence[];
}

export interface MigrationPlan {
  id: string;
  name: string;
  source: SystemId;
  types: CanonicalType[];
  limitPerType?: number;
  config: MigrationPlanConfig;
  status: MigrationPlanStatus;
  revision: number;
  schemaHashes: Record<string, string>;
  previewRunId?: string;
  previewRevision?: number;
  executionRunId?: string;
  /** The execution currently holding this plan (R03 fencing). */
  activeExecutionId?: string;
  canary?: {
    type: CanonicalType;
    sourceId: string;
    previewRunId: string;
    previewRevision: number;
    executionRunId?: string;
    verifiedAt?: string;
    verification?: CanaryVerification;
  };
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationPlanInput {
  name: string;
  source: SystemId;
  types: CanonicalType[];
  limitPerType?: number;
  config?: MigrationPlanConfig;
  createdBy?: string;
}

/** A plan transition was refused because of the plan's current state. */
export class PlanStateError extends Error {
  constructor(readonly code: 'plan_executing', message: string) {
    super(message);
    this.name = 'PlanStateError';
  }
}

export interface MigrationPlanStore {
  create(input: MigrationPlanInput): Promise<MigrationPlan>;
  list(limit?: number): Promise<MigrationPlan[]>;
  get(id: string): Promise<MigrationPlan | undefined>;
  /** Edits bump the revision and clear approvals; refused (PlanStateError) while executing. */
  update(id: string, input: MigrationPlanInput): Promise<MigrationPlan | undefined>;
  saveValidation(id: string, revision: number, schemaHashes: Record<string, string>): Promise<boolean>;
  savePreview(id: string, revision: number, runId: string): Promise<boolean>;
  saveCanaryPreview(
    id: string,
    revision: number,
    type: CanonicalType,
    sourceId: string,
    runId: string,
  ): Promise<boolean>;
  /**
   * Records the canary's verification evidence for the exact test preview it executed.
   * The canary counts as verified (unlocking a full run) only when `verification.passed`.
   */
  finishCanary(
    id: string,
    revision: number,
    previewRunId: string,
    runId: string,
    verification: CanaryVerification,
  ): Promise<boolean>;
  /**
   * Clears previews and canaries of non-executing plans covering any of these objects --
   * a mapping change means what they approved or tested no longer describes the writes.
   */
  invalidateApprovals(types: CanonicalType[]): Promise<number>;
}

export class InMemoryMigrationPlanStore implements MigrationPlanStore {
  private plans = new Map<string, MigrationPlan>();

  async create(input: MigrationPlanInput): Promise<MigrationPlan> {
    const now = new Date().toISOString();
    const plan: MigrationPlan = {
      id: crypto.randomUUID(),
      name: input.name,
      source: input.source,
      types: [...input.types],
      limitPerType: input.limitPerType,
      config: structuredClone(input.config ?? {}),
      status: 'draft',
      revision: 1,
      schemaHashes: {},
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.plans.set(plan.id, plan);
    return structuredClone(plan);
  }

  async list(limit = 50): Promise<MigrationPlan[]> {
    return [...this.plans.values()].slice(-limit).reverse().map((plan) => structuredClone(plan));
  }

  async get(id: string): Promise<MigrationPlan | undefined> {
    const plan = this.plans.get(id);
    return plan ? structuredClone(plan) : undefined;
  }

  /** Synchronous read for the in-memory execution claim (no interleaving). */
  peek(id: string): MigrationPlan | undefined {
    return this.plans.get(id);
  }

  holdForExecution(id: string, executionId: string, full: boolean): void {
    const plan = this.plans.get(id);
    if (!plan) return;
    plan.activeExecutionId = executionId;
    if (full) plan.status = 'executing';
    plan.updatedAt = new Date().toISOString();
  }

  releaseExecution(
    id: string,
    executionId: string,
    finalStatus: 'completed' | 'failed' | undefined,
    executionRunId?: string,
  ): void {
    const plan = this.plans.get(id);
    if (!plan || plan.activeExecutionId !== executionId) return;
    plan.activeExecutionId = undefined;
    if (finalStatus) {
      plan.status = finalStatus;
      plan.executionRunId = executionRunId;
    }
    plan.updatedAt = new Date().toISOString();
  }

  async update(id: string, input: MigrationPlanInput): Promise<MigrationPlan | undefined> {
    const plan = this.plans.get(id);
    if (!plan) return undefined;
    if (plan.status === 'executing' || plan.activeExecutionId) {
      throw new PlanStateError('plan_executing', 'a plan cannot be edited while it is executing');
    }
    Object.assign(plan, {
      name: input.name,
      source: input.source,
      types: [...input.types],
      limitPerType: input.limitPerType,
      config: structuredClone(input.config ?? {}),
      status: 'draft' as const,
      revision: plan.revision + 1,
      schemaHashes: {},
      previewRunId: undefined,
      previewRevision: undefined,
      executionRunId: undefined,
      canary: undefined,
      updatedAt: new Date().toISOString(),
    });
    return structuredClone(plan);
  }

  async saveValidation(
    id: string,
    revision: number,
    schemaHashes: Record<string, string>,
  ): Promise<boolean> {
    const plan = this.plans.get(id);
    if (!plan || plan.revision !== revision || plan.status === 'executing') return false;
    plan.status = plan.status === 'previewed' ? 'previewed' : 'validated';
    plan.schemaHashes = { ...schemaHashes };
    plan.updatedAt = new Date().toISOString();
    return true;
  }

  async savePreview(id: string, revision: number, runId: string): Promise<boolean> {
    const plan = this.plans.get(id);
    if (!plan || plan.revision !== revision || plan.status === 'executing') return false;
    plan.status = 'previewed';
    plan.previewRunId = runId;
    plan.previewRevision = revision;
    plan.updatedAt = new Date().toISOString();
    return true;
  }

  async saveCanaryPreview(
    id: string,
    revision: number,
    type: CanonicalType,
    sourceId: string,
    runId: string,
  ): Promise<boolean> {
    const plan = this.plans.get(id);
    if (!plan || plan.revision !== revision || plan.status === 'executing' || plan.activeExecutionId) {
      return false;
    }
    plan.canary = {
      type,
      sourceId,
      previewRunId: runId,
      previewRevision: revision,
      // Keep the last verification of this revision: passing tests of other objects still
      // count toward "every selected object tested" once this new test passes.
      verification: plan.canary?.previewRevision === revision ? plan.canary.verification : undefined,
    };
    plan.updatedAt = new Date().toISOString();
    return true;
  }

  async finishCanary(
    id: string,
    revision: number,
    previewRunId: string,
    runId: string,
    verification: CanaryVerification,
  ): Promise<boolean> {
    const plan = this.plans.get(id);
    if (
      !plan ||
      plan.revision !== revision ||
      plan.canary?.previewRevision !== revision ||
      plan.canary.previewRunId !== previewRunId
    ) {
      return false;
    }
    plan.canary.executionRunId = runId;
    plan.canary.verification = structuredClone(verification);
    plan.canary.verifiedAt = verification.passed ? verification.checkedAt : undefined;
    plan.updatedAt = new Date().toISOString();
    return true;
  }

  async invalidateApprovals(types: CanonicalType[]): Promise<number> {
    let count = 0;
    for (const plan of this.plans.values()) {
      if (plan.status === 'executing' || plan.activeExecutionId) continue;
      if (!plan.types.some((type) => types.includes(type))) continue;
      if (!plan.previewRunId && !plan.canary) continue;
      plan.previewRunId = undefined;
      plan.previewRevision = undefined;
      plan.canary = undefined;
      if (plan.status === 'previewed' || plan.status === 'validated') plan.status = 'draft';
      plan.updatedAt = new Date().toISOString();
      count += 1;
    }
    return count;
  }
}
