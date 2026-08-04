CREATE TABLE IF NOT EXISTS migration_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_system text NOT NULL CHECK (source_system IN ('salesforce', 'hubspot')),
  object_types text[] NOT NULL,
  limit_per_type integer CHECK (limit_per_type IS NULL OR limit_per_type > 0),
  include_associations boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'validated', 'previewed', 'executing', 'completed', 'failed')),
  revision integer NOT NULL DEFAULT 1,
  schema_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview_run_id uuid REFERENCES migration_runs(id) ON DELETE SET NULL,
  preview_revision integer,
  execution_run_id uuid REFERENCES migration_runs(id) ON DELETE SET NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS migration_plans_tenant_updated_idx
  ON migration_plans(tenant_id, updated_at DESC);

ALTER TABLE migration_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_plans FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY tenant_isolation_migration_plans ON migration_plans
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
