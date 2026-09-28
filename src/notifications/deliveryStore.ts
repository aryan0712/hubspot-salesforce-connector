import crypto from 'node:crypto';
import type { PostgresDatabase } from '../db/postgres.js';

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'unconfigured' | 'abandoned';

export interface NotificationDelivery {
  id: string;
  kind: string;
  recipient: string;
  subject: string;
  body: string;
  status: DeliveryStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt: string;
  sentAt?: string;
  createdAt: string;
}

/**
 * R14 notification delivery state (per workspace). A delivery is recorded (with the issue
 * keys it covers) BEFORE sending, so an alert is never lost to a failed send and a restart
 * never re-alerts on covered issues.
 */
export interface NotificationDeliveryStore {
  /** Issue keys not yet covered by any delivery. */
  uncovered(itemKeys: string[]): Promise<string[]>;
  /** Records a delivery and the issues it covers, atomically. */
  create(input: { kind: string; recipient: string; subject: string; body: string; itemKeys: string[]; at?: Date }): Promise<NotificationDelivery>;
  /** Deliveries waiting to be (re)sent: pending, failed and due, or waiting for a transport. */
  due(now: Date, includeUnconfigured: boolean): Promise<NotificationDelivery[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, error: string, nextAttemptAt: Date | undefined): Promise<void>;
  markUnconfigured(id: string): Promise<void>;
  recent(limit?: number): Promise<NotificationDelivery[]>;
}

export class InMemoryNotificationDeliveryStore implements NotificationDeliveryStore {
  private deliveries = new Map<string, NotificationDelivery>();
  private covered = new Set<string>();

  async uncovered(itemKeys: string[]): Promise<string[]> {
    return itemKeys.filter((key) => !this.covered.has(key));
  }

  async create(input: { kind: string; recipient: string; subject: string; body: string; itemKeys: string[]; at?: Date }) {
    const now = (input.at ?? new Date()).toISOString();
    const delivery: NotificationDelivery = {
      id: crypto.randomUUID(),
      kind: input.kind,
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    };
    this.deliveries.set(delivery.id, delivery);
    for (const key of input.itemKeys) this.covered.add(key);
    return { ...delivery };
  }

  async due(now: Date, includeUnconfigured: boolean): Promise<NotificationDelivery[]> {
    return [...this.deliveries.values()]
      .filter(
        (item) =>
          (item.status === 'pending' || item.status === 'failed' || (includeUnconfigured && item.status === 'unconfigured')) &&
          Date.parse(item.nextAttemptAt) <= now.getTime(),
      )
      .map((item) => ({ ...item }));
  }

  async markSent(id: string): Promise<void> {
    const item = this.deliveries.get(id);
    if (item) Object.assign(item, { status: 'sent', sentAt: new Date().toISOString(), attempts: item.attempts + 1, lastError: undefined });
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date | undefined): Promise<void> {
    const item = this.deliveries.get(id);
    if (!item) return;
    item.attempts += 1;
    item.lastError = error;
    item.status = nextAttemptAt ? 'failed' : 'abandoned';
    if (nextAttemptAt) item.nextAttemptAt = nextAttemptAt.toISOString();
  }

  async markUnconfigured(id: string): Promise<void> {
    const item = this.deliveries.get(id);
    if (item) item.status = 'unconfigured';
  }

  async recent(limit = 50): Promise<NotificationDelivery[]> {
    return [...this.deliveries.values()].reverse().slice(0, limit).map((item) => ({ ...item }));
  }
}

interface DeliveryRow {
  id: string;
  kind: string;
  recipient: string;
  subject: string;
  body: string;
  status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date;
  sent_at: Date | null;
  created_at: Date;
}

function mapRow(row: DeliveryRow): NotificationDelivery {
  return {
    id: row.id,
    kind: row.kind,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    sentAt: row.sent_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresNotificationDeliveryStore implements NotificationDeliveryStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async uncovered(itemKeys: string[]): Promise<string[]> {
    if (!itemKeys.length) return [];
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{ item_key: string }>(
        'SELECT item_key FROM notification_alert_items WHERE tenant_id = $1 AND item_key = ANY($2::text[])',
        [this.tenantId, itemKeys],
      );
      const covered = new Set(result.rows.map((row) => row.item_key));
      return itemKeys.filter((key) => !covered.has(key));
    });
  }

  async create(input: { kind: string; recipient: string; subject: string; body: string; itemKeys: string[]; at?: Date }) {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<DeliveryRow>(
        `INSERT INTO notification_deliveries(tenant_id, kind, recipient, subject, body)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [this.tenantId, input.kind, input.recipient, input.subject, input.body],
      );
      const delivery = result.rows[0]!;
      await client.query(
        `INSERT INTO notification_alert_items(tenant_id, item_key, delivery_id)
         SELECT $1, key, $3 FROM unnest($2::text[]) AS key
         ON CONFLICT DO NOTHING`,
        [this.tenantId, input.itemKeys, delivery.id],
      );
      return mapRow(delivery);
    });
  }

  async due(now: Date, includeUnconfigured: boolean): Promise<NotificationDelivery[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<DeliveryRow>(
        `SELECT * FROM notification_deliveries
         WHERE tenant_id = $1 AND next_attempt_at <= greatest($2::timestamptz, now())
           AND (status IN ('pending', 'failed') OR ($3 AND status = 'unconfigured'))
         ORDER BY created_at LIMIT 50`,
        [this.tenantId, now.toISOString(), includeUnconfigured],
      );
      return result.rows.map(mapRow);
    });
  }

  async markSent(id: string): Promise<void> {
    await this.update(id, `status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL`, []);
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date | undefined): Promise<void> {
    await this.update(
      id,
      `attempts = attempts + 1, last_error = $3,
       status = CASE WHEN $4::timestamptz IS NULL THEN 'abandoned' ELSE 'failed' END,
       next_attempt_at = coalesce($4::timestamptz, next_attempt_at)`,
      [error.slice(0, 1000), nextAttemptAt?.toISOString() ?? null],
    );
  }

  async markUnconfigured(id: string): Promise<void> {
    await this.update(id, `status = 'unconfigured'`, []);
  }

  async recent(limit = 50): Promise<NotificationDelivery[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<DeliveryRow>(
        'SELECT * FROM notification_deliveries WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
        [this.tenantId, Math.min(limit, 200)],
      );
      return result.rows.map(mapRow);
    });
  }

  private async update(id: string, set: string, params: unknown[]): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(`UPDATE notification_deliveries SET ${set} WHERE tenant_id = $1 AND id = $2`, [
        this.tenantId,
        id,
        ...params,
      ]);
    });
  }
}
