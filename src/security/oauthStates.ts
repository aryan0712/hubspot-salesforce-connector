import crypto from 'node:crypto';
import type { SystemId } from '../core/types.js';
import type { Connection, Environment } from '../core/connectionStore.js';
import { sha256 } from './identity.js';

/**
 * R11 OAuth state: single-use, expiring, and bound to the session, user, tenant, system,
 * environment, redirect URI and PKCE verifier that started the flow. Persisted (not a
 * process-local map), so a callback served by another replica works and a restart does
 * not strand a flow. A reconnect that would REPLACE the connected account with a
 * different one is staged on the same row until an admin confirms it.
 */
export interface OAuthStateInput {
  tenantId: string;
  sessionHash: string;
  userId: string;
  system: SystemId;
  environment: Environment;
  redirectUri: string;
  codeVerifier: string;
}

export interface OAuthStateEntry extends OAuthStateInput {
  id: string;
}

export interface PendingConnection {
  id: string;
  system: SystemId;
  userId: string;
  sessionHash: string;
  connection: Connection;
}

export interface OAuthStateStore {
  /** Returns the opaque state value to send to the provider. */
  create(input: OAuthStateInput, ttlMs?: number): Promise<string>;
  /**
   * Atomically consumes a state. Only the same tenant, session and system, before expiry,
   * and only once; anything else returns undefined.
   */
  consume(tenantId: string, state: string, sessionHash: string, system: SystemId): Promise<OAuthStateEntry | undefined>;
  stagePending(tenantId: string, id: string, connection: Connection, ttlMs?: number): Promise<void>;
  /** A staged replacement, for the same session, not yet expired. */
  pending(tenantId: string, id: string, sessionHash: string): Promise<PendingConnection | undefined>;
  clearPending(tenantId: string, id: string): Promise<void>;
}

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export class InMemoryOAuthStateStore implements OAuthStateStore {
  private rows = new Map<
    string,
    OAuthStateEntry & {
      stateHash: string;
      expiresAt: number;
      consumed: boolean;
      pending?: { connection: Connection; expiresAt: number };
    }
  >();

  async create(input: OAuthStateInput, ttlMs = OAUTH_STATE_TTL_MS): Promise<string> {
    const state = crypto.randomBytes(24).toString('base64url');
    const id = crypto.randomUUID();
    this.rows.set(id, { ...input, id, stateHash: sha256(state), expiresAt: Date.now() + ttlMs, consumed: false });
    return state;
  }

  async consume(tenantId: string, state: string, sessionHash: string, system: SystemId) {
    const hash = sha256(state);
    for (const row of this.rows.values()) {
      if (row.stateHash !== hash) continue;
      if (
        row.consumed ||
        row.expiresAt <= Date.now() ||
        row.tenantId !== tenantId ||
        row.sessionHash !== sessionHash ||
        row.system !== system
      ) {
        return undefined;
      }
      row.consumed = true;
      const { stateHash: _h, expiresAt: _e, consumed: _c, pending: _p, ...entry } = row;
      return entry;
    }
    return undefined;
  }

  async stagePending(tenantId: string, id: string, connection: Connection, ttlMs = OAUTH_STATE_TTL_MS) {
    const row = this.rows.get(id);
    if (row && row.tenantId === tenantId) row.pending = { connection: { ...connection }, expiresAt: Date.now() + ttlMs };
  }

  async pending(tenantId: string, id: string, sessionHash: string): Promise<PendingConnection | undefined> {
    const row = this.rows.get(id);
    if (!row?.pending || row.tenantId !== tenantId || row.sessionHash !== sessionHash) return undefined;
    if (row.pending.expiresAt <= Date.now()) return undefined;
    return { id, system: row.system, userId: row.userId, sessionHash: row.sessionHash, connection: { ...row.pending.connection } };
  }

  async clearPending(tenantId: string, id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row && row.tenantId === tenantId) delete row.pending;
  }
}
