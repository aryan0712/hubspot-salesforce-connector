CREATE TABLE IF NOT EXISTS field_mapping_sets (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  object_type text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, system, object_type)
);

INSERT INTO field_mapping_sets(tenant_id, system, object_type)
SELECT DISTINCT tenant_id, system, object_type
FROM field_mappings
ON CONFLICT DO NOTHING;

ALTER TABLE field_mapping_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_mapping_sets FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY tenant_isolation_field_mapping_sets ON field_mapping_sets
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
