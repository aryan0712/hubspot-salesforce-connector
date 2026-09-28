import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretCipher, parsePreviousKeys, versionOf } from '../src/db/security.js';
import { ENCRYPTED_COLUMNS, rotateSecrets } from '../src/db/rotateSecrets.js';
import { PostgresConnectionStore } from '../src/core/connectionStore.js';
import { PostgresSettingsStore } from '../src/core/settingsStore.js';
import { PostgresAiSettingsStore } from '../src/db/postgresAiSettingsStore.js';
import { PostgresNotificationSettingsStore } from '../src/db/postgresNotificationSettingsStore.js';
import { PostgresOAuthStateStore } from '../src/db/postgresOAuthStateStore.js';
import { startIsolatedPostgres, type IsolatedPostgres } from './helpers/postgres.js';

/** R14: versioned key rotation for every stored secret, with the old key retired after. */

const KEY_V1 = 'k'.repeat(40);
const KEY_V2 = 'n'.repeat(40);

describe('R14 secret rotation', () => {
  let pg: IsolatedPostgres;
  let tenants: string[];
  let state: string;
  let pendingId: string;

  const stores = (tenantId: string, cipher: SecretCipher) => ({
    connections: new PostgresConnectionStore(pg.database, cipher, tenantId),
    settings: new PostgresSettingsStore(pg.database, cipher, tenantId),
    ai: new PostgresAiSettingsStore(pg.database, cipher, tenantId),
    notifications: new PostgresNotificationSettingsStore(pg.database, cipher, tenantId),
    oauth: new PostgresOAuthStateStore(pg.database, cipher),
  });

  beforeAll(async () => {
    pg = await startIsolatedPostgres();
    tenants = [await pg.ensureTenant('rotate-a'), await pg.ensureTenant('rotate-b')];
    const v1 = new SecretCipher(KEY_V1, 1);
    for (const tenantId of tenants) {
      const s = stores(tenantId, v1);
      await s.connections.set({
        system: 'hubspot',
        environment: 'production',
        refreshToken: `refresh-${tenantId}`,
        accessToken: `access-${tenantId}`,
        connectedAt: new Date().toISOString(),
      });
      await s.settings.set('salesforce', { clientId: 'client', clientSecret: `secret-${tenantId}` });
      await s.ai.set(`sk-${tenantId}-0000000000000000`, 'gpt-test');
      await s.notifications.set({ enabled: true, alertEmail: 'ops@example.com', smtpPassword: `smtp-${tenantId}` });
    }
    const oauth = stores(tenants[0]!, v1).oauth;
    state = await oauth.create({
      tenantId: tenants[0]!,
      sessionHash: 'session',
      userId: 'u',
      system: 'salesforce',
      environment: 'production',
      redirectUri: 'r',
      codeVerifier: 'verifier-before-rotation',
    });
    const staged = await pg.database.tenant(tenants[0]!, async (client) =>
      (await client.query<{ id: string }>('SELECT id FROM oauth_states LIMIT 1')).rows[0]!.id,
    );
    pendingId = staged;
    await oauth.stagePending(tenants[0]!, pendingId, {
      system: 'salesforce',
      environment: 'production',
      refreshToken: 'pending-refresh',
      connectedAt: new Date().toISOString(),
    });
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('covers every encrypted column in the schema', async () => {
    const result = await pg.database.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%ciphertext'`,
    );
    const inSchema = result.rows.map((row) => `${row.table_name}.${row.column_name}`).sort();
    expect(ENCRYPTED_COLUMNS.map((spec) => `${spec.table}.${spec.column}`).sort()).toEqual(inSchema);
  });

  it('a new key alone cannot read secrets written with the old one', async () => {
    const v2Only = stores(tenants[0]!, new SecretCipher(KEY_V2, 2));
    await expect(v2Only.connections.get('hubspot')).rejects.toThrow(/key v1, which is not configured/);
  });

  it('re-encrypts everything under the new key; the old key can then be retired', async () => {
    const rotating = new SecretCipher(KEY_V2, 2, parsePreviousKeys(`1:${KEY_V1}`));
    const dry = await rotateSecrets(pg.database, rotating, { dryRun: true });
    // 2 tenants x (refresh, access, client secret, AI key, SMTP password) + verifier + pending.
    expect(dry.rotated).toBe(2 * 5 + 2);
    const untouched = await pg.database.tenant(tenants[0]!, async (client) =>
      (await client.query<{ v: string }>('SELECT refresh_token_ciphertext AS v FROM crm_connections')).rows[0]!.v,
    );
    expect(versionOf(untouched)).toBe(1);

    const applied = await rotateSecrets(pg.database, rotating);
    expect(applied.rotated).toBe(12);
    expect((await rotateSecrets(pg.database, rotating)).rotated).toBe(0); // idempotent

    // Only the new key now: every secret still decrypts.
    const v2 = new SecretCipher(KEY_V2, 2);
    for (const tenantId of tenants) {
      const s = stores(tenantId, v2);
      expect(await s.connections.get('hubspot')).toMatchObject({ refreshToken: `refresh-${tenantId}`, accessToken: `access-${tenantId}` });
      expect((await s.settings.get('salesforce'))?.clientSecret).toBe(`secret-${tenantId}`);
      expect((await s.ai.get())?.apiKey).toBe(`sk-${tenantId}-0000000000000000`);
      expect((await s.notifications.get()).smtpPassword).toBe(`smtp-${tenantId}`);
    }
    const oauth = stores(tenants[0]!, v2).oauth;
    expect((await oauth.pending(tenants[0]!, pendingId, 'session'))?.connection.refreshToken).toBe('pending-refresh');
    expect((await oauth.consume(tenants[0]!, state, 'session', 'salesforce'))?.codeVerifier).toBe('verifier-before-rotation');
  });

  it('rejects malformed previous-key configuration and version clashes', () => {
    expect(() => parsePreviousKeys('nonsense')).toThrow(/version>:<key>/);
    expect(() => new SecretCipher(KEY_V2, 2, { 2: KEY_V1 })).toThrow(/same version/);
    expect(() => new SecretCipher('short', 1)).toThrow(/32 characters/);
  });
});
