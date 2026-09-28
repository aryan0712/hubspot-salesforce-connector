import type { SystemId } from '../core/types.js';
import type { PostgresDatabase } from './postgres.js';
import type { NativeWebhookEvent } from '../webhooks/types.js';
import type { AccountRouteStore, DeliveryNonce, InboxEntry, WebhookInbox } from '../webhooks/inbox.js';

interface InboxRow {
  id: string;
  system: SystemId;
  delivery_id: string;
  account_id: string | null;
  native_object: string;
  source_id: string;
  change_type: NativeWebhookEvent['changeType'];
  occurred_at: Date;
  status: InboxEntry['status'];
  attempts: number;
  reason: string | null;
}

/** R12 inbox and replay nonces, under tenant row-level security. */
export class PostgresWebhookInbox implements WebhookInbox {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async accept(
    events: NativeWebhookEvent[],
    nonce?: DeliveryNonce,
  ): Promise<{ accepted: number; duplicates: number; replayed?: boolean }> {
    if (!events.length && !nonce) return { accepted: 0, duplicates: 0 };
    return this.db.tenant(this.tenantId, async (client) => {
      if (nonce) {
        await client.query(`DELETE FROM webhook_nonces WHERE tenant_id = $1 AND expires_at < now()`, [this.tenantId]);
        const recorded = await client.query(
          `INSERT INTO webhook_nonces(tenant_id, system, nonce, expires_at) VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING`,
          [this.tenantId, nonce.system, nonce.value, nonce.expiresAt],
        );
        if (!recorded.rowCount) return { accepted: 0, duplicates: 0, replayed: true };
      }
      // One statement for the whole delivery keeps acknowledgement fast under bursts.
      const result = await client.query(
        `INSERT INTO webhook_inbox(
           tenant_id, system, delivery_id, account_id, native_object, source_id, change_type, occurred_at
         )
         SELECT $1, e.system, e.delivery_id, e.account_id, e.native_object, e.source_id, e.change_type, e.occurred_at
         FROM jsonb_to_recordset($2::jsonb) AS e(
           system text, delivery_id text, account_id text, native_object text,
           source_id text, change_type text, occurred_at timestamptz
         )
         ON CONFLICT (tenant_id, system, delivery_id) DO NOTHING`,
        [
          this.tenantId,
          JSON.stringify(
            events.map((event) => ({
              system: event.system,
              delivery_id: event.deliveryId,
              account_id: event.accountId ?? null,
              native_object: event.nativeObject,
              source_id: event.sourceId,
              change_type: event.changeType,
              occurred_at: event.occurredAt,
            })),
          ),
        ],
      );
      const accepted = result.rowCount ?? 0;
      return { accepted, duplicates: events.length - accepted };
    });
  }

  async pendingCount(): Promise<number> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM webhook_inbox WHERE tenant_id = $1 AND status = 'pending'`,
        [this.tenantId],
      );
      return result.rows[0]!.n;
    });
  }

  async claim(limit: number, leaseMs: number): Promise<InboxEntry[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<InboxRow>(
        `UPDATE webhook_inbox SET available_at = now() + ($3::int * interval '1 millisecond'),
                attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM webhook_inbox
           WHERE tenant_id = $1 AND status = 'pending' AND available_at <= now()
           ORDER BY available_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [this.tenantId, limit, leaseMs],
      );
      return result.rows.map((row) => ({
        id: row.id,
        system: row.system,
        deliveryId: row.delivery_id,
        accountId: row.account_id ?? undefined,
        nativeObject: row.native_object,
        sourceId: row.source_id,
        changeType: row.change_type,
        occurredAt: row.occurred_at.toISOString(),
        status: row.status,
        attempts: row.attempts,
        reason: row.reason ?? undefined,
      }));
    });
  }

  async markQueued(id: string): Promise<void> {
    await this.update(id, `status = 'queued', processed_at = now(), reason = NULL`, []);
  }

  async markDiscarded(id: string, reason: string): Promise<void> {
    await this.update(id, `status = 'discarded', processed_at = now(), reason = $3`, [reason.slice(0, 500)]);
  }

  async retry(id: string, delayMs: number, reason: string): Promise<void> {
    await this.update(id, `available_at = now() + ($3::int * interval '1 millisecond'), reason = $4`, [
      delayMs,
      reason.slice(0, 500),
    ]);
  }

  private async update(id: string, set: string, params: unknown[]): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(`UPDATE webhook_inbox SET ${set} WHERE tenant_id = $1 AND id = $2`, [
        this.tenantId,
        id,
        ...params,
      ]);
    });
  }
}

export class PostgresAccountRouteStore implements AccountRouteStore {
  constructor(private readonly db: PostgresDatabase) {}

  async tenantFor(system: SystemId, accountId: string): Promise<string | undefined> {
    const result = await this.db.pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM account_routes WHERE system = $1 AND account_id = $2',
      [system, accountId],
    );
    return result.rows[0]?.tenant_id;
  }

  async bind(system: SystemId, accountId: string, tenantId: string): Promise<'bound' | 'conflict'> {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO account_routes(system, account_id, tenant_id) VALUES ($1,$2,$3)
         ON CONFLICT (system, account_id) DO NOTHING`,
        [system, accountId, tenantId],
      );
      if (!inserted.rowCount) {
        const owner = await client.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM account_routes WHERE system = $1 AND account_id = $2',
          [system, accountId],
        );
        if (owner.rows[0]?.tenant_id !== tenantId) {
          await client.query('ROLLBACK');
          return 'conflict';
        }
      }
      // A workspace has one connection per system: drop its routes to other accounts.
      await client.query('DELETE FROM account_routes WHERE system = $1 AND tenant_id = $2 AND account_id <> $3', [
        system,
        tenantId,
        accountId,
      ]);
      await client.query('COMMIT');
      return 'bound';
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async unbind(system: SystemId, tenantId: string): Promise<void> {
    await this.db.pool.query('DELETE FROM account_routes WHERE system = $1 AND tenant_id = $2', [system, tenantId]);
  }
}
