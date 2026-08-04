import type { SystemId } from './types.js';
import type { PostgresDatabase } from '../db/postgres.js';
import type { SecretCipher } from '../db/security.js';

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
}

export interface SettingsStore {
  get(system: SystemId): Promise<AppCredentials | undefined>;
  set(system: SystemId, creds: AppCredentials): Promise<void>;
  delete(system: SystemId): Promise<void>;
}

export class PostgresSettingsStore implements SettingsStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly cipher: SecretCipher,
    private readonly tenantId: string,
  ) {}

  async get(system: SystemId): Promise<AppCredentials | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{
        client_id: string;
        client_secret_ciphertext: string;
      }>(
        `SELECT client_id, client_secret_ciphertext
         FROM oauth_app_credentials WHERE tenant_id = $1 AND system = $2`,
        [this.tenantId, system],
      );
      const row = result.rows[0];
      return row
        ? {
            clientId: row.client_id,
            clientSecret: this.cipher.decrypt(
              row.client_secret_ciphertext,
              `${this.tenantId}:${system}:client-secret`,
            ),
          }
        : undefined;
    });
  }

  async set(system: SystemId, creds: AppCredentials): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO oauth_app_credentials(
           tenant_id, system, client_id, client_secret_ciphertext
         ) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, system) DO UPDATE SET
           client_id = EXCLUDED.client_id,
           client_secret_ciphertext = EXCLUDED.client_secret_ciphertext,
           updated_at = now()`,
        [
          this.tenantId,
          system,
          creds.clientId,
          this.cipher.encrypt(
            creds.clientSecret,
            `${this.tenantId}:${system}:client-secret`,
          ),
        ],
      );
    });
  }

  async delete(system: SystemId): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        'DELETE FROM oauth_app_credentials WHERE tenant_id = $1 AND system = $2',
        [this.tenantId, system],
      );
    });
  }
}

let active: SettingsStore | undefined;

export function configureSettingsStore(store: SettingsStore): void {
  active = store;
}

function store(): SettingsStore {
  if (!active) throw new Error('settings store has not been configured');
  return active;
}

export const settings: SettingsStore = {
  get: (system) => store().get(system),
  set: (system, creds) => store().set(system, creds),
  delete: (system) => store().delete(system),
};
