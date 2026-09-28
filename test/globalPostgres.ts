import { createServer } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

/**
 * One throwaway PostgreSQL cluster for the whole test run (started lazily by the first
 * test file that needs it would race; starting it once here avoids several clusters
 * competing for CPU and ports). Each test file still gets its OWN database and restricted
 * role (see helpers/postgres.ts), so files stay isolated from each other.
 */
declare module 'vitest' {
  export interface ProvidedContext {
    postgresAdmin: { host: string; port: number; user: string; password: string };
  }
}

let cluster: EmbeddedPostgres | undefined;
let tempDir: string | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crm-sync-postgres-suite-'));
  const port = await availablePort();
  const user = 'crm_sync_test_admin';
  const password = crypto.randomBytes(24).toString('base64url');
  cluster = new EmbeddedPostgres({
    databaseDir: path.join(tempDir, 'cluster'),
    user,
    password,
    port,
    persistent: false,
    authMethod: 'scram-sha-256',
    onLog: () => undefined,
    onError: () => undefined,
  });
  await cluster.initialise();
  await cluster.start();
  project.provide('postgresAdmin', { host: 'localhost', port, user, password });
  return async () => {
    await cluster?.stop().catch(() => undefined);
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
    }
  };
}

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
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}
