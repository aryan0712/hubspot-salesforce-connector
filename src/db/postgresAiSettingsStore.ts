import crypto from 'node:crypto';
import type { PostgresDatabase } from './postgres.js';
import type { SecretCipher } from './security.js';

export interface AiProviderCredential {
  apiKey: string;
  fingerprint: string;
  model: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface AiProviderCredentialStatus {
  configured: boolean;
  fingerprint?: string;
  model: string;
  updatedAt?: string;
  updatedBy?: string;
}

export class PostgresAiSettingsStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly cipher: SecretCipher,
    private readonly tenantId: string,
  ) {}

  async get(): Promise<AiProviderCredential | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{
        api_key_ciphertext: string;
        key_fingerprint: string;
        model: string;
        updated_at: Date;
        updated_by: string | null;
      }>(
        `SELECT api_key_ciphertext, key_fingerprint, model, updated_at, updated_by
         FROM ai_provider_credentials
         WHERE tenant_id = $1 AND provider = 'openai'`,
        [this.tenantId],
      );
      const row = result.rows[0];
      return row
        ? {
            apiKey: this.cipher.decrypt(
              row.api_key_ciphertext,
              `${this.tenantId}:openai:api-key`,
            ),
            fingerprint: row.key_fingerprint,
            model: row.model,
            updatedAt: row.updated_at.toISOString(),
            updatedBy: row.updated_by ?? undefined,
          }
        : undefined;
    });
  }

  async status(defaultModel: string): Promise<AiProviderCredentialStatus> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{
        key_fingerprint: string;
        model: string;
        updated_at: Date;
        updated_by: string | null;
      }>(
        `SELECT key_fingerprint, model, updated_at, updated_by
         FROM ai_provider_credentials
         WHERE tenant_id = $1 AND provider = 'openai'`,
        [this.tenantId],
      );
      const row = result.rows[0];
      return row
        ? {
            configured: true,
            fingerprint: row.key_fingerprint,
            model: row.model,
            updatedAt: row.updated_at.toISOString(),
            updatedBy: row.updated_by ?? undefined,
          }
        : { configured: false, model: defaultModel };
    });
  }

  async set(apiKey: string, model: string, updatedBy?: string): Promise<AiProviderCredentialStatus> {
    const fingerprint = keyFingerprint(apiKey);
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO ai_provider_credentials(
           tenant_id, provider, api_key_ciphertext, key_fingerprint, model, updated_by
         ) VALUES ($1,'openai',$2,$3,$4,$5)
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           api_key_ciphertext = EXCLUDED.api_key_ciphertext,
           key_fingerprint = EXCLUDED.key_fingerprint,
           model = EXCLUDED.model,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [
          this.tenantId,
          this.cipher.encrypt(apiKey, `${this.tenantId}:openai:api-key`),
          fingerprint,
          model,
          updatedBy,
        ],
      );
    });
    return (await this.status(model));
  }

  async delete(): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `DELETE FROM ai_provider_credentials
         WHERE tenant_id = $1 AND provider = 'openai'`,
        [this.tenantId],
      );
    });
  }
}

export function keyFingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}
