import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { CRMConnector } from '../src/core/connector.js';
import type { SystemId } from '../src/core/types.js';
import { MockConnector } from '../src/connectors/mock/mockConnector.js';
import { FileIdMapStore } from '../src/core/idMap.js';
import { Reconciler } from '../src/engine/reconciler.js';
import { InMemorySyncEventStore } from '../src/engine/syncEventStore.js';
import { SyncEngine } from '../src/engine/syncEngine.js';
import { SyncPoller } from '../src/engine/syncPoller.js';
import { InMemoryReplayCursorStore } from '../src/connectors/salesforce/cdcWorker.js';
import { defaultSyncConfig, InMemorySyncConfigStore } from '../src/core/syncConfig.js';

async function setup() {
  const sf = new MockConnector('salesforce');
  const hs = new MockConnector('hubspot');
  const connectors: Record<SystemId, CRMConnector> = { salesforce: sf, hubspot: hs };
  const idMap = new FileIdMapStore(path.join(os.tmpdir(), `idmap-poller-${crypto.randomUUID()}.json`));
  await idMap.init();
  const reconciler = new Reconciler(connectors, idMap);
  const syncConfig = new InMemorySyncConfigStore(
    defaultSyncConfig('last-write-wins', 'salesforce', ['contact']),
  );
  const store = new InMemorySyncEventStore();
  const sync = new SyncEngine(connectors, reconciler, store);
  await sync.init();
  const cursors = new InMemoryReplayCursorStore();
  const poller = new SyncPoller(connectors, syncConfig, cursors, sync);
  return { sf, hs, connectors, idMap, reconciler, syncConfig, sync, cursors, poller };
}

type Ctx = Awaited<ReturnType<typeof setup>>;
let ctx: Ctx;
beforeEach(async () => {
  ctx = await setup();
});

describe('scheduled sync polling', () => {
  it('picks up a record changed outside the app and reconciles it to the other system', async () => {
    ctx.sf.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });

    const summary = await ctx.poller.runOnce('contact');
    await ctx.sync.drain();

    expect(summary.changed).toBeGreaterThan(0);
    const hsRecords = (await ctx.hs.list('contact')).records;
    expect(hsRecords).toHaveLength(1);
    expect(hsRecords[0]!.fields.email).toBe('ada@example.com');
  });

  it('does not create duplicates when the same record is polled again', async () => {
    ctx.sf.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });
    await ctx.poller.runOnce('contact');
    await ctx.sync.drain();
    expect((await ctx.hs.list('contact')).records).toHaveLength(1);

    // The salesforce record itself hasn't changed since the first poll, so it isn't
    // re-detected on the salesforce side. The mirror hubspot record the first poll just
    // created *is* freshly modified and gets picked up by hubspot's own poll -- but the
    // reconciler's content-hash echo suppression recognizes it's our own write and no-ops
    // it rather than looping it back, so no duplicate is ever created on either side.
    await ctx.poller.runOnce('contact');
    await ctx.sync.drain();

    expect((await ctx.sf.list('contact')).records).toHaveLength(1);
    const hsRecords = (await ctx.hs.list('contact')).records;
    expect(hsRecords).toHaveLength(1);
    expect(hsRecords[0]!.fields.email).toBe('ada@example.com');
  });

  it('detects a deletion and routes it through the delete policy', async () => {
    const sfId = ctx.sf.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });
    await ctx.poller.runOnce('contact');
    await ctx.sync.drain();
    expect((await ctx.hs.list('contact')).records).toHaveLength(1);

    await ctx.sf.remove('contact', sfId);
    const summary = await ctx.poller.runOnce('contact');
    await ctx.sync.drain();

    expect(summary.deleted).toBe(1);
    expect((await ctx.sync.stats()).manualReview).toBe(1);
  });

  it('does not poll an object that is disabled in the sync policy', async () => {
    const config = ctx.syncConfig.get();
    config.objects.contact.enabled = false;
    await ctx.syncConfig.update(config);
    ctx.sf.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });

    const summary = await ctx.poller.runOnce('contact');

    expect(summary.changed).toBe(0);
    expect((await ctx.hs.list('contact')).records).toHaveLength(0);
  });

  it('only picks up records matching the object\'s configured condition', async () => {
    const config = ctx.syncConfig.get();
    // A condition's `field` names the SOURCE system's own native field (e.g. Salesforce's
    // "Email", not the canonical "email") -- it's checked directly against the raw record.
    config.objects.contact.conditions = { salesforce: [{ field: 'Email', operator: 'contains', value: '@keep.co' }] };
    await ctx.syncConfig.update(config);
    ctx.sf.seed('contact', { firstName: 'Ada', email: 'ada@keep.co' });
    ctx.sf.seed('contact', { firstName: 'Grace', email: 'grace@excluded.co' });

    const summary = await ctx.poller.runOnce('contact');
    await ctx.sync.drain();

    expect(summary.changed).toBe(1);
    const hsRecords = (await ctx.hs.list('contact')).records;
    expect(hsRecords).toHaveLength(1);
    expect(hsRecords[0]!.fields.email).toBe('ada@keep.co');
  });

  it('keeps a bounded, newest-first run history per object', async () => {
    for (let i = 0; i < 25; i += 1) {
      await ctx.poller.runOnce('contact');
    }
    const history = ctx.poller.history('contact');
    expect(history).toHaveLength(20);
    expect(new Date(history[0]!.at).getTime()).toBeGreaterThanOrEqual(new Date(history[1]!.at).getTime());
  });
});

