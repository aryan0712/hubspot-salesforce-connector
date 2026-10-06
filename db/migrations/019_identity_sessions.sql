-- R11: authenticated, request-scoped tenancy.
--
-- Identity is global (a person may belong to several workspaces); everything a tenant
-- owns stays under tenant row-level security. The two global tables below hold no tenant
-- data: users (identity + optional local password hash) and user_sessions (looked up only
-- by the SHA-256 hash of an unguessable token).

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  -- NULL for users who sign in through an external identity provider.
  password_hash text,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  csrf_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;

-- Failed and successful sign-ins, for throttling (keyed by normalized email and by IP).
CREATE TABLE IF NOT EXISTS login_attempts (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  ip text NOT NULL,
  succeeded boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_email_idx ON login_attempts (lower(email), attempted_at DESC);
CREATE INDEX IF NOT EXISTS login_attempts_ip_idx ON login_attempts (ip, attempted_at DESC);

-- Memberships stay in tenant_users (tenant RLS). A sign-in transaction may additionally
-- see the signed-in user's own memberships across workspaces (app.user_id), and nothing else.
DO $$
BEGIN
  CREATE POLICY tenant_users_self ON tenant_users FOR SELECT
    USING (user_id = nullif(current_setting('app.user_id', true), ''));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Single-use, expiring OAuth state bound to the session, user, tenant, system,
-- environment, redirect URI and PKCE verifier. A replacement of a connected account is
-- staged here (encrypted) until an admin confirms it.
CREATE TABLE IF NOT EXISTS oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  session_hash text NOT NULL,
  user_id text NOT NULL,
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  environment text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  redirect_uri text NOT NULL,
  code_verifier_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  pending_connection_ciphertext text,
  pending_account_id text,
  pending_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  CREATE POLICY tenant_isolation_oauth_states ON oauth_states
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- The exact connected account (Salesforce org id, HubSpot portal id) so a reconnect to a
-- different account is detected and confirmed before it replaces the current one.
ALTER TABLE crm_connections ADD COLUMN IF NOT EXISTS account_id text;
