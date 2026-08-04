ALTER TABLE migration_plans
  ADD COLUMN IF NOT EXISTS canary_preview_run_id uuid REFERENCES migration_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS canary_preview_revision integer,
  ADD COLUMN IF NOT EXISTS canary_execution_run_id uuid REFERENCES migration_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS canary_object_type text
    CHECK (canary_object_type IS NULL OR canary_object_type IN ('contact', 'company', 'deal')),
  ADD COLUMN IF NOT EXISTS canary_source_id text,
  ADD COLUMN IF NOT EXISTS canary_verified_at timestamptz;
