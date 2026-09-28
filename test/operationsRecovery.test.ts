import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { PostgresDatabase, runMigrations } from '../src/db/postgres.js';
import { TenantRepository } from '../src/db/tenantRepository.js';
import { SecretCipher } from '../src/db/security.js';
import { PostgresConnectionStore } from '../src/core/connectionStore.js';
import { applyRetention } from '../src/db/retention.js';
import { startIsolatedPostgres, type IsolatedPostgres } from './helpers/postgres.js';

/** R14: data retention, and a measured backup/restore of encrypted state. */

describe('R14 data retention', () => {
  let pg: IsolatedPostgres;
  let tenantId: string;

  beforeAll(async () => {
    pg = await startIsolatedPostgres();
    tenantId = await pg.ensureTenant('retention');
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('purges finished operational rows past the window and keeps evidence and live state', async () => {
    const old = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString();
    await pg.database.tenant(tenantId, async (client) => {
      const event = async (id: string, status: string, updatedAt: string) =>
        client.query(
          `INSERT INTO sync_events(tenant_id, vendor_event_id, system, object_type, source_id, change_type, occurred_at, payload, status, updated_at)
           VALUES ($1,$2,'hubspot','contact',$2,'updated',now(),'{}',$3,$4)`,
          [tenantId, id, status, updatedAt],
        );
      await event('old-completed', 'completed', old);
      await event('old-dismissed', 'dismissed', old);
      await event('recent-completed', 'completed', new Date().toISOString());
      await event('old-dead-letter', 'dead_letter', old); // unresolved: kept
      const intent = (key: string, status: string) =>
        client.query(
          `INSERT INTO write_intents(tenant_id, operation_id, link_id, object_type, system, operation, source_system,
             source_id, fields, payload, payload_hash, status, updated_at)
           VALUES ($1,$2,$3,'contact','hubspot','create','salesforce',$2,'{}','{}','h',$4,$5)`,
          [tenantId, key, crypto.randomUUID(), status, old],
        );
      await intent('intent-committed', 'committed');
      await intent('intent-uncertain', 'uncertain'); // recovery evidence: kept
      await client.query(`INSERT INTO webhook_nonces(tenant_id, system, nonce, expires_at) VALUES ($1,'salesforce','n1', now() - interval '1 minute')`, [tenantId]);
      await client.query(`INSERT INTO audit_entries(tenant_id, action, resource_type, detail, created_at) VALUES ($1,'old.action','test','{}',$2)`, [tenantId, old]);
    });

    const deleted = await applyRetention(pg.database);
    expect(deleted).toMatchObject({ sync_events: 2, write_intents: 1, webhook_nonces: 1 });

    const remaining = await pg.database.tenant(tenantId, async (client) => ({
      events: (await client.query<{ vendor_event_id: string }>('SELECT vendor_event_id FROM sync_events ORDER BY vendor_event_id')).rows.map((r) => r.vendor_event_id),
      intents: (await client.query<{ operation_id: string }>('SELECT operation_id FROM write_intents')).rows.map((r) => r.operation_id),
      audit: (await client.query('SELECT 1 FROM audit_entries WHERE action = $1', ['old.action'])).rowCount,
    }));
    expect(remaining.events).toEqual(['old-dead-letter', 'recent-completed']);
    expect(remaining.intents).toEqual(['intent-uncertain']);
    expect(remaining.audit).toBe(1);
  });
});

describe('R14 backup and restore of encrypted state', () => {
  const root = path.join(os.tmpdir(), `crm-sync-restore-${crypto.randomUUID().slice(0, 8)}`);
  const clusters: EmbeddedPostgres[] = [];
  const user = 'restore_admin';
  const password = crypto.randomBytes(12).toString('hex');
  const key = crypto.randomBytes(32).toString('base64url');

  afterAll(async () => {
    for (const cluster of clusters) await cluster.stop().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  });

  const cluster = (dataDir: string, port: number) => {
    const instance = new EmbeddedPostgres({
      databaseDir: dataDir,
      user,
      password,
      port,
      persistent: true,
      authMethod: 'scram-sha-256',
      onLog: () => undefined,
      onError: () => undefined,
    });
    clusters.push(instance);
    return instance;
  };
  const url = (port: number) => `postgresql://${user}:${password}@localhost:${port}/postgres`;

  it('restores a cold backup into a clean environment and decrypts it with the backed-up key', async () => {
    // Source environment with an encrypted OAuth connection.
    const sourcePort = await freePort();
    const source = cluster(path.join(root, 'source'), sourcePort);
    await source.initialise();
    await source.start();
    let db = new PostgresDatabase({ connectionString: url(sourcePort), max: 2 });
    await runMigrations(db);
    const tenantId = (await new TenantRepository(db).ensure('restore-me')).id;
    await new PostgresConnectionStore(db, new SecretCipher(key), tenantId).set({
      system: 'salesforce',
      environment: 'production',
      refreshToken: 'refresh-token-to-recover',
      instanceUrl: 'https://example.my.salesforce.com',
      accountId: '00D000000000001AAA',
      connectedAt: new Date().toISOString(),
    });
    await db.close();

    // Backup: stop, copy the data directory, keep the key alongside (separately in production).
    await source.stop();
    const backupDir = path.join(root, 'backup');
    await fs.cp(path.join(root, 'source'), backupDir, { recursive: true });
    await fs.writeFile(path.join(root, 'backup.key'), key, { mode: 0o600 });

    // Restore into a clean environment (new directory, new port) and measure it.
    const started = performance.now();
    await fs.cp(backupDir, path.join(root, 'restored'), { recursive: true });
    const restoredPort = await freePort();
    await cluster(path.join(root, 'restored'), restoredPort).start();
    db = new PostgresDatabase({ connectionString: url(restoredPort), max: 2 });
    try {
      const restoredKey = await fs.readFile(path.join(root, 'backup.key'), 'utf8');
      const connection = await new PostgresConnectionStore(db, new SecretCipher(restoredKey), tenantId).get('salesforce');
      const recoveryMs = performance.now() - started;
      expect(connection).toMatchObject({ refreshToken: 'refresh-token-to-recover', accountId: '00D000000000001AAA' });
      // Without the backed-up key the restored secrets are unreadable.
      await expect(
        new PostgresConnectionStore(db, new SecretCipher(crypto.randomBytes(32).toString('base64url')), tenantId).get('salesforce'),
      ).rejects.toThrow();
      console.info(`[R14 restore] cold backup restored and decrypted in ${Math.round(recoveryMs)} ms`);
      expect(recoveryMs).toBeLessThan(120_000);
    } finally {
      await db.close();
    }
  }, 180_000);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
