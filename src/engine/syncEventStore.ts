import type { PageCursor } from '../core/pagination.js';
import crypto from 'node:crypto';
import type { ChangeEvent } from '../core/types.js';

export type SyncJobStatus =
  | 'queued'
  | 'processing'
  | 'retry'
  | 'completed'
  | 'dead_letter'
  | 'manual_review'
  /** Operator gave up on this one -- a permanent error (e.g. invalid data) that replaying
   *  will never fix. Terminal, like 'completed', but tracked separately so it's clear this
   *  was a deliberate "not worth retrying" call rather than a success. */
  | 'dismissed';

export interface SyncJob {
  id: string;
  event: ChangeEvent;
  status: SyncJobStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  createdAt: string;
  /** R09: identifies the current claim; completion is fenced on it. */
  leaseToken?: string;
  /** Why a queued job is waiting (e.g. its object's sync is paused). */
  deferredReason?: string;
}

export interface SyncJobStats {
  queued: number;
  processing: number;
  retry: number;
  completed: number;
  deadLetter: number;
  manualReview: number;
  dismissed: number;
}

/**
 * Job queue for live sync. R09 lease semantics:
 *  - claim() hands each job a fresh lease token and never claims a job whose record already
 *    has one processing (per-record serialization, on top of the identity locks);
 *  - complete/retry/deadLetter/manualReview/defer take the lease token and do nothing (return
 *    false) when the lease was lost -- a stale worker cannot overwrite the newer holder;
 *  - heartbeat() keeps a long reconcile's lease alive; recoverStale() re-queues expired leases
 *    and is run periodically by every worker, so recovery never needs a replica restart.
 * Operator actions (replay, dismiss, approve-delete) are not leased and pass no token.
 */
export interface SyncEventStore {
  enqueue(events: ChangeEvent[]): Promise<string[]>;
  claim(limit: number, workerId: string): Promise<SyncJob[]>;
  complete(id: string, leaseToken?: string): Promise<boolean>;
  retry(id: string, error: string, nextAttemptAt: string, leaseToken?: string): Promise<boolean>;
  deadLetter(id: string, error: string, leaseToken?: string): Promise<boolean>;
  manualReview(id: string, error: string, leaseToken?: string): Promise<boolean>;
  /** Puts a claimed job back without consuming an attempt (e.g. its object's sync is paused). */
  defer(id: string, until: string, reason: string, leaseToken?: string): Promise<boolean>;
  heartbeat(id: string, leaseToken: string): Promise<boolean>;
  replay(id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
  get(id: string): Promise<SyncJob | undefined>;
  /** Newest first; `before` continues after the last row of the previous page. */
  list(limit?: number, status?: SyncJobStatus, before?: PageCursor): Promise<SyncJob[]>;
  stats(): Promise<SyncJobStats>;
  recoverStale(olderThan: string): Promise<number>;
  /** When the oldest change still waiting to be synced was received (stale-sync alerting). */
  oldestPending(): Promise<string | undefined>;
}

interface MemoryJob extends SyncJob {
  lockedAt?: number;
  /** Which worker holds the current claim (parity with the Postgres store's locked_by). */
  lockedBy?: string;
}

export class InMemorySyncEventStore implements SyncEventStore {
  private jobs = new Map<string, MemoryJob>();
  private eventIndex = new Map<string, string>();

  async enqueue(events: ChangeEvent[]): Promise<string[]> {
    const ids: string[] = [];
    for (const event of events) {
      const vendorId = eventIdentity(event);
      const existing = this.eventIndex.get(vendorId);
      if (existing) {
        ids.push(existing);
        continue;
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.jobs.set(id, {
        id,
        event: { ...event, eventId: vendorId },
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      });
      this.eventIndex.set(vendorId, id);
      ids.push(id);
    }
    return ids;
  }

  async claim(limit: number, workerId: string): Promise<SyncJob[]> {
    const now = Date.now();
    const busy = new Set(
      [...this.jobs.values()].filter((job) => job.status === 'processing').map((job) => recordKey(job.event)),
    );
    const due = [...this.jobs.values()]
      .filter(
        (job) =>
          (job.status === 'queued' || job.status === 'retry') &&
          Date.parse(job.nextAttemptAt) <= now,
      )
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const claimed: MemoryJob[] = [];
    for (const job of due) {
      if (claimed.length >= limit) break;
      const key = recordKey(job.event);
      if (busy.has(key)) continue; // one job per record at a time
      busy.add(key);
      job.status = 'processing';
      job.attempts += 1;
      job.leaseToken = crypto.randomUUID();
      job.lockedAt = now;
      job.lockedBy = workerId;
      job.deferredReason = undefined;
      claimed.push(job);
    }
    return claimed.map(cloneJob);
  }

  async complete(id: string, leaseToken?: string): Promise<boolean> {
    return this.settle(id, leaseToken, { status: 'completed' });
  }

  async retry(id: string, error: string, nextAttemptAt: string, leaseToken?: string): Promise<boolean> {
    return this.settle(id, leaseToken, { status: 'retry', lastError: error, nextAttemptAt });
  }

  async deadLetter(id: string, error: string, leaseToken?: string): Promise<boolean> {
    return this.settle(id, leaseToken, { status: 'dead_letter', lastError: error });
  }

  async manualReview(id: string, error: string, leaseToken?: string): Promise<boolean> {
    return this.settle(id, leaseToken, { status: 'manual_review', lastError: error });
  }

  async defer(id: string, until: string, reason: string, leaseToken?: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || (leaseToken && job.leaseToken !== leaseToken)) return false;
    Object.assign(job, {
      status: 'queued' as const,
      attempts: Math.max(0, job.attempts - 1),
      nextAttemptAt: until,
      deferredReason: reason,
      leaseToken: undefined,
      lockedAt: undefined,
    });
    return true;
  }

