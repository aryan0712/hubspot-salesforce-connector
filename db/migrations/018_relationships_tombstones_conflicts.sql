-- R10: durable relationship, deletion and conflict recovery.

-- 1. Relationships whose related record is not linked yet are persisted and retried when it
--    is (a contact synced before its company gains the relationship without a new edit).
--    Relationships the destination cannot represent are kept as 'unsupported' for reporting.
CREATE TABLE IF NOT EXISTS pending_associations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  from_type text NOT NULL,
  from_source_id text NOT NULL,
  to_type text NOT NULL,
  to_source_id text NOT NULL,
  kind text NOT NULL,
  label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved', 'unsupported', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, system, from_type, from_source_id, to_type, to_source_id, kind, label)
);

CREATE INDEX IF NOT EXISTS pending_associations_to_idx
  ON pending_associations(tenant_id, system, to_type, to_source_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS pending_associations_from_idx
  ON pending_associations(tenant_id, system, from_type, from_source_id) WHERE status = 'pending';

-- 2. Tombstones: an approved (or policy-driven) delete marks the link deleted, with who
--    approved it. Delayed events, replays and later migrations must not recreate it; an
--    explicit restore (audited) lifts the tombstone.
CREATE TABLE IF NOT EXISTS record_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  link_id uuid NOT NULL,
  object_type text NOT NULL,
  deleted_system text NOT NULL,
  deleted_source_id text NOT NULL,
  target_system text NOT NULL,
  target_id text,
  policy text NOT NULL,
  approved_by text,
  sync_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz,
  restored_by text
);

CREATE UNIQUE INDEX IF NOT EXISTS record_tombstones_active_idx
  ON record_tombstones(tenant_id, link_id) WHERE restored_at IS NULL;

-- 3. Conflicts keep the field-level decision and whether it was automatic or an operator's
--    deliberate resolution.
ALTER TABLE conflicts
  ADD COLUMN IF NOT EXISTS decision jsonb,
  ADD COLUMN IF NOT EXISTS resolution_source text NOT NULL DEFAULT 'automatic';

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['pending_associations', 'record_tombstones'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    BEGIN
      EXECUTE format(
        'CREATE POLICY tenant_isolation_%I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
        table_name, table_name);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;
