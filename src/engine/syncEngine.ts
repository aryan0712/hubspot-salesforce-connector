import os from 'node:os';
import crypto from 'node:crypto';
import type { CRMConnector } from '../core/connector.js';
import type { ChangeEvent, SystemId } from '../core/types.js';
import { requiresReview, type Reconciler } from './reconciler.js';
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
import type { PageCursor } from '../core/pagination.js';
import { withLogContext } from '../observability/context.js';
import { isPermanentVendorError, retryAfterMsOf } from '../core/httpPolicy.js';

/**
 * What to do with an event right now:
 *  - process: reconcile it;
 *  - defer:   the object's sync is paused -- keep the change and try again later (it is NOT
 *             lost; resuming sync processes it);
 *  - discard: the change is out of scope by design (object not enrolled, or this system is
 *             not a source for the object's direction) -- recorded and completed.
 */
export type SyncRoute = { action: 'process' } | { action: 'defer' | 'discard'; reason: string };

export interface SyncEngineOptions {
  concurrency?: number;
  maxAttempts?: number;
  deletePolicy?: 'ignore' | 'cascade' | 'manual-review';
  activity?: ActivityLog;
  associations?: AssociationEngine;
  governance?: GovernanceStore;
  /** @deprecated use route(); kept for callers that only discard. */
  shouldProcess?: (event: ChangeEvent) => boolean;
  route?: (event: ChangeEvent) => SyncRoute;
  /**
   * When true, nothing is claimed until start() is called (the worker process calls it once
   * its connectors are initialized). Otherwise the engine processes as soon as init() runs.
   */
  manualStart?: boolean;
  /** How long a processing job may go without a heartbeat before another worker takes it. */
  leaseMs?: number;
  /** Idle poll interval: picks up jobs enqueued by other processes (bounded polling). */
  pollMs?: number;
  /** How long a paused object's change waits before it is re-checked. */
  deferMs?: number;
}

/**
 * R09 -- live sync worker lifecycle.
 *  - claims are gated on readiness (connectors initialized, configuration loaded);
 *  - expired leases are recovered periodically by every worker, so a crashed replica's jobs
 *    resume without restarting anything;
 *  - long reconciles heartbeat their lease; completion is fenced on the lease token, so a
 *    stale worker cannot complete a job another worker took over;
 *  - one job per record at a time (store) plus identity locks (reconciler);
 *  - stop() stops claiming, finishes in-flight jobs, and leaves the rest queued.
 */
