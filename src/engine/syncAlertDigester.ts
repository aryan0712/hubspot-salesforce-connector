import type { SyncEngine } from './syncEngine.js';
import type { SyncJob } from './syncEventStore.js';
import { SmtpEmailSender, type EmailSender } from '../notifications/emailSender.js';
import {
  InMemoryNotificationDeliveryStore,
  type NotificationDeliveryStore,
} from '../notifications/deliveryStore.js';
import type { ActivityLog } from '../observability/activity.js';
import { logger } from '../logger.js';

export interface DigesterNotificationSettings {
  enabled: boolean;
  alertEmail?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  smtpFrom?: string;
}

export interface NotificationSettingsSource {
  get(): Promise<DigesterNotificationSettings>;
}

export interface SyncAlertDigesterOptions {
  /** Persisted delivery state; in-memory by default (mock app, tests). */
  deliveries?: NotificationDeliveryStore;
  /** The mail transport for these settings, or undefined when none is configured. */
  transport?: (settings: DigesterNotificationSettings) => EmailSender | undefined;
  now?: () => Date;
  /** Send attempts before a delivery is abandoned (recorded, surfaced as an error). */
  maxAttempts?: number;
  /** Other issues to include (operational alerts); each key is alerted on once. */
  extraIssues?: () => Promise<{ key: string; line: string }[]>;
}

export interface DigestResult {
  /** True only when at least one email was actually accepted by the transport. */
  sent: boolean;
  newIssues: number;
  delivered: number;
  failed: number;
  unconfigured: number;
}

const CHECK_INTERVAL_MS = 5 * 60_000;
const MAX_EXAMPLES = 20;

/**
 * Watches for sync jobs that need a human (dead-lettered, or awaiting manual review) and
 * emails a digest when new ones show up -- rather than one email per failure.
 *
 * R14 delivery semantics:
 *  - a digest is recorded (with the issues it covers) BEFORE it is sent, so a failed send
 *    is retried with backoff instead of being lost, and a restart never re-alerts;
 *  - a delivery is marked sent only after the transport accepted it;
 *  - with no SMTP transport configured a delivery is "unconfigured" -- visible, never
 *    reported as sent -- and goes out once a transport is configured.
 */
export class SyncAlertDigester {
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private readonly deliveries: NotificationDeliveryStore;
  private readonly now: () => Date;

  constructor(
    private readonly sync: SyncEngine,
    private readonly settings: NotificationSettingsSource,
    private readonly activity?: ActivityLog,
    private readonly opts: SyncAlertDigesterOptions = {},
  ) {
    this.deliveries = opts.deliveries ?? new InMemoryNotificationDeliveryStore();
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Recent deliveries and their state, for operators. */
  recentDeliveries(limit?: number) {
    return this.deliveries.recent(limit);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.checkNow();
    } catch (err) {
      logger.error({ err }, 'sync alert digest failed');
    } finally {
      this.schedule(CHECK_INTERVAL_MS);
    }
  }

  /** Exposed for tests and for a manual "check now" trigger; safe to call anytime. */
  async checkNow(): Promise<DigestResult> {
    const settings = await this.settings.get();
    const result: DigestResult = { sent: false, newIssues: 0, delivered: 0, failed: 0, unconfigured: 0 };
    if (!settings.enabled || !settings.alertEmail) return result;

    // 1. Record a digest for issues no earlier delivery covers.
    const [deadLetters, manualReviews] = await Promise.all([
      this.sync.list(200, 'dead_letter'),
      this.sync.list(200, 'manual_review'),
    ]);
    const candidates = [...deadLetters, ...manualReviews];
    const extras = (await this.opts.extraIssues?.().catch((err) => {
      logger.warn({ err }, 'could not evaluate operational alerts for the digest');
      return [];
    })) ?? [];
    const uncovered = new Set(await this.deliveries.uncovered([...candidates.map(alertKey), ...extras.map((item) => item.key)]));
    const fresh = candidates.filter((job) => uncovered.has(alertKey(job)));
    const freshExtras = extras.filter((item) => uncovered.has(item.key));
    if (fresh.length || freshExtras.length) {
      const count = fresh.length + freshExtras.length;
      const subject = `${count} sync issue${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} attention`;
      const lines = [
        ...freshExtras.map((item) => item.line),
        ...fresh
          .slice(0, MAX_EXAMPLES)
          .map((job) => `- [${job.status}] ${job.event.system} ${job.event.type} ${job.event.sourceId}: ${job.lastError ?? 'no error detail'}`),
      ];
      if (fresh.length > MAX_EXAMPLES) lines.push(`...and ${fresh.length - MAX_EXAMPLES} more`);
      const body = `${lines.join('\n')}\n\nReview these in the Sync tab's "Conflicts & manual review" list, or the Activity tab's Sync jobs list.`;
      await this.deliveries.create({
        kind: 'sync_digest',
        recipient: settings.alertEmail,
        subject,
        body,
        itemKeys: [...fresh.map(alertKey), ...freshExtras.map((item) => item.key)],
        at: this.now(),
      });
      result.newIssues = count;
    }

    // 2. Send everything due (new, failed and due for retry, or waiting for a transport).
    const transport = (this.opts.transport ?? smtpTransport)(settings);
    for (const delivery of await this.deliveries.due(this.now(), Boolean(transport))) {
      if (!transport) {
        await this.deliveries.markUnconfigured(delivery.id);
        result.unconfigured += 1;
        this.activity?.record({
          kind: 'info',
          message: `Email alert NOT sent -- no SMTP transport configured: "${delivery.subject}" -> ${delivery.recipient}`,
        });
        continue;
      }
      try {
        await transport.send({ to: delivery.recipient, subject: delivery.subject, text: delivery.body });
        await this.deliveries.markSent(delivery.id);
        result.delivered += 1;
        this.activity?.record({ kind: 'info', message: `Email alert sent: ${delivery.subject}` });
      } catch (err) {
        const attempt = delivery.attempts + 1;
        const giveUp = attempt >= (this.opts.maxAttempts ?? 8);
        const next = giveUp ? undefined : new Date(this.now().getTime() + Math.min(6 * 60 * 60_000, 60_000 * 4 ** (attempt - 1)));
        const reason = err instanceof Error ? err.message : String(err);
        await this.deliveries.markFailed(delivery.id, reason, next);
        result.failed += 1;
        this.activity?.record({
          kind: 'error',
          message: giveUp
            ? `Email alert abandoned after ${attempt} attempts: ${reason}`
            : `Email alert failed (attempt ${attempt}), retrying at ${next!.toISOString()}: ${reason}`,
        });
        logger.warn({ err, deliveryId: delivery.id, attempt }, 'email alert delivery failed');
      }
    }
    result.sent = result.delivered > 0;
    return result;
  }
}

function smtpTransport(settings: DigesterNotificationSettings): EmailSender | undefined {
  if (settings.smtpHost && settings.smtpPort && settings.smtpUser && settings.smtpPassword && settings.smtpFrom) {
    return new SmtpEmailSender({
      host: settings.smtpHost,
      port: settings.smtpPort,
      user: settings.smtpUser,
      password: settings.smtpPassword,
      from: settings.smtpFrom,
    });
  }
  return undefined;
}

function alertKey(job: SyncJob): string {
  return `${job.id}:${job.status}:${job.attempts}`;
}
