import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
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

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(600);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

function cleanStalePidFile(): void {
  const pidFile = path.join(databaseDir, 'postmaster.pid');
  if (!fs.existsSync(pidFile)) return;

  try {
    const content = fs.readFileSync(pidFile, 'utf8');
    const firstLine = content.split('\n')[0]?.trim();
    const pid = firstLine ? parseInt(firstLine, 10) : NaN;

    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        return;
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === 'ESRCH') {
          logger.warn({ pid }, 'removing stale postmaster.pid from previously terminated PostgreSQL process');
          fs.unlinkSync(pidFile);
        }
      }
    } else {
      logger.warn('removing corrupted postmaster.pid');
      fs.unlinkSync(pidFile);
    }
  } catch (err) {
    logger.warn({ err }, 'failed to inspect postmaster.pid');
  }
}

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
  const alreadyRunning = await isPortOpen(5432);
  if (alreadyRunning) {
    logger.info({ port: 5432, database: databaseName }, 'project-local PostgreSQL is already running');
    await ensureDatabase();
    await new Promise<void>(() => undefined);
    return;
  }

  cleanStalePidFile();

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
