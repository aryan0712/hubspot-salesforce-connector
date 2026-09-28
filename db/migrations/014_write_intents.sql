-- R06: persisted write intents.
--
-- Every CRM mutation made by the reconciler is recorded here BEFORE the vendor call, so a
-- crash, lost response or database failure after the vendor accepted the write can be
-- recovered without blindly repeating a create. Status lifecycle:
--   pending   -> the vendor call is about to happen (or happened with an unknown outcome)
--   applied   -> the vendor confirmed the write (target id known); link not yet committed
--   committed -> the id map reflects the write; nothing left to recover
--   uncertain -> the vendor call's outcome is unknown (timeout / lost response / 5xx)
--   abandoned -> proven not applied (vendor rejected it, or lookup found nothing after the
--                search-visibility window); a new write may be attempted
--   review    -> recovery could not decide; an operator must resolve it
CREATE TABLE IF NOT EXISTS write_intents (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  link_id uuid NOT NULL,
  object_type text NOT NULL,
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  operation text NOT NULL CHECK (operation IN ('create', 'update')),
  source_system text NOT NULL CHECK (source_system IN ('salesforce', 'hubspot')),
  source_id text NOT NULL,
  target_id text,
  natural_key text,
  fields jsonb NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'committed', 'uncertain', 'abandoned', 'review')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);

CREATE INDEX IF NOT EXISTS write_intents_unresolved_source_idx
  ON write_intents(tenant_id, object_type, source_system, source_id)
  WHERE status IN ('pending', 'applied', 'uncertain', 'review');

CREATE INDEX IF NOT EXISTS write_intents_unresolved_link_idx
  ON write_intents(tenant_id, link_id)
  WHERE status IN ('pending', 'applied', 'uncertain', 'review');

ALTER TABLE write_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE write_intents FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY tenant_isolation_write_intents ON write_intents
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
