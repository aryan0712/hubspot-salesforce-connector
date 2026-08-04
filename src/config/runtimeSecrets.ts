import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Env } from './env.js';

const LOCAL_DATABASE_URL =
  'postgresql://crm_sync:local-development-only@localhost:5432/crm_sync';

type RuntimeSecretEnv = Pick<
  Env,
  'NODE_ENV' | 'DATABASE_URL' | 'APP_ENCRYPTION_KEY' | 'APP_ENCRYPTION_KEY_FILE'
>;

export function resolveDatabaseUrl(config: RuntimeSecretEnv): string {
  if (config.DATABASE_URL) return config.DATABASE_URL;
  if (config.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production');
  }
  return LOCAL_DATABASE_URL;
}

function readKey(file: string): string {
  const value = fs.readFileSync(file, 'utf8').trim();
  if (value.length < 32) {
    throw new Error(`Local encryption key in ${file} must contain at least 32 characters`);
  }
  return value;
}

export function resolveEncryptionKey(config: RuntimeSecretEnv): string {
  if (config.APP_ENCRYPTION_KEY) return config.APP_ENCRYPTION_KEY;
  if (config.NODE_ENV === 'production') {
    throw new Error('APP_ENCRYPTION_KEY is required in production');
  }

  const file = path.resolve(config.APP_ENCRYPTION_KEY_FILE);
  try {
    return readKey(file);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const generated = crypto.randomBytes(48).toString('base64url');
  try {
    fs.writeFileSync(file, `${generated}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return generated;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return readKey(file);
  }
}
