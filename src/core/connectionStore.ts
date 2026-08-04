import type { SystemId } from './types.js';
import type { PostgresDatabase } from '../db/postgres.js';
import type { SecretCipher } from '../db/security.js';

export type Environment = 'production' | 'sandbox';

export interface Connection {
  system: SystemId;
  environment: Environment;
  refreshToken: string;
  instanceUrl?: string;
  accountLabel?: string;
  accessToken?: string;
  expiresAt?: number;
  connectedAt: string;
}

export interface ConnectionStore {
  get(system: SystemId): Promise<Connection | undefined>;
  set(conn: Connection): Promise<void>;
  update(system: SystemId, patch: Partial<Connection>): Promise<void>;
  delete(system: SystemId): Promise<void>;
  all(): Promise<Connection[]>;
}

export class PostgresConnectionStore implements ConnectionStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly cipher: SecretCipher,
    private readonly tenantId: string,
  ) {}

  async get(system: SystemId): Promise<Connection | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{
        system: SystemId;
        environment: Environment;
        refresh_token_ciphertext: string;
        access_token_ciphertext: string | null;
        instance_url: string | null;
        account_label: string | null;
        expires_at: Date | null;
        connected_at: Date;
      }>(
        `SELECT system, environment, refresh_token_ciphertext, access_token_ciphertext,
                instance_url, account_label, expires_at, connected_at
         FROM crm_connections WHERE tenant_id = $1 AND system = $2`,
        [this.tenantId, system],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        system: row.system,
        environment: row.environment,
        refreshToken: this.cipher.decrypt(
          row.refresh_token_ciphertext,
          `${this.tenantId}:${system}:refresh`,
        ),
        accessToken: row.access_token_ciphertext
          ? this.cipher.decrypt(
              row.access_token_ciphertext,
              `${this.tenantId}:${system}:access`,
            )
          : undefined,
        instanceUrl: row.instance_url ?? undefined,
        accountLabel: row.account_label ?? undefined,
        expiresAt: row.expires_at?.getTime(),
        connectedAt: row.connected_at.toISOString(),
      };
    });
  }

  async set(conn: Connection): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO crm_connections(
           tenant_id, system, environment, refresh_token_ciphertext,
           access_token_ciphertext, instance_url, account_label, expires_at, connected_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id, system) DO UPDATE SET
           environment = EXCLUDED.environment,
           refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
           access_token_ciphertext = EXCLUDED.access_token_ciphertext,
           instance_url = EXCLUDED.instance_url,
           account_label = EXCLUDED.account_label,
           expires_at = EXCLUDED.expires_at,
           connected_at = EXCLUDED.connected_at,
           updated_at = now()`,
        [
          this.tenantId,
          conn.system,
          conn.environment,
          this.cipher.encrypt(
            conn.refreshToken,
            `${this.tenantId}:${conn.system}:refresh`,
          ),
          conn.accessToken
            ? this.cipher.encrypt(
                conn.accessToken,
                `${this.tenantId}:${conn.system}:access`,
              )
            : null,
          conn.instanceUrl ?? null,
          conn.accountLabel ?? null,
          conn.expiresAt ? new Date(conn.expiresAt) : null,
          conn.connectedAt,
        ],
      );
    });
  }

  async update(system: SystemId, patch: Partial<Connection>): Promise<void> {
    const current = await this.get(system);
    if (current) await this.set({ ...current, ...patch, system });
  }

  async delete(system: SystemId): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        'DELETE FROM crm_connections WHERE tenant_id = $1 AND system = $2',
        [this.tenantId, system],
      );
    });
  }

  async all(): Promise<Connection[]> {
    const values = await Promise.all(
      (['salesforce', 'hubspot'] as const).map((system) => this.get(system)),
    );
    return values.filter((value): value is Connection => Boolean(value));
  }
}

let active: ConnectionStore | undefined;

export function configureConnectionStore(store: ConnectionStore): void {
  active = store;
}

function store(): ConnectionStore {
  if (!active) throw new Error('connection store has not been configured');
  return active;
}

export const connections: ConnectionStore = {
  get: (system) => store().get(system),
  set: (connection) => store().set(connection),
  update: (system, patch) => store().update(system, patch),
  delete: (system) => store().delete(system),
  all: () => store().all(),
};
