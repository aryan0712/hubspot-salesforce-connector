/**
 * R08 synthetic load run (opt-in; not part of `npm test`).
 *
 *   npm run test:load                         # 100,001 records, in-memory stores
 *   npm run test:load -- --records 20000 --postgres   # durable PostgreSQL stores
 *
 * Seeds a mock Salesforce with N contacts, previews Salesforce → HubSpot, and executes the
 * approved preview through the durable worker path (claim → set-based enqueue → leased
 * batches). Verifies nothing is truncated (every record is queued, processed and created
 * exactly once) and reports runtime, peak heap and -- with --postgres -- database load from
 * pg_stat_database. The in-memory variant keeps its *stores* in memory by design, so its
 * heap includes the stored plans; the PostgreSQL variant shows the pipeline's own footprint.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { PostgresDatabase, runMigrations } from '../../src/db/postgres.js';
import { TenantRepository } from '../../src/db/tenantRepository.js';
import { createDefaultConfigContext } from '../../src/core/configContext.js';
import { buildHarness, mockCrms } from '../helpers/harness.js';

const argv = process.argv.slice(2);
const arg = (flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const records = Number(arg('--records') ?? 100_001);
const usePostgres = argv.includes('--postgres');

async function main(): Promise<void> {
  let peakHeap = 0;
  const sampler = setInterval(() => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 100);
  const pg = usePostgres ? await startCluster() : undefined;
  // Never leave a cluster running if the run is interrupted.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void (pg?.stop() ?? Promise.resolve()).finally(() => process.exit(130)));
  }
  try {
    const config = createDefaultConfigContext('load');
    const crms = mockCrms(config);
    const harness = await buildHarness({
      config,
      crms,
      idMapInMemory: true,
      postgres: pg ? { db: pg.db, tenantId: pg.tenantId } : undefined,
      worker: { batchSize: 200, progressEveryMs: 5000 },
    });
    // The worker loop rarely yields to timers, so sample the heap after every batch too.
    const runOnce = harness.service.worker.runOnce.bind(harness.service.worker);
    harness.service.worker.runOnce = async (...args) => {
      const processed = await runOnce(...args);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      return processed;
    };
    const seedStart = Date.now();
    for (let i = 0; i < records; i += 1) {
      crms.sf.seed('contact', { firstName: `Load ${i}`, lastName: 'Test', email: `load-${i}@example.com` });
    }
    const seedMs = Date.now() - seedStart;
    const dbBefore = pg ? await dbStats(pg.admin) : undefined;
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;

    const previewStart = Date.now();
    const preview = await harness.service.preview({ from: 'salesforce', types: ['contact'] });
    const previewMs = Date.now() - previewStart;
    if (preview.perType.contact!.read !== records) throw new Error(`preview read ${preview.perType.contact!.read} of ${records}`);

    const executeStart = Date.now();
    const outcome = await harness.service.executeDirect(preview.runId, { wait: true, failureThreshold: records });
    const executeMs = Date.now() - executeStart;
    const created = crms.hs.size();
    const counts = outcome.counts!;
    clearInterval(sampler);
    const result = {
      records,
      stores: usePostgres ? 'postgresql' : 'in-memory',
      seedMs,
      previewMs,
      executeMs,
      recordsPerSecond: Math.round(records / ((previewMs + executeMs) / 1000)),
      previewEmbeddedPlans: preview.plans.length,
      previewPlansTruncated: preview.plansTruncated ?? false,
      executionStatus: outcome.execution.status,
      counts,
      createdInHubSpot: created,
      heapBeforeMB: Math.round(heapBefore / 1_048_576),
      peakHeapMB: Math.round(peakHeap / 1_048_576),
      database: pg ? diffStats(dbBefore!, await dbStats(pg.admin)) : undefined,
      node: process.version,
      cpu: os.cpus()[0]?.model,
    };
    console.log(JSON.stringify(result, null, 2));
    const ok = counts.total === records && counts.succeeded === records && created === records;
    if (!ok) {
      const failed = await harness.executions.items(outcome.execution.id, { status: 'failed', limit: 3 });
      console.error(JSON.stringify(failed.map((item) => ({ position: item.position, error: item.error })), null, 2));
      console.error('LOAD RUN FAILED: records were truncated, repeated or lost');
      process.exitCode = 1;
    }
  } finally {
    clearInterval(sampler);
    await pg?.stop();
  }
}

interface Cluster {
  db: PostgresDatabase;
  admin: PostgresDatabase;
  tenantId: string;
  stop(): Promise<void>;
}

async function startCluster(): Promise<Cluster> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-sync-load-'));
  const port = await freePort();
  const password = crypto.randomBytes(18).toString('base64url');
  const cluster = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'cluster'),
    user: 'load_admin',
    password,
    port,
    persistent: false,
    onLog: () => undefined,
    onError: () => undefined,
  });
  await cluster.initialise();
  await cluster.start();
  await cluster.createDatabase('crm_sync_load');
  const url = `postgresql://load_admin:${encodeURIComponent(password)}@localhost:${port}/crm_sync_load`;
  const db = new PostgresDatabase({ connectionString: url, max: 8 });
  const admin = new PostgresDatabase({ connectionString: url, max: 1 });
  await runMigrations(db);
  const tenantId = (await new TenantRepository(db).ensure('load')).id;
  return {
    db,
    admin,
    tenantId,
    async stop() {
      await db.close();
      await admin.close();
      await cluster.stop();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
    },
  };
}

async function dbStats(admin: PostgresDatabase): Promise<Record<string, number>> {
  const result = await admin.pool.query<Record<string, string>>(
    `SELECT xact_commit, tup_inserted, tup_updated, tup_fetched, blks_read, blks_hit
     FROM pg_stat_database WHERE datname = current_database()`,
  );
  return Object.fromEntries(Object.entries(result.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]));
}

function diffStats(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.keys(after).map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
