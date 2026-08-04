CREATE TABLE IF NOT EXISTS object_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  canonical_object text NOT NULL,
  salesforce_object text,
  hubspot_object text,
  natural_key_fields text[] NOT NULL DEFAULT '{}'::text[],
  sync_direction text NOT NULL DEFAULT 'bidirectional'
    CHECK (sync_direction IN ('bidirectional', 'salesforce_to_hubspot', 'hubspot_to_salesforce')),
  filter_expression jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, canonical_object)
);

CREATE TABLE IF NOT EXISTS value_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  object_type text NOT NULL,
  canonical_field text NOT NULL,
  salesforce_value text,
  hubspot_value text,
  canonical_value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, object_type, canonical_field, canonical_value)
);

CREATE TABLE IF NOT EXISTS owner_mappings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  salesforce_owner_id text NOT NULL,
  hubspot_owner_id text NOT NULL,
  salesforce_label text,
  hubspot_label text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, salesforce_owner_id),
  UNIQUE (tenant_id, hubspot_owner_id)
);

CREATE TABLE IF NOT EXISTS schema_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  object_type text NOT NULL,
  schema_hash text NOT NULL,
  fields jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  link_id uuid REFERENCES record_links(id) ON DELETE SET NULL,
  source_system text NOT NULL,
  object_type text NOT NULL,
  source_id text NOT NULL,
  target_id text,
  policy text NOT NULL CHECK (policy IN ('ignore', 'cascade', 'manual-review')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'failed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz,
  error text
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'object_mappings', 'value_mappings', 'owner_mappings',
    'schema_snapshots', 'deletion_requests'
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