describe('scheduled sync polling -- independent per-object intervals', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls each object on its own schedule ("scenario") rather than one shared interval', async () => {
    // Advancing fake timers still runs the resulting callback chains on the real CPU, so a
    // busy machine can need more than vitest's 5s default to work through this many ticks.
    const sf = new MockConnector('salesforce');
    const hs = new MockConnector('hubspot');
    const connectors: Record<SystemId, CRMConnector> = { salesforce: sf, hubspot: hs };
    const idMap = new FileIdMapStore(path.join(os.tmpdir(), `idmap-poller-multi-${crypto.randomUUID()}.json`));
    await idMap.init();
    const reconciler = new Reconciler(connectors, idMap);
    const syncConfig = new InMemorySyncConfigStore(
      defaultSyncConfig('last-write-wins', 'salesforce', ['contact', 'company']),
    );
    const store = new InMemorySyncEventStore();
    const sync = new SyncEngine(connectors, reconciler, store);
    await sync.init();
    const cursors = new InMemoryReplayCursorStore();
    const poller = new SyncPoller(connectors, syncConfig, cursors, sync);

    const config = syncConfig.get();
    config.polling.contact = { enabled: true, intervalMinutes: 1 };
    config.polling.company = { enabled: true, intervalMinutes: 10 };
    await syncConfig.update(config);

    vi.useFakeTimers();
    poller.start();
    // The very first tick treats every enabled object as due, regardless of its interval --
    // let that settle before asserting on the independent cadence that follows. (SyncEngine's
    // own retry/backoff timers are driven by the same fake clock, so advancing it also lets
    // enqueued jobs finish processing -- no separate real-timer drain() needed here.)
    await vi.advanceTimersByTimeAsync(30_000);

    // New changes on both objects: contact's 1-minute interval should pick this up well
    // before company's 10-minute interval does.
    sf.seed('contact', { firstName: 'Ada', email: 'ada@example.com' });
    sf.seed('company', { name: 'Acme', domain: 'acme.com' });

    await vi.advanceTimersByTimeAsync(90_000); // just past contact's 1-minute interval
    expect((await hs.list('contact')).records).toHaveLength(1);
    expect((await hs.list('company')).records).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(11 * 60_000); // well past company's 10-minute interval
    expect((await hs.list('company')).records).toHaveLength(1);

    poller.stop();
  }, 15_000);

  it('supports a cron expression as an alternative to a plain interval', async () => {
    const sf = new MockConnector('salesforce');
    const hs = new MockConnector('hubspot');
    const connectors: Record<SystemId, CRMConnector> = { salesforce: sf, hubspot: hs };
    const idMap = new FileIdMapStore(path.join(os.tmpdir(), `idmap-poller-cron-${crypto.randomUUID()}.json`));
    await idMap.init();
    const reconciler = new Reconciler(connectors, idMap);
    const syncConfig = new InMemorySyncConfigStore(defaultSyncConfig('last-write-wins', 'salesforce', ['company']));
    const store = new InMemorySyncEventStore();
    const sync = new SyncEngine(connectors, reconciler, store);
    await sync.init();
    const cursors = new InMemoryReplayCursorStore();
    const poller = new SyncPoller(connectors, syncConfig, cursors, sync);

    const config = syncConfig.get();
    // intervalMinutes is present but irrelevant here -- a cron expression takes precedence.
    config.polling.company = { enabled: true, intervalMinutes: 30, cron: '*/2 * * * *' };
    await syncConfig.update(config);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    poller.start();
    await vi.advanceTimersByTimeAsync(30_000); // consume the unconditional first tick

    sf.seed('company', { name: 'Acme', domain: 'acme.com' });
    await vi.advanceTimersByTimeAsync(60_000); // 90s elapsed -- comfortably under the 2-minute mark
    expect((await hs.list('company')).records).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(90_000); // 180s elapsed -- comfortably past it
    expect((await hs.list('company')).records).toHaveLength(1);

    poller.stop();
  }, 15_000);
});
