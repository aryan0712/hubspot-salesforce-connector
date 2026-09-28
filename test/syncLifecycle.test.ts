import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalRecord, ChangeEvent } from '../src/core/types.js';
import { SyncEngine } from '../src/engine/syncEngine.js';
import { InMemorySyncEventStore } from '../src/engine/syncEventStore.js';
import { PostgresSyncEventStore } from '../src/db/postgresSyncEventStore.js';
import { SyncPoller } from '../src/engine/syncPoller.js';
import { InMemoryReplayCursorStore } from '../src/connectors/salesforce/cdcWorker.js';
import { defaultSyncConfig, InMemorySyncConfigStore, syncRoute } from '../src/core/syncConfig.js';
import { searchNextCursor, SEARCH_RESULT_CAP } from '../src/connectors/hubspot/hubspotConnector.js';
import { installGracefulShutdown } from '../src/lifecycle.js';
import { startIsolatedPostgres, type IsolatedPostgres } from './helpers/postgres.js';
import { buildHarness, NEW, type Harness } from './helpers/harness.js';

/**
 * R09 acceptance: crash recovery without restarting replicas, lease fencing, readiness
 * gating, pause-versus-discard, poll/webhook overlap without loss or duplication, polling
 * boundaries and vendor search limits, and ordered shutdown.
 */
let pg: IsolatedPostgres;
beforeAll(async () => {
  pg = await startIsolatedPostgres();
}, 180_000);
afterAll(async () => {
  await pg?.stop();
}, 30_000);

const event = (sourceId: string, over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  eventId: crypto.randomUUID(),
  system: 'salesforce',
  type: 'contact',
  sourceId,
  changeType: 'updated',
  occurredAt: NEW,
  ...over,
});

