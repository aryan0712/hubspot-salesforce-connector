-- R03: exclusive execution and immutable approval.
--
-- Every CRM-writing execution of an approved preview is represented by exactly one row.
-- The unique (tenant_id, preview_run_id) constraint makes the claim atomic across
-- processes: a preview can be executed at most once, so concurrent submissions, double
-- clicks and post-completion repeats find the existing execution instead of writing again.
-- A client-supplied idempotency key maps request retries to the same execution. Quota is
-- reserved in the same transaction as the claim and settled when the execution finishes.
CREATE TABLE IF NOT EXISTS migration_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  preview_run_id uuid NOT NULL REFERENCES migration_runs(id) ON DELETE RESTRICT,
  execution_run_id uuid REFERENCES migration_runs(id) ON DELETE SET NULL,
  plan_id uuid REFERENCES migration_plans(id) ON DELETE SET NULL,
  plan_revision integer,
  kind text NOT NULL CHECK (kind IN ('full', 'canary', 'batch', 'direct')),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  idempotency_key text,
  actor_id text,
  approval jsonb NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_at timestamptz NOT NULL DEFAULT now(),
  quota_metric text,
  quota_reserved bigint NOT NULL DEFAULT 0,
  quota_charged bigint,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, preview_run_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS migration_executions_idempotency_idx
  ON migration_executions(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS migration_executions_running_quota_idx
  ON migration_executions(tenant_id, quota_metric)
  WHERE status = 'running';

ALTER TABLE migration_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_executions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY tenant_isolation_migration_executions ON migration_executions
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- The execution currently holding a plan. Completion is fenced on it, so a stale or
-- duplicate worker can never finish (or re-open) another execution's plan.
ALTER TABLE migration_plans
  ADD COLUMN IF NOT EXISTS active_execution_id uuid,
  ADD COLUMN IF NOT EXISTS canary_verification jsonb;
