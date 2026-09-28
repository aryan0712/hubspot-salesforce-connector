import type { PageCursor } from '../core/pagination.js';
import type { ChangeEvent } from '../core/types.js';
import {
  emptyStats,
  eventIdentity,
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
  lease_token: string | null;
  deferred_reason: string | null;
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
      // One job per record at a time: skip records that already have a job processing, and
      // take at most one due job per record in this batch. Each claim gets a fresh lease token.
      const result = await client.query<JobRow>(
        `WITH due AS (
           SELECT e.id, e.created_at,
                  row_number() OVER (PARTITION BY e.system, e.object_type, e.source_id ORDER BY e.created_at) AS nth
           FROM sync_events e
           WHERE e.tenant_id = $1
             AND e.status IN ('queued', 'retry')
             AND e.next_attempt_at <= now()
             AND NOT EXISTS (
               SELECT 1 FROM sync_events p
               WHERE p.tenant_id = e.tenant_id AND p.status = 'processing'
                 AND p.system = e.system AND p.object_type = e.object_type AND p.source_id = e.source_id
             )
         ),
         selected AS (
           SELECT s.id FROM sync_events s
           JOIN due ON due.id = s.id AND due.nth = 1
           WHERE s.tenant_id = $1
           ORDER BY due.created_at
           FOR UPDATE OF s SKIP LOCKED
           LIMIT $2
         )
         UPDATE sync_events e
         SET status = 'processing', attempts = attempts + 1,
             locked_at = now(), locked_by = $3, lease_token = gen_random_uuid()::text,
             deferred_reason = NULL, updated_at = now()
         FROM selected
         WHERE e.id = selected.id
         RETURNING e.id, e.vendor_event_id, e.system, e.object_type, e.source_id,
                   e.change_type, e.occurred_at, e.status, e.attempts,
                   e.next_attempt_at, e.last_error, e.created_at, e.lease_token, e.deferred_reason`,
        [this.tenantId, limit, workerId],
      );
      return result.rows.map(toJob);
    });
  }

  async complete(id: string, leaseToken?: string): Promise<boolean> {
    return this.setStatus(id, 'completed', null, null, leaseToken);
  }

  async retry(id: string, error: string, nextAttemptAt: string, leaseToken?: string): Promise<boolean> {
    return this.setStatus(id, 'retry', error, nextAttemptAt, leaseToken);
  }

  async deadLetter(id: string, error: string, leaseToken?: string): Promise<boolean> {
    return this.setStatus(id, 'dead_letter', error, null, leaseToken);
  }

  async manualReview(id: string, error: string, leaseToken?: string): Promise<boolean> {
    return this.setStatus(id, 'manual_review', error, null, leaseToken);
  }

  async defer(id: string, until: string, reason: string, leaseToken?: string): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE sync_events SET status = 'queued', attempts = greatest(attempts - 1, 0),
                next_attempt_at = $3, deferred_reason = $4,
                locked_at = NULL, locked_by = NULL, lease_token = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND ($5::text IS NULL OR lease_token = $5)`,
        [this.tenantId, id, until, reason.slice(0, 500), leaseToken ?? null],
      );
      return Boolean(result.rowCount);
    });
  }

  async heartbeat(id: string, leaseToken: string): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE sync_events SET locked_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'processing' AND lease_token = $3`,
        [this.tenantId, id, leaseToken],
      );
      return Boolean(result.rowCount);
    });
  }

  async replay(id: string): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE sync_events SET status = 'queued', attempts = 0, last_error = NULL,
                next_attempt_at = now(), locked_at = NULL, locked_by = NULL, lease_token = NULL,
                updated_at = now()
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
                locked_at = NULL, locked_by = NULL, lease_token = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id],
      );
    });
  }

  async get(id: string): Promise<SyncJob | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<JobRow>(
        `SELECT id, vendor_event_id, system, object_type, source_id, change_type,
                occurred_at, status, attempts, next_attempt_at, last_error, created_at,
                lease_token, deferred_reason
         FROM sync_events WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, id],
      );
      return result.rows[0] ? toJob(result.rows[0]) : undefined;
    });
  }

  async list(limit = 100, status?: SyncJobStatus, before?: PageCursor): Promise<SyncJob[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const params: unknown[] = [this.tenantId, limit];
      let statusClause = '';
      if (status) {
        params.push(status);
        statusClause += ` AND status = ${params.length}`;
      }
      if (before) {
        params.push(before.createdAt, before.id);
        statusClause += ` AND (created_at, id) < (${params.length - 1}::timestamptz, ${params.length}::uuid)`;
      }
      const result = await client.query<JobRow>(
        `SELECT id, vendor_event_id, system, object_type, source_id, change_type,
                occurred_at, status, attempts, next_attempt_at, last_error, created_at,
                lease_token, deferred_reason
         FROM sync_events WHERE tenant_id = $1 ${statusClause}
         ORDER BY created_at DESC, id DESC LIMIT $2`,
        params,
      );
      return result.rows.map(toJob);
    });
  }

  async oldestPending(): Promise<string | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{ oldest: Date | null }>(
        `SELECT min(created_at) AS oldest FROM sync_events
         WHERE tenant_id = $1 AND status IN ('queued', 'retry')`,
        [this.tenantId],
      );
      return result.rows[0]?.oldest?.toISOString();
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
                locked_at = NULL, locked_by = NULL, lease_token = NULL, updated_at = now(),
                last_error = coalesce(last_error, 'worker lease expired')
         WHERE tenant_id = $1 AND status = 'processing' AND locked_at < $2`,
        [this.tenantId, olderThan],
      );
      return result.rowCount ?? 0;
    });
  }

  /** Fenced when a lease token is given: a stale worker's update matches no row. */
  private async setStatus(
    id: string,
    status: SyncJobStatus,
    error: string | null,
    nextAttemptAt: string | null,
    leaseToken?: string,
  ): Promise<boolean> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE sync_events SET status = $3, last_error = $4,
                next_attempt_at = coalesce($5, next_attempt_at),
                completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
                locked_at = NULL, locked_by = NULL, lease_token = NULL, updated_at = now()
         WHERE tenant_id = $1 AND id = $2
           AND ($6::text IS NULL OR (status = 'processing' AND lease_token = $6))`,
        [this.tenantId, id, status, error, nextAttemptAt, leaseToken ?? null],
      );
      return Boolean(result.rowCount);
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
    leaseToken: row.lease_token ?? undefined,
    deferredReason: row.deferred_reason ?? undefined,
  };
}
