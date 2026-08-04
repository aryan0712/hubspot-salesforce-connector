import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { resolveDatabaseUrl, resolveEncryptionKey } from '../config/runtimeSecrets.js';
import { logger } from '../logger.js';
import type { Connection } from '../core/connectionStore.js';
import type { AppCredentials } from '../core/settingsStore.js';
import type { Link } from '../core/idMap.js';
import type { FieldRule } from '../core/mapping.js';
import type { CanonicalType, SystemId } from '../core/types.js';
import { PostgresDatabase, runMigrations } from './postgres.js';
import { TenantRepository } from './tenantRepository.js';
import { SecretCipher } from './security.js';
import { PostgresConnectionStore } from '../core/connectionStore.js';
import { PostgresSettingsStore } from '../core/settingsStore.js';
import { PostgresIdMapStore } from './postgresIdMapStore.js';
import { PostgresMappingStore } from './postgresMappingStore.js';

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes('--confirm')) {
    throw new Error('Refusing import without --confirm (source files are read-only and retained)');
  }
  const databaseUrl = resolveDatabaseUrl(env);
  const encryptionKey = resolveEncryptionKey(env);
  const db = new PostgresDatabase({
    connectionString: databaseUrl,
    ssl: env.DATABASE_SSL,
  });
  try {
    await runMigrations(db);
    const tenant = await new TenantRepository(db).ensure(env.DEFAULT_TENANT_SLUG);
    const cipher = new SecretCipher(encryptionKey);
    const connectionStore = new PostgresConnectionStore(db, cipher, tenant.id);
    const settingsStore = new PostgresSettingsStore(db, cipher, tenant.id);
    const idMap = new PostgresIdMapStore(db, tenant.id);
    const mappingStore = new PostgresMappingStore(db, tenant.id);

    const legacySettings = await readJson<Record<SystemId, AppCredentials>>(
      path.resolve('data/settings.json'),
    );
    const legacyConnections = await readJson<Record<SystemId, Connection>>(
      path.resolve('data/connections.json'),
    );
    const legacyLinks = await readJson<Link[]>(path.resolve('data/idmap.json'));
    const legacyMappings = await readJson<
      Partial<Record<SystemId, Partial<Record<CanonicalType, FieldRule[]>>>>
    >(path.resolve('data/mappings.json'));

    let settingsCount = 0;
    let connectionCount = 0;
    let linkCount = 0;
    let mappingCount = 0;
    for (const system of ['salesforce', 'hubspot'] as const) {
      if (legacySettings?.[system]) {
        await settingsStore.set(system, legacySettings[system]);
        settingsCount += 1;
      }
      if (legacyConnections?.[system]) {
        await connectionStore.set(legacyConnections[system]);
        connectionCount += 1;
      }
      for (const type of ['contact', 'company', 'deal'] as const) {
        const rules = legacyMappings?.[system]?.[type];
        if (rules) {
          await mappingStore.set(system, type, rules);
          mappingCount += rules.length;
        }
      }
    }
    for (const link of legacyLinks ?? []) {
      await idMap.upsertLink(link);
      linkCount += 1;
    }
    logger.info(
      { settingsCount, connectionCount, linkCount, mappingCount },
      'legacy state copied to PostgreSQL; source files were not modified',
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'legacy PostgreSQL import failed');
  process.exit(1);
});
