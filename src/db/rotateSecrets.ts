import type { PostgresDatabase } from './postgres.js';
import type { SecretCipher } from './security.js';
import { TenantRepository } from './tenantRepository.js';

/**
 * Every encrypted column, with the authenticated context its values were encrypted under.
 * A new encrypted column must be added here (the rotation test enumerates the schema and
 * fails when a `*_ciphertext` column is missing).
 */
interface EncryptedColumn {
  table: string;
  column: string;
  /** Columns identifying the row (besides tenant_id). */
  keys: string[];
  context(tenantId: string, row: Record<string, string>): string;
}

export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  { table: 'crm_connections', column: 'refresh_token_ciphertext', keys: ['system'], context: (t, r) => `${t}:${r.system}:refresh` },
  { table: 'crm_connections', column: 'access_token_ciphertext', keys: ['system'], context: (t, r) => `${t}:${r.system}:access` },
  { table: 'oauth_app_credentials', column: 'client_secret_ciphertext', keys: ['system'], context: (t, r) => `${t}:${r.system}:client-secret` },
  { table: 'ai_provider_credentials', column: 'api_key_ciphertext', keys: ['provider'], context: (t) => `${t}:openai:api-key` },
  { table: 'notification_settings', column: 'smtp_password_ciphertext', keys: [], context: (t) => `${t}:notifications:smtp-password` },
  { table: 'oauth_states', column: 'code_verifier_ciphertext', keys: ['id', 'state_hash'], context: (t, r) => `${t}:oauth-state:${r.state_hash}` },
  { table: 'oauth_states', column: 'pending_connection_ciphertext', keys: ['id'], context: (t, r) => `${t}:oauth-pending:${r.id}` },
];

export interface RotationReport {
  /** Values re-encrypted (or, in a dry run, that would be). */
  rotated: number;
  /** Values already under the current key. */
  current: number;
  byColumn: Record<string, number>;
}

/**
 * R14: re-encrypts every stored secret under the cipher's current key. Runs per workspace
 * inside its tenant scope (row-level security applies); each value is decrypted with
 * whichever configured key it was written with and rewritten only if it changed version.
 * Idempotent: a second run rotates nothing.
 */
export async function rotateSecrets(
  db: PostgresDatabase,
  cipher: SecretCipher,
  opts: { dryRun?: boolean } = {},
): Promise<RotationReport> {
  const report: RotationReport = { rotated: 0, current: 0, byColumn: {} };
  const tenants = await new TenantRepository(db).listAll();
  for (const tenant of tenants) {
    await db.tenant(tenant.id, async (client) => {
      for (const spec of ENCRYPTED_COLUMNS) {
        const keyColumns = spec.keys.map((key) => `${key}::text AS ${key}`).join(', ');
        const rows = await client.query<Record<string, string>>(
          `SELECT ${keyColumns}${keyColumns ? ',' : ''} ${spec.column} AS value
           FROM ${spec.table} WHERE tenant_id = $1 AND ${spec.column} IS NOT NULL
           FOR UPDATE`,
          [tenant.id],
        );
        for (const row of rows.rows) {
          if (!cipher.needsRotation(row.value!)) {
            report.current += 1;
            continue;
          }
          const context = spec.context(tenant.id, row);
          const reencrypted = cipher.encrypt(cipher.decrypt(row.value!, context), context);
          report.rotated += 1;
          report.byColumn[`${spec.table}.${spec.column}`] = (report.byColumn[`${spec.table}.${spec.column}`] ?? 0) + 1;
          if (opts.dryRun) continue;
          const where = spec.keys.map((key, index) => `${key}::text = $${index + 3}`).join(' AND ');
          await client.query(
            `UPDATE ${spec.table} SET ${spec.column} = $2 WHERE tenant_id = $1${where ? ` AND ${where}` : ''}`,
            [tenant.id, reencrypted, ...spec.keys.map((key) => row[key])],
          );
        }
      }
    });
  }
  return report;
}
