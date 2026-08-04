import crypto from 'node:crypto';
import type { CanonicalType, SystemId } from '../core/types.js';

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
  canary?: {
    type: CanonicalType;
    sourceId: string;
    previewRunId: string;
    previewRevision: number;
    executionRunId?: string;
    verifiedAt?: string;
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

export interface MigrationPlanStore {
  create(input: MigrationPlanInput): Promise<MigrationPlan>;
  list(limit?: number): Promise<MigrationPlan[]>;
  get(id: string): Promise<MigrationPlan | undefined>;
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
  finishCanary(id: string, revision: number, runId: string): Promise<boolean>;
  startExecution(id: string, revision: number): Promise<boolean>;
  finishExecution(id: string, runId: string | undefined, ok: boolean): Promise<void>;
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

  async update(id: string, input: MigrationPlanInput): Promise<MigrationPlan | undefined> {
    const plan = this.plans.get(id);
    if (!plan) return undefined;
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
    if (!plan || plan.revision !== revision) return false;
    plan.status = 'validated';
    plan.schemaHashes = { ...schemaHashes };
    plan.updatedAt = new Date().toISOString();
    return true;
  }

  async savePreview(id: string, revision: number, runId: string): Promise<boolean> {
    const plan = this.plans.get(id);
    if (!plan || plan.revision !== revision) return false;
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
    if (!plan || plan.revision !== revision) return false;
    plan.canary = {
      type,
      sourceId,
      previewRunId: runId,
      previewRevision: revision,
    };
    plan.updatedAt = new Date().toISOString();
    return true;
  }

  async finishCanary(id: string, revision: number, runId: string): Promise<boolean> {
    const plan = this.plans.get(id);
    if (!plan || plan.revision !== revision || plan.canary?.previewRevision !== revision) {
      return false;
    }
    plan.canary.executionRunId = runId;
    plan.canary.verifiedAt = new Date().toISOString();
    plan.updatedAt = plan.canary.verifiedAt;
    return true;
  }

  async startExecution(id: string, revision: number): Promise<boolean> {
    const plan = this.plans.get(id);
    if (!plan || plan.revision !== revision || plan.previewRevision !== revision) return false;
    plan.status = 'executing';
    plan.updatedAt = new Date().toISOString();
    return true;
  }

  async finishExecution(id: string, runId: string | undefined, ok: boolean): Promise<void> {
    const plan = this.plans.get(id);
    if (!plan) return;
    plan.status = ok ? 'completed' : 'failed';
    plan.executionRunId = runId;
    plan.updatedAt = new Date().toISOString();
  }
}
