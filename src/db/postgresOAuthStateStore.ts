import crypto from 'node:crypto';
import type { SystemId } from '../core/types.js';
import type { Connection, Environment } from '../core/connectionStore.js';
import type { PostgresDatabase } from './postgres.js';
import type { SecretCipher } from './security.js';
import { sha256 } from '../security/identity.js';
import {
  OAUTH_STATE_TTL_MS,
  type OAuthStateEntry,
  type OAuthStateInput,
  type OAuthStateStore,
  type PendingConnection,
} from '../security/oauthStates.js';

interface StateRow {
  id: string;
  tenant_id: string;
  session_hash: string;
  user_id: string;
  system: SystemId;
  environment: Environment;
  redirect_uri: string;
  code_verifier_ciphertext: string;
  pending_connection_ciphertext: string | null;
}

/** OAuth state under tenant RLS; the PKCE verifier and any staged tokens are encrypted. */
export class PostgresOAuthStateStore implements OAuthStateStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly cipher: SecretCipher,
  ) {}

  async create(input: OAuthStateInput, ttlMs = OAUTH_STATE_TTL_MS): Promise<string> {
    const state = crypto.randomBytes(24).toString('base64url');
    const stateHash = sha256(state);
    await this.db.tenant(input.tenantId, async (client) => {
      // Expired or consumed rows are not needed after their window; keep the table small.
      await client.query(
        `DELETE FROM oauth_states WHERE tenant_id = $1 AND expires_at < now() - interval '1 day'
           AND (pending_expires_at IS NULL OR pending_expires_at < now())`,
        [input.tenantId],
      );
      await client.query(
        `INSERT INTO oauth_states(
           tenant_id, state_hash, session_hash, user_id, system, environment, redirect_uri,
           code_verifier_ciphertext, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9::int * interval '1 millisecond'))`,
        [
          input.tenantId,
          stateHash,
          input.sessionHash,
          input.userId,
          input.system,
          input.environment,
          input.redirectUri,
          this.cipher.encrypt(input.codeVerifier, `${input.tenantId}:oauth-state:${stateHash}`),
          ttlMs,
        ],
      );
    });
    return state;
  }

  async consume(
    tenantId: string,
    state: string,
    sessionHash: string,
    system: SystemId,
  ): Promise<OAuthStateEntry | undefined> {
    const stateHash = sha256(state);
    return this.db.tenant(tenantId, async (client) => {
      const result = await client.query<StateRow>(
        `UPDATE oauth_states SET consumed_at = now()
         WHERE tenant_id = $1 AND state_hash = $2 AND session_hash = $3 AND system = $4
           AND consumed_at IS NULL AND expires_at > now()
         RETURNING *`,
        [tenantId, stateHash, sessionHash, system],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        id: row.id,
        tenantId: row.tenant_id,
        sessionHash: row.session_hash,
        userId: row.user_id,
        system: row.system,
        environment: row.environment,
        redirectUri: row.redirect_uri,
        codeVerifier: this.cipher.decrypt(row.code_verifier_ciphertext, `${tenantId}:oauth-state:${stateHash}`),
      };
    });
  }

  async stagePending(tenantId: string, id: string, connection: Connection, ttlMs = OAUTH_STATE_TTL_MS): Promise<void> {
    await this.db.tenant(tenantId, async (client) => {
      await client.query(
        `UPDATE oauth_states SET pending_connection_ciphertext = $3, pending_account_id = $4,
                pending_expires_at = now() + ($5::int * interval '1 millisecond')
         WHERE tenant_id = $1 AND id = $2`,
        [
          tenantId,
          id,
          this.cipher.encrypt(JSON.stringify(connection), `${tenantId}:oauth-pending:${id}`),
          connection.accountId ?? null,
          ttlMs,
        ],
      );
    });
  }

  async pending(tenantId: string, id: string, sessionHash: string): Promise<PendingConnection | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    return this.db.tenant(tenantId, async (client) => {
      const result = await client.query<StateRow>(
        `SELECT * FROM oauth_states
         WHERE tenant_id = $1 AND id = $2 AND session_hash = $3
           AND pending_connection_ciphertext IS NOT NULL AND pending_expires_at > now()`,
        [tenantId, id, sessionHash],
      );
      const row = result.rows[0];
      if (!row?.pending_connection_ciphertext) return undefined;
      return {
        id: row.id,
        system: row.system,
        userId: row.user_id,
        sessionHash: row.session_hash,
        connection: JSON.parse(
          this.cipher.decrypt(row.pending_connection_ciphertext, `${tenantId}:oauth-pending:${id}`),
        ) as Connection,
      };
    });
  }

  async clearPending(tenantId: string, id: string): Promise<void> {
    await this.db.tenant(tenantId, async (client) => {
      await client.query(
        `UPDATE oauth_states SET pending_connection_ciphertext = NULL, pending_account_id = NULL,
                pending_expires_at = NULL
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
    });
  }
}
