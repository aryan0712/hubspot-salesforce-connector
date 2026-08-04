CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('trial', 'active', 'suspended', 'closed')),
  plan text NOT NULL DEFAULT 'trial',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_users (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key_hash)
);

CREATE TABLE IF NOT EXISTS oauth_app_credentials (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  client_id text NOT NULL,
  client_secret_ciphertext text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, system)
);

CREATE TABLE IF NOT EXISTS crm_connections (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  environment text NOT NULL CHECK (environment IN ('production', 'sandbox')),
  refresh_token_ciphertext text NOT NULL,
  access_token_ciphertext text,
  key_version integer NOT NULL DEFAULT 1,
  instance_url text,
  account_label text,
  expires_at timestamptz,
  connected_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, system)
);

CREATE TABLE IF NOT EXISTS field_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  object_type text NOT NULL,
  canonical_field text NOT NULL,
  native_field text NOT NULL,
  to_canonical_transform text,
  from_canonical_transform text,
  read_only boolean NOT NULL DEFAULT false,
  source_of_truth text CHECK (source_of_truth IN ('salesforce', 'hubspot')),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, system, object_type, canonical_field)
);

CREATE TABLE IF NOT EXISTS record_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS record_link_sides (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES record_links(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  native_id text NOT NULL,
  content_hash text,
  source_modified_at timestamptz,
  PRIMARY KEY (tenant_id, link_id, system),
  UNIQUE (tenant_id, system, native_id)
);

CREATE TABLE IF NOT EXISTS record_natural_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type text NOT NULL,
  natural_key text NOT NULL,
  link_id uuid NOT NULL REFERENCES record_links(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_type, natural_key)
);

CREATE TABLE IF NOT EXISTS record_associations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_link_id uuid NOT NULL REFERENCES record_links(id) ON DELETE CASCADE,
  to_link_id uuid NOT NULL REFERENCES record_links(id) ON DELETE CASCADE,
  kind text NOT NULL,
  label text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_link_id, to_link_id, kind, label)
);

CREATE TABLE IF NOT EXISTS migration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_system text NOT NULL CHECK (source_system IN ('salesforce', 'hubspot')),
  mode text NOT NULL CHECK (mode IN ('preview', 'execute')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  object_types text[] NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS migration_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
  object_type text NOT NULL,
  source_id text NOT NULL,
  target_id text,
  natural_key text,
  action text NOT NULL CHECK (action IN ('create', 'update', 'match', 'skip', 'conflict', 'ambiguous', 'error')),
  field_diff jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_event_id text NOT NULL,
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  object_type text NOT NULL,
  source_id text NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('created', 'updated', 'deleted')),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'retry', 'completed', 'dead_letter', 'manual_review')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, vendor_event_id)
);

CREATE INDEX IF NOT EXISTS sync_events_ready_idx
  ON sync_events (tenant_id, status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  link_id uuid REFERENCES record_links(id) ON DELETE SET NULL,
  object_type text NOT NULL,
  source_snapshot jsonb NOT NULL,
  target_snapshot jsonb NOT NULL,
  strategy text NOT NULL,
  resolution jsonb,
  status text NOT NULL DEFAULT 'resolved'
    CHECK (status IN ('open', 'resolved', 'ignored')),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_cursors (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system text NOT NULL,
  stream_name text NOT NULL,
  replay_id text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, system, stream_name)
);

CREATE TABLE IF NOT EXISTS audit_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  correlation_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_entries_tenant_created_idx
  ON audit_entries (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric text NOT NULL,
  period_start date NOT NULL,
  quantity bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, period_start)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'manual',
  provider_customer_id text,
  provider_subscription_id text,
  plan text NOT NULL,
  status text NOT NULL,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Application queries must set SET LOCAL app.tenant_id inside a transaction.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenant_users', 'api_keys', 'oauth_app_credentials', 'crm_connections',
    'field_mappings', 'record_links', 'record_link_sides', 'record_natural_keys',
    'record_associations', 'migration_runs', 'migration_items', 'sync_events',
    'conflicts', 'webhook_cursors', 'audit_entries', 'usage_counters', 'subscriptions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name,
      table_name
    );
  END LOOP;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
