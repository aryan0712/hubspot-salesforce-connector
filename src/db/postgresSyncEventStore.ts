import type { ChangeEvent } from '../core/types.js';
import {
  emptyStats,
  eventIdentity,
  incrementStats,
  type SyncEventStore,
  type SyncJob,
  type SyncJobStats,
  type SyncJobStatus,
} from '../engine/syncEventStore.js';
import type { PostgresDatabase } from './postgres.js';

interface JobRow {
  id: string;
  vendor_event_id: string;
  system: ChangeEvent['system'];
  object_type: ChangeEvent['type'];
  source_id: string;
  change_type: ChangeEvent['changeType'];
  occurred_at: Date;
  status: SyncJobStatus;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
}

export class PostgresSyncEventStore implements SyncEventStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async enqueue(events: ChangeEvent[]): Promise<string[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const ids: string[] = [];
      for (const event of events) {
        const vendorId = eventIdentity(event);
        const result = await client.query<{ id: string }>(
          `INSERT INTO sync_events(
             tenant_id, vendor_event_id, system, object_type, source_id,
             change_type, occurred_at, payload
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (tenant_id, vendor_event_id)
           DO UPDATE SET vendor_event_id = EXCLUDED.vendor_event_id
           RETURNING id`,
          [
            this.tenantId,
            vendorId,
            event.system,
            event.type,
            event.sourceId,
            event.changeType,
            event.occurredAt,
            JSON.stringify(event),
          ],
        );
        ids.push(result.rows[0]!.id);
      }
      return ids;
    });
  }

  async claim(limit: number, workerId: string): Promise<SyncJob[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<JobRow>(
        `WITH selected AS (
           SELECT id FROM sync_events
           WHERE tenant_id = $1
             AND status IN ('queued', 'retry')
             AND next_attempt_at <= now()
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE sync_events e
         SET status = 'processing', attempts = attempts + 1,
             locked_at = now(), locked_by = $3, updated_at = now()
         FROM selected
         WHERE e.id = selected.id
         RETURNING e.id, e.vendor_event_id, e.system, e.object_type, e.source_id,
                   e.change_type, e.occurred_at, e.status, e.attempts,
                   e.next_attempt_at, e.last_error, e.created_at`,
        [this.tenantId, limit, workerId],
      );
      return result.rows.map(toJob);
    });
  }

  async complete(id: string): Promise<void> {
    await this.setStatus(id, 'completed', null, null);
  }

  async retry(id: string, error: string, nextAttemptAt: string): Promise<void> {
    await this.setStatus(id, 'retry', error, nextAttemptAt);
  }

  async deadLetter(id: string, error: string): Promise<void> {
    await this.setStatus(id, 'dead_letter', error, null);
  }

  async manualReview(id: string, error: string): Promise<void> {
    await this.setStatus(id, 'manual_review', error, null);
  }

  async replay(id: string): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE sync_events SET status = 'queued', attempts = 0, last_error = NULL,
                next_attempt_at = now(), locked_at = NULL, locked_by = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id],
      );
    });
  }

  async dismiss(id: string): Promise<void> {
    // Unlike the other terminal states, this leaves last_error as-is -- it's the record of
    // *why* an operator decided this one wasn't worth retrying.
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE sync_events SET status = 'dismissed',
                locked_at = NULL, locked_by = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id],
      );
    });
  }

  async get(id: string): Promise<SyncJob | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<JobRow>(
        `SELECT id, vendor_event_id, system, object_type, source_id, change_type,
                occurred_at, status, attempts, next_attempt_at, last_error, created_at
         FROM sync_events WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id],
      );
      return result.rows[0] ? toJob(result.rows[0]) : undefined;
    });
  }

  async list(limit = 100, status?: SyncJobStatus): Promise<SyncJob[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const params: unknown[] = [this.tenantId, limit];
      const statusClause = status ? 'AND status = $3' : '';
      if (status) params.push(status);
      const result = await client.query<JobRow>(
        `SELECT id, vendor_event_id, system, object_type, source_id, change_type,
                occurred_at, status, attempts, next_attempt_at, last_error, created_at
         FROM sync_events WHERE tenant_id = $1 ${statusClause}
         ORDER BY created_at DESC LIMIT $2`,
        params,
      );
      return result.rows.map(toJob);
    });
  }

  async stats(): Promise<SyncJobStats> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{ status: SyncJobStatus; count: string }>(
        `SELECT status, count(*)::text AS count FROM sync_events
         WHERE tenant_id = $1 GROUP BY status`,
        [this.tenantId],
      );
      const stats = emptyStats();
      for (const row of result.rows) {
        const count = Number(row.count);
        if (row.status === 'dead_letter') stats.deadLetter = count;
        else if (row.status === 'manual_review') stats.manualReview = count;
        else stats[row.status] = count;
      }
      return stats;
    });
  }

  async recoverStale(olderThan: string): Promise<number> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE sync_events SET status = 'retry', next_attempt_at = now(),
                locked_at = NULL, locked_by = NULL, updated_at = now(),
                last_error = coalesce(last_error, 'worker lease expired')
         WHERE tenant_id = $1 AND status = 'processing' AND locked_at < $2`,
        [this.tenantId, olderThan],
      );
      return result.rowCount ?? 0;
    });
  }

  private async setStatus(
    id: string,
    status: SyncJobStatus,
    error: string | null,
    nextAttemptAt: string | null,
  ): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE sync_events SET status = $3, last_error = $4,
                next_attempt_at = coalesce($5, next_attempt_at),
                completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
                locked_at = NULL, locked_by = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id, status, error, nextAttemptAt],
      );
    });
  }
}

function toJob(row: JobRow): SyncJob {
  return {
    id: row.id,
    event: {
      eventId: row.vendor_event_id,
      system: row.system,
      type: row.object_type,
      sourceId: row.source_id,
      changeType: row.change_type,
      occurredAt: row.occurred_at.toISOString(),
    },
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}