async function until(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('R09 lease fencing and recovery (PostgreSQL, independent clients)', () => {
  it('a stale worker cannot complete a job another worker took over', async () => {
    const tenantId = await pg.ensureTenant(`r09-${crypto.randomUUID().slice(0, 8)}`);
    const a = new PostgresSyncEventStore(pg.connect(), tenantId);
    const b = new PostgresSyncEventStore(pg.connect(), tenantId);
    const [id] = await a.enqueue([event('003A')]);
    const [claimedByA] = await a.claim(10, 'worker-a');
    expect(claimedByA?.leaseToken).toBeTruthy();
    // Worker A stalls; its lease expires and is recovered, then worker B claims the job.
    expect(await b.recoverStale(new Date(Date.now() + 1000).toISOString())).toBe(1);
    const [claimedByB] = await b.claim(10, 'worker-b');
    expect(claimedByB?.id).toBe(id);
    expect(claimedByB?.leaseToken).not.toBe(claimedByA?.leaseToken);
    // A wakes up and tries to finish: fenced out.
    expect(await a.complete(id!, claimedByA!.leaseToken)).toBe(false);
    expect(await a.retry(id!, 'late', new Date().toISOString(), claimedByA!.leaseToken)).toBe(false);
    expect((await b.get(id!))?.status).toBe('processing');
    expect(await b.complete(id!, claimedByB!.leaseToken)).toBe(true);
    expect((await a.get(id!))?.status).toBe('completed');
  });

  it('never claims two jobs for the same record at once', async () => {
    const tenantId = await pg.ensureTenant(`r09-${crypto.randomUUID().slice(0, 8)}`);
    const store = new PostgresSyncEventStore(pg.connect(), tenantId);
    await store.enqueue([event('003B'), event('003B'), event('003C')]);
    const first = await store.claim(10, 'worker');
    expect(first.map((job) => job.event.sourceId).sort()).toEqual(['003B', '003C']);
    expect(await store.claim(10, 'worker')).toHaveLength(0);
    await store.complete(first.find((job) => job.event.sourceId === '003B')!.id, first.find((job) => job.event.sourceId === '003B')!.leaseToken);
    expect((await store.claim(10, 'worker')).map((job) => job.event.sourceId)).toEqual(['003B']);
  });

  it('heartbeats keep a long job leased; recovery only takes expired leases', async () => {
    const tenantId = await pg.ensureTenant(`r09-${crypto.randomUUID().slice(0, 8)}`);
    const store = new PostgresSyncEventStore(pg.connect(), tenantId);
    await store.enqueue([event('003D')]);
    const [job] = await store.claim(1, 'worker');
    expect(await store.heartbeat(job!.id, job!.leaseToken!)).toBe(true);
    expect(await store.recoverStale(new Date(Date.now() - 60_000).toISOString())).toBe(0);
    expect(await store.heartbeat(job!.id, 'someone-else')).toBe(false);
  });
});

describe('R09 worker lifecycle', () => {
  it('backlogged jobs never run against an uninitialized connector', async () => {
    const h = await buildHarness();
    const sfId = h.sf.seed('contact', { email: 'ada@example.com' });
    let initialized = false;
    const read = h.sf.read.bind(h.sf);
    h.sf.read = async (...args) => {
      if (!initialized) throw new Error('connector used before init');
      return read(...args);
    };
    const store = new InMemorySyncEventStore();
    const sync = new SyncEngine(h.connectors, h.reconciler, store, { manualStart: true, pollMs: 20 });
    await sync.init();
    await sync.enqueue([event(sfId)]);
    sync.start(async () => initialized);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await sync.stats()).queued).toBe(1);
    initialized = true;
    await until(async () => (await sync.stats()).completed === 1);
    await sync.stop();
    expect((await h.hs.list('contact')).records).toHaveLength(1);
  });

  it('a crashed worker\'s jobs are recovered by a running worker without any restart', async () => {
    const h = await buildHarness();
    const sfId = h.sf.seed('contact', { email: 'grace@example.com' });
    const store = new InMemorySyncEventStore();
    await store.enqueue([event(sfId)]);
    const [orphan] = await store.claim(1, 'crashed-worker');
    store.expireLease(orphan!.id);
    const survivor = new SyncEngine(h.connectors, h.reconciler, store, { manualStart: true, leaseMs: 2000, pollMs: 20 });
    survivor.start(async () => true);
    await until(async () => (await store.get(orphan!.id))?.status === 'completed');
    await survivor.stop();
    expect((await h.hs.list('contact')).records).toHaveLength(1);
  });

  it('stop() finishes in-flight work and leaves the rest queued', async () => {
    const h = await buildHarness();
    const ids = [h.sf.seed('contact', { email: 'a1@example.com' }), h.sf.seed('contact', { email: 'a2@example.com' })];
    const store = new InMemorySyncEventStore();
    const sync = new SyncEngine(h.connectors, h.reconciler, store, { manualStart: true, concurrency: 1, pollMs: 20 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = h.hs.write.bind(h.hs);
    h.hs.write = async (...args) => {
      await gate;
      return write(...args);
    };
    await sync.enqueue(ids.map((id) => event(id)));
    sync.start(async () => true);
    await until(async () => (await sync.stats()).processing === 1);
    const stopping = sync.stop();
    release();
    await stopping;
    const stats = await sync.stats();
    expect(stats.completed).toBe(1);
    expect(stats.queued).toBe(1);
  });

  it('paused objects defer changes (kept) while unenrolled objects discard them', async () => {
    const h = await buildHarness();
    const sfId = h.sf.seed('contact', { email: 'paused@example.com' });
    const configStore = new InMemorySyncConfigStore(defaultSyncConfig('last-write-wins', 'salesforce', ['contact']));
    const paused = configStore.get();
    paused.objects.contact = { ...paused.objects.contact!, enabled: false };
    await configStore.update(paused);
    const store = new InMemorySyncEventStore();
    const sync = new SyncEngine(h.connectors, h.reconciler, store, {
      route: (e) => syncRoute(configStore.get(), e.type, e.system),
      deferMs: 50,
    });
    await sync.init();
    const [id] = await sync.enqueue([event(sfId)]);
    await until(async () => Boolean((await store.get(id!))?.deferredReason));
    expect((await store.get(id!))).toMatchObject({ status: 'queued', attempts: 0, deferredReason: 'sync is paused for contact' });
    expect(h.hs.writes).toHaveLength(0);
    const resumed = configStore.get();
    resumed.objects.contact = { ...resumed.objects.contact!, enabled: true };
    await configStore.update(resumed);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await sync.drain();
    expect((await store.get(id!))?.status).toBe('completed');
    expect((await h.hs.list('contact')).records).toHaveLength(1);
    expect(syncRoute(configStore.get(), 'deal', 'salesforce')).toMatchObject({ action: 'discard' });
  });
});

describe('R09 polling and webhook overlap', () => {
  async function pollerFor(h: Harness) {
    const configStore = new InMemorySyncConfigStore(defaultSyncConfig('last-write-wins', 'salesforce', ['contact']));
    const store = new InMemorySyncEventStore();
    const sync = new SyncEngine(h.connectors, h.reconciler, store, {
      route: (e) => syncRoute(configStore.get(), e.type, e.system),
    });
    await sync.init();
    const cursors = new InMemoryReplayCursorStore();
    const poller = new SyncPoller(h.connectors, configStore, cursors, sync, h.config, undefined, h.idMap);
    return { sync, poller, cursors, store };
  }

  it('the same change arriving by webhook and by polling is written once', async () => {
    const h = await buildHarness();
    const { sync, poller } = await pollerFor(h);
    const sfId = h.sf.seed('contact', { email: 'overlap@example.com' });
    const record = (await h.sf.read('contact', sfId))!;
    await sync.enqueue([event(sfId, { occurredAt: record.meta.modifiedAt })]); // webhook
    await poller.runOnce('contact'); // poll sees the same change
    await sync.drain();
    expect((await h.hs.list('contact')).records).toHaveLength(1);
    expect(h.hs.writes).toHaveLength(1);
  });

  it('re-reads an overlap window so a late-visible change is not lost, without duplicating', async () => {
    const h = await buildHarness();
    const { sync, poller } = await pollerFor(h);
    const first = h.sf.seed('contact', { email: 'first@example.com' });
    await poller.runOnce('contact');
    await sync.drain();
    // A change stamped 30s before the committed cursor only becomes visible now.
    const late = h.sf.seed('contact', { email: 'late@example.com' });
    h.sf.setModifiedAt('contact', late, new Date(Date.now() - 30_000).toISOString());
    await poller.runOnce('contact');
    await sync.drain();
    const emails = (await h.hs.list('contact')).records.map((record) => record.fields.email).sort();
    expect(emails).toEqual(['first@example.com', 'late@example.com']);
    expect(h.hs.writes.filter((write) => !write.targetId)).toHaveLength(2);
    void first;
  });

  it('restarts a HubSpot search from the last timestamp instead of paging past the cap', () => {
    const record = (modifiedAt: string) => ({ meta: { modifiedAt } }) as CanonicalRecord;
    expect(searchNextCursor('200', [record(NEW)], '2024-01-01T00:00:00Z')).toBe('200');
    expect(searchNextCursor(String(SEARCH_RESULT_CAP - 100), [record(NEW)], '2024-01-01T00:00:00Z')).toBe(`ts:${NEW}`);
    expect(searchNextCursor(undefined, [record(NEW)], '2024-01-01T00:00:00Z')).toBeUndefined();
    expect(() => searchNextCursor(String(SEARCH_RESULT_CAP - 100), [record(NEW)], NEW)).toThrow(/share modified time/);
  });
});

describe('R09 graceful shutdown', () => {
  it('runs steps in order, survives a failing step, and exits', async () => {
    const order: string[] = [];
    let code: number | undefined;
    const shutdown = installGracefulShutdown(
      [
        async () => {
          order.push('stop intake');
        },
        async () => {
          order.push('drain');
          throw new Error('drain failed');
        },
        async () => {
          order.push('close db');
        },
      ],
      { exit: (value) => {
        code = value;
      } },
    );
    await shutdown();
    expect(order).toEqual(['stop intake', 'drain', 'close db']);
    expect(code).toBe(0);
  });
});
