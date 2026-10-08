import type { CRMConnector } from '../core/connector.js';
import type { CanonicalType, ChangeEvent, SystemId } from '../core/types.js';
import type { WebhookInbox } from '../webhooks/inbox.js';
import type { ActivityLog } from '../observability/activity.js';
import { logger } from '../logger.js';

export interface WebhookInboxProcessorOptions {
  /** Disambiguates native objects shared by several canonical objects (may read the CRM). */
  resolveType?: (system: SystemId, nativeObject: string, sourceId: string) => Promise<CanonicalType | undefined>;
  activity?: ActivityLog;
  batch?: number;
  pollMs?: number;
  leaseMs?: number;
  /** Attempts before an entry that keeps failing is discarded (with its reason recorded). */
  maxAttempts?: number;
}

/**
 * R12: turns persisted webhook deliveries into sync jobs on an initialized worker. Nothing
 * is silently lost: an entry whose object this workspace does not sync is discarded WITH a
 * reason, and one that cannot be resolved yet (connector not ready, transient failure) is
 * retried with backoff. Several workers may run: claims are leased.
 */
export class WebhookInboxProcessor {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private ready?: () => Promise<boolean>;
  private stopped = true;

  constructor(
    private readonly connectors: Record<SystemId, CRMConnector>,
    private readonly inbox: WebhookInbox,
    private readonly enqueue: (events: ChangeEvent[]) => Promise<unknown>,
    private readonly opts: WebhookInboxProcessorOptions = {},
  ) {}

  start(ready?: () => Promise<boolean>): void {
    this.ready = ready;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Wakes the processor now (e.g. right after a delivery was accepted). */
  kick(): void {
    if (!this.stopped && !this.running) this.schedule(0);
  }

  /** Processes everything currently due; returns how many entries were handled. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const handled = await this.runOnce();
      total += handled;
      if (!handled) return total;
    }
  }

  async runOnce(): Promise<number> {
    if (this.ready && !(await this.ready().catch(() => false))) return 0;
    const entries = await this.inbox.claim(this.opts.batch ?? 100, this.opts.leaseMs ?? 60_000);
    for (const entry of entries) {
      try {
        const resolveType = this.opts.resolveType
          ? (nativeObject: string, sourceId: string) =>
            this.opts.resolveType!(entry.system, nativeObject, sourceId)
          : undefined;
        const event = await this.connectors[entry.system].resolveWebhookEvent(entry, resolveType);
        if (!event) {
          await this.inbox.markDiscarded(entry.id, `${entry.system} ${entry.nativeObject} is not synced in this workspace`);
          continue;
        }
        await this.enqueue([event]);
        await this.inbox.markQueued(entry.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (entry.attempts >= (this.opts.maxAttempts ?? 10)) {
          await this.inbox.markDiscarded(entry.id, `gave up after ${entry.attempts} attempts: ${reason}`);
          this.opts.activity?.record({ kind: 'error', message: `Webhook event could not be processed: ${reason}` });
        } else {
          await this.inbox.retry(entry.id, Math.min(15 * 60_000, 1000 * 2 ** entry.attempts), reason);
        }
        logger.warn({ err, entryId: entry.id, attempts: entry.attempts }, 'webhook inbox entry failed');
      }
    }
    return entries.length;
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.drain()
        .catch((err) => logger.error({ err }, 'webhook inbox processing failed'))
        .then(() => undefined)
        .finally(() => {
          this.running = undefined;
          this.schedule(this.opts.pollMs ?? 2000);
        });
    }, delay);
    this.timer.unref?.();
  }
}
