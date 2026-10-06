import type { SyncEngine } from './syncEngine.js';
import type { SyncJob } from './syncEventStore.js';
import { LoggingEmailSender, SmtpEmailSender, type EmailSender } from '../notifications/emailSender.js';
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

const CHECK_INTERVAL_MS = 5 * 60_000;
const MAX_EXAMPLES = 20;

/**
 * Watches for sync jobs that need a human (dead-lettered, or awaiting manual review) and
 * emails a digest when new ones show up -- rather than one email per failure, which would
 * flood an inbox the moment several records fail in a burst (a bad mapping change, an
 * expired token, etc. can dead-letter dozens of jobs within seconds of each other).
 *
 * Which EmailSender is used is decided fresh on every check from the current settings (SMTP
 * once configured, otherwise a logging stand-in) rather than fixed at construction, since
 * settings can be added/changed at runtime from the Settings tab without a restart.
 */
export class SyncAlertDigester {
  private timer?: NodeJS.Timeout;
  private stopped = true;
  // (job id + status + attempts) already alerted on -- lets a job that fails again after a
  // replay (same id, higher attempt count) trigger a fresh alert instead of being silently
  // deduped forever.
  private readonly alerted = new Set<string>();

  constructor(
    private readonly sync: SyncEngine,
    private readonly settings: NotificationSettingsSource,
    private readonly activity?: ActivityLog,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
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
  async checkNow(): Promise<{ sent: boolean; newIssues: number }> {
    const settings = await this.settings.get();
    if (!settings.enabled || !settings.alertEmail) return { sent: false, newIssues: 0 };

    const [deadLetters, manualReviews] = await Promise.all([
      this.sync.list(200, 'dead_letter'),
      this.sync.list(200, 'manual_review'),
    ]);
    const candidates = [...deadLetters, ...manualReviews];
    const fresh = candidates.filter((job) => !this.alerted.has(alertKey(job)));
    if (!fresh.length) return { sent: false, newIssues: 0 };

    for (const job of fresh) this.alerted.add(alertKey(job));

    const subject = `${fresh.length} sync issue${fresh.length === 1 ? '' : 's'} need${fresh.length === 1 ? 's' : ''} attention`;
    const lines = fresh
      .slice(0, MAX_EXAMPLES)
      .map((job) => `- [${job.status}] ${job.event.system} ${job.event.type} ${job.event.sourceId}: ${job.lastError ?? 'no error detail'}`);
    if (fresh.length > MAX_EXAMPLES) lines.push(`...and ${fresh.length - MAX_EXAMPLES} more`);
    const text = `${lines.join('\n')}\n\nReview these in the Sync tab's "Conflicts & manual review" list, or the Activity tab's Sync jobs list.`;

    const sender = this.senderFor(settings);
    await sender.send({ to: settings.alertEmail, subject, text });
    this.activity?.record({ kind: 'info', message: `Email alert sent: ${subject}` });
    return { sent: true, newIssues: fresh.length };
  }

  private senderFor(settings: DigesterNotificationSettings): EmailSender {
    if (settings.smtpHost && settings.smtpPort && settings.smtpUser && settings.smtpPassword && settings.smtpFrom) {
      return new SmtpEmailSender({
        host: settings.smtpHost,
        port: settings.smtpPort,
        user: settings.smtpUser,
        password: settings.smtpPassword,
        from: settings.smtpFrom,
      });
    }
    return new LoggingEmailSender(this.activity);
  }
}

function alertKey(job: SyncJob): string {
  return `${job.id}:${job.status}:${job.attempts}`;
}
