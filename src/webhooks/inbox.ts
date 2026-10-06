import crypto from 'node:crypto';
import type { SystemId } from '../core/types.js';
import type { NativeWebhookEvent } from './types.js';

/** A persisted, verified delivery waiting for (or done with) type resolution. */
export interface InboxEntry extends NativeWebhookEvent {
  id: string;
  status: 'pending' | 'queued' | 'discarded';
  attempts: number;
  reason?: string;
}

/** A replay-protection nonce, recorded atomically with the delivery it protects. */
export interface DeliveryNonce {
  system: SystemId;
  value: string;
  expiresAt: string;
}

/**
 * R12 webhook inbox (one per workspace). A verified delivery is persisted here before it is
 * acknowledged; redeliveries of the same vendor event collapse onto one row. Workers turn
 * rows into sync jobs later, so acknowledgement never waits on CRM reads.
 */
export interface WebhookInbox {
  /**
   * Persists a verified delivery. With a nonce, the nonce and the events are recorded in one
   * transaction: a nonce seen before returns `replayed` and stores nothing, and a failure
   * stores neither (so the sender's retry of a failed attempt is not mistaken for a replay).
   */
  accept(
    events: NativeWebhookEvent[],
    nonce?: DeliveryNonce,
  ): Promise<{ accepted: number; duplicates: number; replayed?: boolean }>;
  pendingCount(): Promise<number>;
  /** Leases due pending rows for `leaseMs` (other workers skip them meanwhile). */
  claim(limit: number, leaseMs: number): Promise<InboxEntry[]>;
  markQueued(id: string): Promise<void>;
  markDiscarded(id: string, reason: string): Promise<void>;
  /** Try again later (connector not ready, transient failure). */
  retry(id: string, delayMs: number, reason: string): Promise<void>;
}

/** Which workspace a CRM account (portal id / org id) is connected to. Global. */
export interface AccountRouteStore {
  tenantFor(system: SystemId, accountId: string): Promise<string | undefined>;
  /** Binds an account to a workspace; 'conflict' if another workspace already has it. */
  bind(system: SystemId, accountId: string, tenantId: string): Promise<'bound' | 'conflict'>;
  /** Removes this workspace's route(s) for a system (on disconnect / replacement). */
  unbind(system: SystemId, tenantId: string): Promise<void>;
}

export class InMemoryWebhookInbox implements WebhookInbox {
  private rows = new Map<string, InboxEntry & { availableAt: number }>();
  private byDelivery = new Map<string, string>();
  private nonces = new Set<string>();

  async accept(events: NativeWebhookEvent[], nonce?: DeliveryNonce) {
    if (nonce) {
      // Once used, a nonce stays used for as long as this process remembers it -- there is
      // no security reason to let it expire (the sender's freshness check is the real
      // backstop for replay windows; see verifySalesforceRequest). This mock/demo-only
      // store deliberately never sweeps by wall-clock time: doing so previously compared
      // against Date.now() while the caller's notion of "now" (used to compute
      // nonce.expiresAt) can be injected and different -- e.g. in tests -- which let an
      // identical replay through as soon as the two clocks disagreed. The PostgreSQL store
      // (the one actually used in production) sweeps by the database's own now().
      const key = `${nonce.system}:${nonce.value}`;
      if (this.nonces.has(key)) return { accepted: 0, duplicates: 0, replayed: true };
      this.nonces.add(key);
    }
    let accepted = 0;
    let duplicates = 0;
    for (const event of events) {
      const key = `${event.system}:${event.deliveryId}`;
      if (this.byDelivery.has(key)) {
        duplicates += 1;
        continue;
      }
      const id = crypto.randomUUID();
      this.rows.set(id, { ...event, id, status: 'pending', attempts: 0, availableAt: Date.now() });
      this.byDelivery.set(key, id);
      accepted += 1;
    }
    return { accepted, duplicates };
  }

  async pendingCount(): Promise<number> {
    return [...this.rows.values()].filter((row) => row.status === 'pending').length;
  }

  async claim(limit: number, leaseMs: number): Promise<InboxEntry[]> {
    const now = Date.now();
    const due = [...this.rows.values()].filter((row) => row.status === 'pending' && row.availableAt <= now).slice(0, limit);
    for (const row of due) {
      row.availableAt = now + leaseMs;
      row.attempts += 1;
    }
    return due.map(({ availableAt: _a, ...row }) => ({ ...row }));
  }

  async markQueued(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.status = 'queued';
  }

  async markDiscarded(id: string, reason: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) Object.assign(row, { status: 'discarded', reason });
  }

  async retry(id: string, delayMs: number, reason: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) Object.assign(row, { availableAt: Date.now() + delayMs, reason });
  }

  /** Test helper. */
  entries(): InboxEntry[] {
    return [...this.rows.values()].map(({ availableAt: _a, ...row }) => ({ ...row }));
  }
}

export class InMemoryAccountRouteStore implements AccountRouteStore {
  private routes = new Map<string, string>();

  async tenantFor(system: SystemId, accountId: string): Promise<string | undefined> {
    return this.routes.get(`${system}:${accountId}`);
  }

  async bind(system: SystemId, accountId: string, tenantId: string): Promise<'bound' | 'conflict'> {
    const key = `${system}:${accountId}`;
    const current = this.routes.get(key);
    if (current && current !== tenantId) return 'conflict';
    await this.unbind(system, tenantId);
    this.routes.set(key, tenantId);
    return 'bound';
  }

  async unbind(system: SystemId, tenantId: string): Promise<void> {
    for (const [key, owner] of this.routes) {
      if (owner === tenantId && key.startsWith(`${system}:`)) this.routes.delete(key);
    }
  }
}
