import type { Env } from './env.js';
import type { DatabaseOptions } from '../db/postgres.js';

export class UnsafeDatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeDatabaseConfigError';
  }
}

/**
 * Database connection options from the environment (R14): verified TLS when enabled,
 * bounded pool, statement and lock timeouts. Unverified TLS is refused in production.
 */
export function databaseOptions(
  config: Pick<
    Env,
    | 'NODE_ENV'
    | 'DATABASE_SSL'
    | 'DATABASE_SSL_CA'
    | 'DATABASE_SSL_INSECURE'
    | 'DATABASE_POOL_MAX'
    | 'DATABASE_STATEMENT_TIMEOUT_MS'
    | 'DATABASE_LOCK_TIMEOUT_MS'
  >,
  connectionString: string,
  overrides: Partial<DatabaseOptions> = {},
): DatabaseOptions {
  if (config.DATABASE_SSL_INSECURE && config.NODE_ENV === 'production') {
    throw new UnsafeDatabaseConfigError('DATABASE_SSL_INSECURE is for local development only; refusing to start in production');
  }
  const ssl: DatabaseOptions['ssl'] =
    config.DATABASE_SSL || config.DATABASE_SSL_CA
      ? { ca: config.DATABASE_SSL_CA, insecureSkipVerify: config.DATABASE_SSL_INSECURE }
      : false;
  return {
    connectionString,
    ssl,
    max: config.DATABASE_POOL_MAX,
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: config.DATABASE_LOCK_TIMEOUT_MS,
    ...overrides,
  };
}
