-- R08: migrations execute as durable jobs.
--
-- An execution's approved items are copied (set-based, never through application memory)
-- into migration_execution_items when it is claimed. Workers lease items with
-- FOR UPDATE SKIP LOCKED; a crashed worker's expired lease is re-claimed, and the item's
-- deterministic operation id lets the reconciler recognise a write that already happened
-- (R06), so completed writes are never repeated. The frozen plan copy makes the approved
-- snapshot immutable across restarts and deployments.
ALTER TABLE migration_executions DROP CONSTRAINT IF EXISTS migration_executions_status_check;
ALTER TABLE migration_executions ADD CONSTRAINT migration_executions_status_check
  CHECK (status IN ('running', 'paused', 'cancelling', 'succeeded', 'partial', 'failed', 'cancelled'));

ALTER TABLE migration_executions
  ADD COLUMN IF NOT EXISTS pause_reason text,
  ADD COLUMN IF NOT EXISTS failure_threshold integer,
  ADD COLUMN IF NOT EXISTS item_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS progress_at timestamptz;

CREATE TABLE IF NOT EXISTS migration_execution_items (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL REFERENCES migration_executions(id) ON DELETE CASCADE,
  position integer NOT NULL,
  object_type text NOT NULL,
  source_id text NOT NULL,
  plan jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'skipped', 'failed', 'uncertain', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  wrote boolean NOT NULL DEFAULT false,
  target_id text,
  lease_owner text,
  lease_expires_at timestamptz,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, execution_id, position)
);

CREATE INDEX IF NOT EXISTS migration_execution_items_claim_idx
  ON migration_execution_items(tenant_id, execution_id, status, position);

ALTER TABLE migration_execution_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_execution_items FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY tenant_isolation_migration_execution_items ON migration_execution_items
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