export class SyncEngine {
  private running = false;
  private timer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private readonly workerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 6)}`;
  private accepting: boolean;
  private stopped = false;
  private ready?: () => Promise<boolean>;
  private pumping?: Promise<void>;

  constructor(
    private readonly connectors: Record<SystemId, CRMConnector>,
    private readonly reconciler: Reconciler,
    readonly store: SyncEventStore,
    private readonly opts: SyncEngineOptions = {},
  ) {
    this.accepting = !opts.manualStart;
  }

  async init(): Promise<void> {
    await this.recover();
    this.kick();
  }

  /**
   * Starts processing (manualStart mode). `ready` is consulted before every claim: while it
   * returns false (e.g. a CRM is not connected yet) jobs stay queued instead of failing.
   */
  start(ready?: () => Promise<boolean>): void {
    this.ready = ready;
    this.accepting = true;
    this.stopped = false;
    const leaseMs = this.opts.leaseMs ?? 5 * 60_000;
    this.recoveryTimer = setInterval(() => {
      void this.recover().then((n) => n && this.kick());
    }, Math.max(1000, Math.floor(leaseMs / 2)));
    this.recoveryTimer.unref?.();
    this.kick();
  }

  /** Stops claiming new jobs and waits for in-flight jobs to finish. Queued jobs are kept. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.accepting = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.timer = undefined;
    this.recoveryTimer = undefined;
    await this.pumping;
  }

  /** Re-queues jobs whose lease expired (worker crashed or stalled). */
  async recover(): Promise<number> {
    const staleBefore = new Date(Date.now() - (this.opts.leaseMs ?? 5 * 60_000)).toISOString();
    const recovered = await this.store.recoverStale(staleBefore);
    if (recovered) logger.warn({ recovered, workerId: this.workerId }, 'recovered stale sync jobs');
    return recovered;
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
    await this.reconciler.propagateDelete(job.event, { policy: 'manual-review', approvedBy: actorId, jobId: id });
    await this.store.complete(id);
    await this.opts.governance?.completeDeletion(id, actorId);
  }

  /** Gives up on a job permanently (e.g. a genuinely invalid record) -- replaying it would
   *  never succeed, so it's removed from the "needs attention" queue without retrying. */
  async dismiss(id: string): Promise<void> {
    const job = await this.store.get(id);
    if (!job || !['dead_letter', 'manual_review', 'retry'].includes(job.status)) {
      throw new Error('job is not in a dismissable state');
    }
    await this.store.dismiss(id);
    this.opts.activity?.record({
      kind: 'info',
      message: `${job.event.system} ${job.event.type} sync dismissed: ${job.lastError ?? 'no error detail'}`,
    });
  }

  async list(limit?: number, status?: SyncJobStatus, before?: PageCursor): Promise<SyncJob[]> {
    return this.store.list(limit, status, before);
  }

  async stats() {
    return this.store.stats();
  }

  /** Primarily for deterministic tests and graceful shutdown. */
  async drain(): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
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
    if (!this.accepting || this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pumping = this.pump();
    }, delay);
    this.timer.unref();
  }

  private async pump(): Promise<void> {
    if (this.running || !this.accepting) return;
    this.running = true;
    let idle = false;
    try {
      if (this.ready && !(await this.ready().catch(() => false))) {
        idle = true; // not ready: leave everything queued, look again shortly
        return;
      }
      while (this.accepting) {
        const jobs = await this.store.claim(this.opts.concurrency ?? 4, this.workerId);
        if (!jobs.length) {
          idle = true;
          break;
        }
        await Promise.all(jobs.map((job) => this.process(job)));
      }
    } catch (err) {
      logger.error({ err }, 'sync pump failed');
      idle = true;
    } finally {
      this.running = false;
      if (!this.stopped) {
        const stats = await this.store.stats().catch(() => undefined);
        // Retries come due later; in manual-start (worker) mode also poll for jobs other
        // processes enqueued -- bounded, so an idle worker costs one query per interval.
        if (stats && stats.retry > 0) this.kick(1000);
        else if (idle && this.opts.manualStart) this.kick(this.opts.pollMs ?? 2000);
      }
    }
  }

  private process(job: SyncJob): Promise<void> {
    return withLogContext({ jobId: job.id }, () => this.processJob(job));
  }

  private async processJob(job: SyncJob): Promise<void> {
    const token = job.leaseToken;
    const leaseMs = this.opts.leaseMs ?? 5 * 60_000;
    const heartbeat = token
      ? setInterval(() => {
          void this.store.heartbeat(job.id, token).catch(() => undefined);
        }, Math.max(1000, Math.floor(leaseMs / 3)))
      : undefined;
    heartbeat?.unref?.();
    const fenced = (ok: boolean) => {
      if (!ok) logger.warn({ jobId: job.id, workerId: this.workerId }, 'sync job lease lost; result discarded');
    };
    try {
      const event = job.event;
      const route: SyncRoute = this.opts.route?.(event) ??
        (this.opts.shouldProcess && !this.opts.shouldProcess(event)
          ? { action: 'discard', reason: 'skipped by sync settings' }
          : { action: 'process' });
      if (route.action === 'defer') {
        fenced(await this.store.defer(
          job.id,
          new Date(Date.now() + (this.opts.deferMs ?? 60_000)).toISOString(),
          route.reason,
          token,
        ));
        return;
      }
      if (route.action === 'discard') {
        fenced(await this.store.complete(job.id, token));
        this.opts.activity?.record({
          kind: 'info',
          message: `${event.system} ${event.type} event not synced: ${route.reason}`,
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
          fenced(await this.store.manualReview(job.id, 'delete requires operator approval', token));
          this.opts.activity?.record({
            kind: 'delete',
            message: `${event.system} ${event.type} delete awaiting review`,
          });
          return;
        }
        if (policy === 'ignore') {
          fenced(await this.store.complete(job.id, token));
          return;
        }
        // Cascade is an explicit opt-in policy (DELETE_POLICY=cascade).
        await this.reconciler.propagateDelete(event, { policy: 'cascade', jobId: job.id });
        fenced(await this.store.complete(job.id, token));
        return;
      }
      const connector = this.connectors[event.system];
      const record = await connector.read(event.type, event.sourceId);
      if (!record) throw new Error('record vanished before fetch');
      await this.reconciler.reconcile(record);
      await this.opts.associations?.syncRecord(record);
      fenced(await this.store.complete(job.id, token));
    } catch (err) {
      const targetSystem = job.event.system === 'salesforce' ? 'HubSpot' : 'Salesforce';
      const message = errorMessage(err, targetSystem);
      // Ambiguous matches, natural-key collisions, incomplete destination searches and
      // untrustworthy timestamps need a human decision; retrying would not change them.
      if (requiresReview(err)) {
        fenced(await this.store.manualReview(job.id, message, token));
        return;
      }
      // Authorization, permission, validation and schema errors will not fix themselves:
      // surface them for an operator instead of burning retries.
      if (isPermanentVendorError(err)) {
        fenced(await this.store.manualReview(job.id, `needs attention: ${message}`, token));
        this.opts.activity?.record({ kind: 'error', message: `Sync needs attention: ${message}` });
        return;
      }
      if (job.attempts >= (this.opts.maxAttempts ?? 8)) {
        fenced(await this.store.deadLetter(job.id, message, token));
        this.opts.activity?.record({ kind: 'error', message: `Sync dead-lettered: ${message}` });
        return;
      }
      // Never retry sooner than the vendor (Retry-After) or an open circuit allows.
      const delay = Math.max(
        Math.min(60_000, 500 * 2 ** Math.max(0, job.attempts - 1)),
        Math.min(15 * 60_000, retryAfterMsOf(err) ?? 0),
      );
      fenced(await this.store.retry(job.id, message, new Date(Date.now() + delay).toISOString(), token));
      logger.warn({ err, jobId: job.id, attempt: job.attempts }, 'sync event scheduled for retry');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}

function errorMessage(err: unknown, targetSystemLabel?: string): string {
  return friendlyErrorMessage(err, targetSystemLabel).slice(0, 2000);
}
