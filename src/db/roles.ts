import type { PostgresDatabase } from './postgres.js';
import { logger } from '../logger.js';

/**
 * R11 database privileges. The runtime connects as a restricted role: not a superuser, no
 * BYPASSRLS, and not the owner of the schema (owners can disable row-level security).
 * Schema migrations run as a separate owner role (DATABASE_MIGRATION_URL), which grants
 * the runtime role data privileges only. See docs/SECURITY_MODEL.md.
 */
export interface RuntimeRoleInfo {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  /** Tables in the public schema owned by the runtime role. */
  ownedTables: number;
}

export async function inspectRuntimeRole(db: PostgresDatabase): Promise<RuntimeRoleInfo> {
  const result = await db.pool.query<{ role: string; superuser: boolean; bypass: boolean; owned: string }>(
    `SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
            (SELECT count(*) FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = r.rolname) AS owned
     FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const row = result.rows[0]!;
  return { role: row.role, superuser: row.superuser, bypassRls: row.bypass, ownedTables: Number(row.owned) };
}

export class UnsafeDatabaseRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeDatabaseRoleError';
  }
}

/** Refuses an unsafe runtime role in production; warns about it elsewhere. */
export function assertRuntimeRole(info: RuntimeRoleInfo, production: boolean): void {
  const problems: string[] = [];
  if (info.superuser) problems.push('is a superuser');
  if (info.bypassRls) problems.push('has BYPASSRLS');
  if (info.ownedTables > 0) problems.push(`owns ${info.ownedTables} schema tables (use DATABASE_MIGRATION_URL for a separate owner)`);
  if (!problems.length) return;
  const message = `database role "${info.role}" ${problems.join(', ')}`;
  if (production) throw new UnsafeDatabaseRoleError(`${message}; refusing to start in production`);
  logger.warn({ role: info.role }, `${message}; acceptable for local development only`);
}

/** Grants a runtime role data (not schema) privileges on everything the migrations created. */
export async function grantRuntimeRole(owner: PostgresDatabase, role: string): Promise<void> {
  const client = await owner.pool.connect();
  try {
    const ident = client.escapeIdentifier(role);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ident}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ident}`);
    // Schema history is readable (startup checks) but only the owner may change it.
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${ident}`);
  } finally {
    client.release();
  }
}
