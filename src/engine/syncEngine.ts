import os from 'node:os';
import type { CRMConnector } from '../core/connector.js';
import type { ChangeEvent, SystemId } from '../core/types.js';
import { AmbiguousNaturalKeyError, type Reconciler } from './reconciler.js';
import { logger } from '../logger.js';
import type {
  SyncEventStore,
  SyncJob,
  SyncJobStatus,
} from './syncEventStore.js';
import type { ActivityLog } from '../observability/activity.js';
import type { AssociationEngine } from './associationEngine.js';
import type { GovernanceStore } from './governanceStore.js';
import { friendlyErrorMessage } from '../core/vendorError.js';

export interface SyncEngineOptions {
  concurrency?: number;
  maxAttempts?: number;
  deletePolicy?: 'ignore' | 'cascade' | 'manual-review';
  activity?: ActivityLog;
  associations?: AssociationEngine;
  governance?: GovernanceStore;
  shouldProcess?: (event: ChangeEvent) => boolean;
}

export class SyncEngine {
  private running = false;
  private timer?: NodeJS.Timeout;
  private readonly workerId = `${os.hostname()}:${process.pid}`;

  constructor(
    private readonly connectors: Record<SystemId, CRMConnector>,
    private readonly reconciler: Reconciler,
    readonly store: SyncEventStore,
    private readonly opts: SyncEngineOptions = {},
  ) {}

  async init(): Promise<void> {
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    const recovered = await this.store.recoverStale(staleBefore);
    if (recovered) logger.warn({ recovered }, 'recovered stale sync jobs');
    this.kick();
  }

  /** Persist first, then schedule. Webhook handlers can safely acknowledge after this resolves. */
  async enqueue(events: ChangeEvent[]): Promise<string[]> {
    const ids = await this.store.enqueue(events);
    this.kick();
    return ids;
  }

  async replay(id: string): Promise<void> {
    await this.store.replay(id);
    this.kick();
  }

  async approveDelete(id: string, actorId?: string): Promise<void> {
    const job = await this.store.get(id);
    if (!job || job.event.changeType !== 'deleted' || job.status !== 'manual_review') {
      throw new Error('job is not a pending delete');
    }
    await this.reconciler.propagateDelete(job.event);
    await this.store.complete(id);
    await this.opts.governance?.completeDeletion(id, actorId);
  }

  async list(limit?: number, status?: SyncJobStatus): Promise<SyncJob[]> {
    return this.store.list(limit, status);
  }

  async stats() {
    return this.store.stats();
  }

  /** Primarily for deterministic tests and graceful shutdown. */
  async drain(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (!this.running) {
        const stats = await this.store.stats();
        if (stats.queued === 0 && stats.processing === 0) return;
        this.kick();
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('sync queue did not drain');
  }

  private kick(delay = 0): void {
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, delay);
    this.timer.unref();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const jobs = await this.store.claim(
          this.opts.concurrency ?? 4,
          this.workerId,
        );
        if (!jobs.length) break;
        await Promise.all(jobs.map((job) => this.process(job)));
      }
    } finally {
      this.running = false;
      const stats = await this.store.stats();
      if (stats.retry > 0) this.kick(1000);
    }
  }

  private async process(job: SyncJob): Promise<void> {
    try {
      const event = job.event;
      if (this.opts.shouldProcess && !this.opts.shouldProcess(event)) {
        await this.store.complete(job.id);
        this.opts.activity?.record({
          kind: 'info',
          message: `${event.system} ${event.type} event skipped by sync settings`,
        });
        return;
      }
      if (event.changeType === 'deleted') {
        const policy = this.opts.deletePolicy ?? 'manual-review';
        await this.opts.governance?.recordDeletion({
          jobId: job.id,
          event,
          targetSystem: event.system === 'salesforce' ? 'hubspot' : 'salesforce',
          policy,
        });
        if (policy === 'manual-review') {
          await this.store.manualReview(job.id, 'delete requires operator approval');
          this.opts.activity?.record({
            kind: 'delete',
            message: `${event.system} ${event.type} delete awaiting review`,
          });
          return;
        }
        if (policy === 'ignore') {
          await this.store.complete(job.id);
          return;
        }
        await this.reconciler.propagateDelete(event);
        await this.store.complete(job.id);
        return;
      }
      const connector = this.connectors[event.system];
      const record = await connector.read(event.type, event.sourceId);
      if (!record) throw new Error('record vanished before fetch');
      await this.reconciler.reconcile(record);
      await this.opts.associations?.syncRecord(record);
      await this.store.complete(job.id);
    } catch (err) {
      const targetSystem = job.event.system === 'salesforce' ? 'HubSpot' : 'Salesforce';
      const message = errorMessage(err, targetSystem);
      if (err instanceof AmbiguousNaturalKeyError) {
        await this.store.manualReview(job.id, message);
        return;
      }
      if (job.attempts >= (this.opts.maxAttempts ?? 8)) {
        await this.store.deadLetter(job.id, message);
        this.opts.activity?.record({ kind: 'error', message: `Sync dead-lettered: ${message}` });
        return;
      }
      const delay = Math.min(60_000, 500 * 2 ** Math.max(0, job.attempts - 1));
      await this.store.retry(job.id, message, new Date(Date.now() + delay).toISOString());
      logger.warn({ err, jobId: job.id, attempt: job.attempts }, 'sync event scheduled for retry');
    }
  }
}

function errorMessage(err: unknown, targetSystemLabel?: string): string {
  return friendlyErrorMessage(err, targetSystemLabel).slice(0, 2000);
}
