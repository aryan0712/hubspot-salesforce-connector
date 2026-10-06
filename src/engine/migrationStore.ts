import crypto from 'node:crypto';
import type { CanonicalType, SystemId } from '../core/types.js';
import type { ReconcilePlan } from './reconciler.js';
import type { MigrationReport } from './migrationEngine.js';

export interface MigrationRunInput {
  source: SystemId;
  types: CanonicalType[];
  mode: 'preview' | 'execute';
  options: Record<string, unknown>;
  createdBy?: string;
}

export interface MigrationRunSummary extends MigrationRunInput {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  report?: MigrationReport;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface MigrationStore {
  begin(input: MigrationRunInput): Promise<string>;
  /** Records one item. Preview items carry the full frozen plan; order is preserved. */
  recordPlan(runId: string, plan: ReconcilePlan): Promise<void>;
  complete(runId: string, report: MigrationReport): Promise<void>;
  fail(runId: string, error: string): Promise<void>;
  get(runId: string): Promise<MigrationRunSummary | undefined>;
  list(limit?: number): Promise<MigrationRunSummary[]>;
  plans(runId: string, limit?: number, offset?: number): Promise<ReconcilePlan[]>;
}

export class InMemoryMigrationStore implements MigrationStore {
  private runs = new Map<string, MigrationRunSummary>();
  private items = new Map<string, ReconcilePlan[]>();

  async begin(input: MigrationRunInput): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.runs.set(id, { ...structuredClone(input), id, status: 'running', createdAt: now, startedAt: now });
    this.items.set(id, []);
    return id;
  }

  async recordPlan(runId: string, plan: ReconcilePlan): Promise<void> {
    this.items.get(runId)?.push(structuredClone(plan));
  }

  async complete(runId: string, report: MigrationReport): Promise<void> {
    const run = this.runs.get(runId);
    if (run) Object.assign(run, { status: 'completed' as const, report, finishedAt: new Date().toISOString() });
  }

  async fail(runId: string, error: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run) Object.assign(run, { status: 'failed' as const, error, finishedAt: new Date().toISOString() });
  }

  async get(runId: string): Promise<MigrationRunSummary | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  async list(limit = 50): Promise<MigrationRunSummary[]> {
    return [...this.runs.values()].slice(-limit).reverse().map((run) => structuredClone(run));
  }

  async plans(runId: string, limit = 500, offset = 0): Promise<ReconcilePlan[]> {
    return (this.items.get(runId) ?? []).slice(offset, offset + limit).map((plan) => structuredClone(plan));
  }
}
