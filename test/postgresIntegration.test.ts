import { createServer } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDatabase, runMigrations } from '../src/db/postgres.js';
import { TenantRepository } from '../src/db/tenantRepository.js';
import { SecretCipher } from '../src/db/security.js';
import { PostgresSettingsStore } from '../src/core/settingsStore.js';
import { PostgresConnectionStore } from '../src/core/connectionStore.js';
import { PostgresIdMapStore } from '../src/db/postgresIdMapStore.js';
import { PostgresSyncEventStore } from '../src/db/postgresSyncEventStore.js';
import { PostgresMigrationPlanStore } from '../src/db/postgresMigrationPlanStore.js';
import { PostgresMigrationStore } from '../src/db/postgresMigrationStore.js';
import { PostgresAiSettingsStore } from '../src/db/postgresAiSettingsStore.js';
import { PostgresMappingStore } from '../src/db/postgresMappingStore.js';
import { configureFieldRules, resetFieldRules } from '../src/core/mapping.js';

describe('PostgreSQL repositories', () => {
  let cluster: EmbeddedPostgres;
  let database: PostgresDatabase;
  let tempDir: string;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-sync-postgres-test-'));
    const port = await availablePort();
    const adminUser = 'crm_sync_test_admin';
    const user = 'crm_sync_test_app';
    const password = crypto.randomBytes(24).toString('base64url');
    const databaseName = 'crm_sync_test';
    cluster = new EmbeddedPostgres({
      databaseDir: path.join(tempDir, 'cluster'),
      user: adminUser,
      password,
      port,
      persistent: false,
      authMethod: 'scram-sha-256',
      onLog: () => undefined,
      onError: () => undefined,
    });
    await cluster.initialise();
    await cluster.start();
    await cluster.createDatabase(databaseName);
    const admin = cluster.getPgClient('postgres');
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${admin.escapeIdentifier(user)}
         LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `ALTER DATABASE ${admin.escapeIdentifier(databaseName)}
         OWNER TO ${admin.escapeIdentifier(user)}`,
      );
    } finally {
      await admin.end();
    }

    database = new PostgresDatabase({
      connectionString:
        `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
        `@localhost:${port}/${databaseName}`,
      max: 4,
    });
    await runMigrations(database);
    const tenants = new TenantRepository(database);
    tenantA = (await tenants.ensure('integration-a')).id;
    tenantB = (await tenants.ensure('integration-b')).id;
  }, 60_000);

  afterAll(async () => {
    await database?.close();
    await cluster?.stop();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  }, 30_000);

  it('applies every migration and forces tenant row-level security', async () => {
    const migrations = await database.pool.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(migrations.rows.map((row) => row.version)).toEqual([
      '001_initial.sql',
      '002_metadata_and_governance.sql',
      '003_delete_approvals.sql',
      '004_migration_plans.sql',
      '005_ai_provider_credentials.sql',
      '006_field_mapping_sets.sql',
      '007_migration_canary.sql',
      '008_open_object_model.sql',
      '009_notification_settings.sql',
    ]);

    const rls = await database.pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname IN (
         'crm_connections', 'record_links', 'sync_events', 'migration_plans',
         'ai_provider_credentials', 'field_mapping_sets'
       )
       ORDER BY relname`,
    );
    expect(rls.rows).toHaveLength(6);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const withoutTenant = await database.pool.query('SELECT * FROM crm_connections');
    expect(withoutTenant.rows).toEqual([]);
  });

  it('isolates and encrypts credentials and record links per tenant', async () => {
    const cipher = new SecretCipher('integration-test-encryption-key-that-is-long-enough');
    const settingsA = new PostgresSettingsStore(database, cipher, tenantA);
    const settingsB = new PostgresSettingsStore(database, cipher, tenantB);
    await settingsA.set('salesforce', {
      clientId: 'tenant-a-client',
      clientSecret: 'tenant-a-secret',
    });
    expect(await settingsA.get('salesforce')).toEqual({
      clientId: 'tenant-a-client',
      clientSecret: 'tenant-a-secret',
    });
    expect(await settingsB.get('salesforce')).toBeUndefined();

    const aiSettingsA = new PostgresAiSettingsStore(database, cipher, tenantA);
    const aiSettingsB = new PostgresAiSettingsStore(database, cipher, tenantB);
    await aiSettingsA.set('sk-test-tenant-a-openai-key', 'gpt-test', 'admin-a');
    expect(await aiSettingsA.get()).toMatchObject({
      apiKey: 'sk-test-tenant-a-openai-key',
      model: 'gpt-test',
      updatedBy: 'admin-a',
    });
    expect(await aiSettingsB.get()).toBeUndefined();
    const aiCiphertext = await database.tenant(tenantA, async (client) =>
      client.query<{ api_key_ciphertext: string }>(
        `SELECT api_key_ciphertext FROM ai_provider_credentials
         WHERE tenant_id = $1 AND provider = 'openai'`,
        [tenantA],
      ),
    );
    expect(aiCiphertext.rows[0]?.api_key_ciphertext).not.toContain(
      'sk-test-tenant-a-openai-key',
    );

    const connectionsA = new PostgresConnectionStore(database, cipher, tenantA);
    await connectionsA.set({
      system: 'hubspot',
      environment: 'sandbox',
      refreshToken: 'refresh-token-plaintext',
      accessToken: 'access-token-plaintext',
      connectedAt: new Date().toISOString(),
    });
    const ciphertext = await database.tenant(tenantA, async (client) =>
      client.query<{ refresh_token_ciphertext: string }>(
        `SELECT refresh_token_ciphertext FROM crm_connections
         WHERE tenant_id = $1 AND system = 'hubspot'`,
        [tenantA],
      ),
    );
    expect(ciphertext.rows[0]?.refresh_token_ciphertext).not.toContain(
      'refresh-token-plaintext',
    );
    expect((await connectionsA.get('hubspot'))?.refreshToken).toBe(
      'refresh-token-plaintext',
    );

    const linksA = new PostgresIdMapStore(database, tenantA);
    const linksB = new PostgresIdMapStore(database, tenantB);
    const canonicalId = crypto.randomUUID();
    await linksA.upsertLink({
      canonicalId,
      type: 'contact',
      ids: { salesforce: 'shared-native-id' },
      hashes: { salesforce: 'hash-a' },
      modifiedAt: { salesforce: '2026-07-29T00:00:00.000Z' },
      naturalKeys: ['email:ada@example.com'],
      updatedAt: new Date().toISOString(),
    });
    expect((await linksA.bySource('salesforce', 'shared-native-id'))?.canonicalId).toBe(
      canonicalId,
    );
    expect(await linksB.bySource('salesforce', 'shared-native-id')).toBeUndefined();

    const crossTenant = await database.tenant(tenantB, async (client) =>
      client.query(
        'SELECT id FROM record_links WHERE tenant_id = $1 AND id = $2',
        [tenantA, canonicalId],
      ),
    );
    expect(crossTenant.rows).toEqual([]);
  });

  it('persists idempotent jobs and revisioned migration plans', async () => {
    const jobs = new PostgresSyncEventStore(database, tenantA);
    const event = {
      eventId: 'integration-event-1',
      system: 'salesforce' as const,
      type: 'contact' as const,
      sourceId: '003-integration',
      changeType: 'updated' as const,
      occurredAt: '2026-07-29T00:00:00.000Z',
    };
    const first = await jobs.enqueue([event]);
    const repeated = await jobs.enqueue([event]);
    expect(repeated).toEqual(first);

    const claimed = await jobs.claim(10, 'integration-worker');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ attempts: 1, status: 'processing' });
    await jobs.complete(claimed[0]!.id);
    expect(await jobs.stats()).toMatchObject({ completed: 1, queued: 0 });

    const plans = new PostgresMigrationPlanStore(database, tenantA);
    const migrations = new PostgresMigrationStore(database, tenantA);
    const previewRunId = await migrations.begin({
      source: 'salesforce',
      types: ['contact'],
      mode: 'preview',
      options: { limitPerType: 10 },
    });
    const created = await plans.create({
      name: 'Integration plan',
      source: 'salesforce',
      types: ['contact'],
      limitPerType: 10,
    });
    await plans.saveValidation(created.id, created.revision, {
      'salesforce:contact': 'source-hash',
      'hubspot:contact': 'target-hash',
    });
    await plans.savePreview(created.id, created.revision, previewRunId);
    await plans.saveCanaryPreview(
      created.id,
      created.revision,
      'contact',
      '003-integration',
      previewRunId,
    );
    const canaryExecutionRunId = await migrations.begin({
      source: 'salesforce',
      types: ['contact'],
      mode: 'execute',
      options: { canary: true },
    });
    await plans.finishCanary(created.id, created.revision, canaryExecutionRunId);
    expect((await plans.get(created.id))?.canary).toMatchObject({
      type: 'contact',
      sourceId: '003-integration',
      previewRunId,
      executionRunId: canaryExecutionRunId,
    });
    const updated = await plans.update(created.id, {
      name: 'Integration plan',
      source: 'salesforce',
      types: ['contact', 'company'],
      limitPerType: 20,
    });
    expect(updated).toMatchObject({
      revision: 2,
      status: 'draft',
      previewRunId: undefined,
      previewRevision: undefined,
      canary: undefined,
    });
  });

  it('persists an intentionally empty mapping set across initialization', async () => {
    const mappings = new PostgresMappingStore(database, tenantA);
    try {
      await mappings.set('salesforce', 'contact', []);
      resetFieldRules();
      // No hardcoded defaults exist anymore to distinguish "reset" from "loaded empty from DB";
      // seed a placeholder so the pre-init/post-init states are still distinguishable.
      configureFieldRules('salesforce', 'contact', [{ canonical: 'placeholder', native: 'Placeholder' }]);
      expect(mappings.get('salesforce', 'contact')).not.toEqual([]);

      await mappings.init();

      expect(mappings.get('salesforce', 'contact')).toEqual([]);
      const marker = await database.tenant(tenantA, (client) =>
        client.query(
          `SELECT 1 FROM field_mapping_sets
           WHERE tenant_id = $1 AND system = 'salesforce' AND object_type = 'contact'`,
          [tenantA],
        ),
      );
      expect(marker.rowCount).toBe(1);
    } finally {
      resetFieldRules();
    }
  });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('unable to allocate PostgreSQL test port');
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