  async heartbeat(id: string, leaseToken: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'processing' || job.leaseToken !== leaseToken) return false;
    job.lockedAt = Date.now();
    return true;
  }

  async replay(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      job.status = 'queued';
      job.attempts = 0;
      job.lastError = undefined;
      job.leaseToken = undefined;
      job.nextAttemptAt = new Date().toISOString();
    }
  }

  async dismiss(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      job.status = 'dismissed';
      job.leaseToken = undefined;
    }
  }

  async get(id: string): Promise<SyncJob | undefined> {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  async list(limit = 100, status?: SyncJobStatus, before?: PageCursor): Promise<SyncJob[]> {
    const newestFirst = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    return [...this.jobs.values()]
      .filter((job) => !status || job.status === status)
      .filter((job) => !before || newestFirst(job, before) > 0)
      .sort(newestFirst)
      .slice(0, limit)
      .map(cloneJob);
  }

  async oldestPending(): Promise<string | undefined> {
    let oldest: string | undefined;
    for (const job of this.jobs.values()) {
      if ((job.status === 'queued' || job.status === 'retry') && (!oldest || job.createdAt < oldest)) oldest = job.createdAt;
    }
    return oldest;
  }

  async stats(): Promise<SyncJobStats> {
    const result = emptyStats();
    for (const job of this.jobs.values()) incrementStats(result, job.status);
    return result;
  }

  async recoverStale(olderThan: string): Promise<number> {
    const cutoff = Date.parse(olderThan);
    let recovered = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== 'processing' || (job.lockedAt ?? 0) >= cutoff) continue;
      Object.assign(job, {
        status: 'retry' as const,
        nextAttemptAt: new Date().toISOString(),
        leaseToken: undefined,
        lockedAt: undefined,
        lastError: job.lastError ?? 'worker lease expired',
      });
      recovered += 1;
    }
    return recovered;
  }

  /** Test helper: backdate a lease as if its worker stopped heartbeating. */
  expireLease(id: string, at = 0): void {
    const job = this.jobs.get(id);
    if (job) job.lockedAt = at;
  }

  private settle(id: string, leaseToken: string | undefined, patch: Partial<MemoryJob>): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (leaseToken && (job.status !== 'processing' || job.leaseToken !== leaseToken)) return false;
    Object.assign(job, patch, { leaseToken: undefined, lockedAt: undefined });
    return true;
  }
}

function recordKey(event: ChangeEvent): string {
  return `${event.system}:${event.type}:${event.sourceId}`;
}

export function eventIdentity(event: ChangeEvent): string {
  if (event.eventId) return `${event.system}:${event.eventId}`;
  return crypto
    .createHash('sha256')
    .update(
      `${event.system}:${event.type}:${event.sourceId}:${event.changeType}:${event.occurredAt}`,
    )
    .digest('hex');
}

export function emptyStats(): SyncJobStats {
  return {
    queued: 0,
    processing: 0,
    retry: 0,
    completed: 0,
    deadLetter: 0,
    manualReview: 0,
    dismissed: 0,
  };
}

export function incrementStats(stats: SyncJobStats, status: SyncJobStatus): void {
  if (status === 'dead_letter') stats.deadLetter += 1;
  else if (status === 'manual_review') stats.manualReview += 1;
  else stats[status] += 1;
}

function cloneJob(job: SyncJob): SyncJob {
  const { lockedAt: _lockedAt, lockedBy: _lockedBy, ...rest } = job as MemoryJob;
  return { ...rest, event: { ...job.event } };
}
