import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyncAlertDigester, type DigesterNotificationSettings } from '../src/engine/syncAlertDigester.js';
import {
  InMemoryNotificationDeliveryStore,
  PostgresNotificationDeliveryStore,
  type NotificationDeliveryStore,
} from '../src/notifications/deliveryStore.js';
import type { EmailMessage, EmailSender } from '../src/notifications/emailSender.js';
import type { SyncEngine } from '../src/engine/syncEngine.js';
import type { SyncJob } from '../src/engine/syncEventStore.js';
import { ActivityLog } from '../src/observability/activity.js';
import { startIsolatedPostgres, type IsolatedPostgres } from './helpers/postgres.js';

/** R14: an alert is only reported as sent after the transport accepted it. */

const settings: DigesterNotificationSettings = { enabled: true, alertEmail: 'ops@example.com' };

function job(id: string): SyncJob {
  return {
    id,
    event: { system: 'hubspot', type: 'contact', sourceId: id, changeType: 'updated', occurredAt: new Date().toISOString() },
    status: 'dead_letter',
    attempts: 8,
    lastError: 'HubSpot rejected the record',
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  } as SyncJob;
}

class FlakyTransport implements EmailSender {
  sent: EmailMessage[] = [];
  failuresLeft: number;
  constructor(failures = 0) {
    this.failuresLeft = failures;
  }
  async send(message: EmailMessage): Promise<void> {
    if (this.failuresLeft-- > 0) throw new Error('SMTP 421 service not available');
    this.sent.push(message);
  }
}

function digester(opts: {
  jobs: SyncJob[];
  deliveries: NotificationDeliveryStore;
  transport?: EmailSender;
  clock: { now: number };
  maxAttempts?: number;
}) {
  const activity = new ActivityLog();
  const sync = { list: async (_limit: number, status: string) => opts.jobs.filter((item) => item.status === status) } as unknown as SyncEngine;
  const instance = new SyncAlertDigester(sync, { get: async () => settings }, activity, {
    deliveries: opts.deliveries,
    transport: () => opts.transport,
    now: () => new Date(opts.clock.now),
    maxAttempts: opts.maxAttempts,
  });
  return { instance, activity };
}

const messages = (activity: ActivityLog) => activity.recent(50).map((entry) => entry.message);

describe('R14 notification delivery', () => {
  it('a failed send is retried with backoff and never reported as sent', async () => {
    const clock = { now: Date.parse('2026-09-24T10:00:00Z') };
    const transport = new FlakyTransport(1);
    const deliveries = new InMemoryNotificationDeliveryStore();
    const { instance, activity } = digester({ jobs: [job('a'), job('b')], deliveries, transport, clock });

    const first = await instance.checkNow();
    expect(first).toMatchObject({ sent: false, newIssues: 2, delivered: 0, failed: 1 });
    expect(transport.sent).toHaveLength(0);
    expect(messages(activity).some((m) => m.startsWith('Email alert sent'))).toBe(false);
    const [failed] = await deliveries.recent();
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, lastError: expect.stringContaining('421') });

    // Before the retry is due nothing is attempted; the same issues are not re-alerted.
    clock.now += 30_000;
    expect(await instance.checkNow()).toMatchObject({ newIssues: 0, delivered: 0, failed: 0 });

    clock.now += 60_000;
    expect(await instance.checkNow()).toMatchObject({ sent: true, delivered: 1 });
    expect(transport.sent).toHaveLength(1);
    expect((await deliveries.recent())[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect(messages(activity)).toContain('Email alert sent: 2 sync issues need attention');
  });

  it('without a transport the alert is "unconfigured", then goes out once SMTP is set up', async () => {
    const clock = { now: Date.now() };
    const deliveries = new InMemoryNotificationDeliveryStore();
    const unconfigured = digester({ jobs: [job('c')], deliveries, clock });
    expect(await unconfigured.instance.checkNow()).toMatchObject({ sent: false, unconfigured: 1, delivered: 0 });
    expect((await deliveries.recent())[0]!.status).toBe('unconfigured');
    expect(messages(unconfigured.activity)[0]).toMatch(/NOT sent -- no SMTP transport configured/);

    const transport = new FlakyTransport();
    const configured = digester({ jobs: [job('c')], deliveries, transport, clock });
    expect(await configured.instance.checkNow()).toMatchObject({ sent: true, delivered: 1, newIssues: 0 });
    expect((await deliveries.recent())[0]!.status).toBe('sent');
  });

  it('gives up after the attempt budget and says so', async () => {
    const clock = { now: Date.now() };
    const deliveries = new InMemoryNotificationDeliveryStore();
    const { instance, activity } = digester({ jobs: [job('d')], deliveries, transport: new FlakyTransport(99), clock, maxAttempts: 2 });
    await instance.checkNow();
    clock.now += 10 * 60_000;
    await instance.checkNow();
    expect((await deliveries.recent())[0]).toMatchObject({ status: 'abandoned', attempts: 2 });
    expect(messages(activity).some((m) => m.startsWith('Email alert abandoned after 2 attempts'))).toBe(true);
  });
});

describe('R14 notification delivery on PostgreSQL', () => {
  let pg: IsolatedPostgres;
  let tenantId: string;

  beforeAll(async () => {
    pg = await startIsolatedPostgres();
    tenantId = await pg.ensureTenant('alerts');
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('keeps delivery state across a restart: retried once, no duplicate alert', async () => {
    const clock = { now: Date.now() };
    const jobs = [job('11111111-1111-4111-8111-111111111111')];
    const failing = digester({ jobs, deliveries: new PostgresNotificationDeliveryStore(pg.database, tenantId), transport: new FlakyTransport(1), clock });
    expect(await failing.instance.checkNow()).toMatchObject({ failed: 1, newIssues: 1 });

    // "Restart": a new process with fresh objects over the same database.
    clock.now += 5 * 60_000;
    const transport = new FlakyTransport();
    const restarted = digester({ jobs, deliveries: new PostgresNotificationDeliveryStore(pg.database, tenantId), transport, clock });
    expect(await restarted.instance.checkNow()).toMatchObject({ newIssues: 0, delivered: 1 });
    expect(transport.sent).toHaveLength(1);
    const [delivery] = await new PostgresNotificationDeliveryStore(pg.database, tenantId).recent();
    expect(delivery).toMatchObject({ status: 'sent', attempts: 2, recipient: 'ops@example.com' });
  });
});
