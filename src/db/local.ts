import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { logger } from '../logger.js';

const databaseDir = path.resolve('data/postgres');
const databaseName = 'crm_sync';

const postgres = new EmbeddedPostgres({
  databaseDir,
  user: 'crm_sync',
  password: 'local-development-only',
  port: 5432,
  persistent: true,
  authMethod: 'scram-sha-256',
  onLog: (message) => logger.debug({ postgres: message.trim() }, 'local PostgreSQL'),
  onError: (err) => logger.error({ err }, 'local PostgreSQL error'),
});

async function ensureDatabase(): Promise<void> {
  const client = postgres.getPgClient();
  await client.connect();
  try {
    const result = await client.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [databaseName],
    );
    if (!result.rows[0]?.exists) {
      // Explicit UTF8 + template0: the cluster's default template1 encoding follows the OS
      // codepage (WIN1252 on typical Windows setups), which silently rejects field labels or
      // other CRM text containing characters outside that codepage.
      await client.query(
        `CREATE DATABASE ${client.escapeIdentifier(databaseName)}
         ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
      );
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(databaseDir, 'PG_VERSION'))) {
    await postgres.initialise();
  }
  await postgres.start();
  await ensureDatabase();
  logger.info(
    { port: 5432, database: databaseName },
    'project-local PostgreSQL is ready; stop with Ctrl+C',
  );
  await new Promise<void>(() => undefined);
}

main().catch((err) => {
  logger.fatal({ err }, 'project-local PostgreSQL failed');
  process.exit(1);
});
