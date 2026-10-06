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

export interface SyncEventStore {
  enqueue(events: ChangeEvent[]): Promise<string[]>;
  claim(limit: number, workerId: string): Promise<SyncJob[]>;
  complete(id: string): Promise<void>;
  retry(id: string, error: string, nextAttemptAt: string): Promise<void>;
  deadLetter(id: string, error: string): Promise<void>;
  manualReview(id: string, error: string): Promise<void>;
  replay(id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
  get(id: string): Promise<SyncJob | undefined>;
  list(limit?: number, status?: SyncJobStatus): Promise<SyncJob[]>;
  stats(): Promise<SyncJobStats>;
  recoverStale(olderThan: string): Promise<number>;
}

export class InMemorySyncEventStore implements SyncEventStore {
  private jobs = new Map<string, SyncJob>();
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

  async claim(limit: number): Promise<SyncJob[]> {
    const now = Date.now();
    const jobs = [...this.jobs.values()]
      .filter(
        (job) =>
          (job.status === 'queued' || job.status === 'retry') &&
          Date.parse(job.nextAttemptAt) <= now,
      )
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(0, limit);
    for (const job of jobs) {
      job.status = 'processing';
      job.attempts += 1;
    }
    return jobs.map(cloneJob);
  }

  async complete(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) job.status = 'completed';
  }

  async retry(id: string, error: string, nextAttemptAt: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) Object.assign(job, { status: 'retry' as const, lastError: error, nextAttemptAt });
  }

  async deadLetter(id: string, error: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) Object.assign(job, { status: 'dead_letter' as const, lastError: error });
  }

  async manualReview(id: string, error: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) Object.assign(job, { status: 'manual_review' as const, lastError: error });
  }

  async replay(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      job.status = 'queued';
      job.attempts = 0;
      job.lastError = undefined;
      job.nextAttemptAt = new Date().toISOString();
    }
  }

  async dismiss(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) job.status = 'dismissed';
  }

  async get(id: string): Promise<SyncJob | undefined> {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  async list(limit = 100, status?: SyncJobStatus): Promise<SyncJob[]> {
    return [...this.jobs.values()]
      .filter((job) => !status || job.status === status)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map(cloneJob);
  }

  async stats(): Promise<SyncJobStats> {
    const result = emptyStats();
    for (const job of this.jobs.values()) incrementStats(result, job.status);
    return result;
  }

  async recoverStale(): Promise<number> {
    return 0;
  }
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
  return { ...job, event: { ...job.event } };
}
