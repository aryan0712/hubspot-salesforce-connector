-- Opens the object model: canonical objects are no longer limited to contact/company/deal.
-- object_mappings already stored salesforce_object/hubspot_object per row; this migration adds
-- a display label and lifts the one remaining 3-value CHECK. The literal seed data below
-- mirrors src/core/defaultObjects.ts exactly (kept in sync by hand — SQL can't import TS) so
-- existing tenants keep their current contact/company/deal mappings unchanged.

ALTER TABLE object_mappings ADD COLUMN IF NOT EXISTS label text;
UPDATE object_mappings SET label = initcap(canonical_object) WHERE label IS NULL;
ALTER TABLE object_mappings ALTER COLUMN label SET NOT NULL;

ALTER TABLE migration_plans DROP CONSTRAINT IF EXISTS migration_plans_canary_object_type_check;

-- Seed the three built-in canonical objects for every existing tenant.
INSERT INTO object_mappings (tenant_id, canonical_object, label, salesforce_object, hubspot_object, natural_key_fields)
SELECT id, 'contact', 'Contact', 'Contact', 'contacts', ARRAY['email']
FROM tenants
ON CONFLICT (tenant_id, canonical_object) DO NOTHING;

INSERT INTO object_mappings (tenant_id, canonical_object, label, salesforce_object, hubspot_object, natural_key_fields)
SELECT id, 'company', 'Company', 'Account', 'companies', ARRAY['domain']
FROM tenants
ON CONFLICT (tenant_id, canonical_object) DO NOTHING;

INSERT INTO object_mappings (tenant_id, canonical_object, label, salesforce_object, hubspot_object, natural_key_fields)
SELECT id, 'deal', 'Deal', 'Opportunity', 'deals', ARRAY['name', 'closeDate']
FROM tenants
ON CONFLICT (tenant_id, canonical_object) DO NOTHING;

-- Mark those three objects "configured" on both sides (field_mapping_sets gates that flag).
INSERT INTO field_mapping_sets (tenant_id, system, object_type)
SELECT id, v.system, v.object_type
FROM tenants
CROSS JOIN (VALUES
  ('salesforce', 'contact'), ('hubspot', 'contact'),
  ('salesforce', 'company'), ('hubspot', 'company'),
  ('salesforce', 'deal'), ('hubspot', 'deal')
) AS v(system, object_type)
ON CONFLICT DO NOTHING;

-- Seed the default field mappings themselves (identical to the removed core/mapping.ts tables).
INSERT INTO field_mappings (
  tenant_id, system, object_type, canonical_field, native_field, to_canonical_transform, read_only, sort_order
)
SELECT id, v.system, v.object_type, v.canonical_field, v.native_field, v.to_canonical_transform, v.read_only, v.sort_order
FROM tenants
CROSS JOIN (VALUES
  -- salesforce / contact
  ('salesforce', 'contact', 'firstName', 'FirstName', NULL, false, 0),
  ('salesforce', 'contact', 'lastName', 'LastName', NULL, false, 1),
  ('salesforce', 'contact', 'email', 'Email', NULL, false, 2),
  ('salesforce', 'contact', 'phone', 'Phone', NULL, false, 3),
  ('salesforce', 'contact', 'title', 'Title', NULL, false, 4),
  ('salesforce', 'contact', 'ownerId', 'OwnerId', NULL, false, 5),
  ('salesforce', 'contact', 'companyName', 'Account.Name', NULL, true, 6),
  -- hubspot / contact
  ('hubspot', 'contact', 'firstName', 'firstname', NULL, false, 0),
  ('hubspot', 'contact', 'lastName', 'lastname', NULL, false, 1),
  ('hubspot', 'contact', 'email', 'email', NULL, false, 2),
  ('hubspot', 'contact', 'phone', 'phone', NULL, false, 3),
  ('hubspot', 'contact', 'title', 'jobtitle', NULL, false, 4),
  ('hubspot', 'contact', 'companyName', 'company', NULL, false, 5),
  ('hubspot', 'contact', 'ownerId', 'hubspot_owner_id', NULL, false, 6),
  -- salesforce / company
  ('salesforce', 'company', 'name', 'Name', NULL, false, 0),
  ('salesforce', 'company', 'domain', 'Website', 'domain', false, 1),
  ('salesforce', 'company', 'phone', 'Phone', NULL, false, 2),
  ('salesforce', 'company', 'industry', 'Industry', NULL, false, 3),
  ('salesforce', 'company', 'employeeCount', 'NumberOfEmployees', NULL, false, 4),
  ('salesforce', 'company', 'ownerId', 'OwnerId', NULL, false, 5),
  -- hubspot / company
  ('hubspot', 'company', 'name', 'name', NULL, false, 0),
  ('hubspot', 'company', 'domain', 'domain', 'domain', false, 1),
  ('hubspot', 'company', 'phone', 'phone', NULL, false, 2),
  ('hubspot', 'company', 'industry', 'industry', NULL, false, 3),
  ('hubspot', 'company', 'employeeCount', 'numberofemployees', NULL, false, 4),
  ('hubspot', 'company', 'ownerId', 'hubspot_owner_id', NULL, false, 5),
  -- salesforce / deal
  ('salesforce', 'deal', 'name', 'Name', NULL, false, 0),
  ('salesforce', 'deal', 'amount', 'Amount', NULL, false, 1),
  ('salesforce', 'deal', 'stage', 'StageName', 'lowercase', false, 2),
  ('salesforce', 'deal', 'closeDate', 'CloseDate', NULL, false, 3),
  ('salesforce', 'deal', 'pipeline', 'RecordTypeId', NULL, true, 4),
  ('salesforce', 'deal', 'ownerId', 'OwnerId', NULL, false, 5),
  -- hubspot / deal
  ('hubspot', 'deal', 'name', 'dealname', NULL, false, 0),
  ('hubspot', 'deal', 'amount', 'amount', NULL, false, 1),
  ('hubspot', 'deal', 'stage', 'dealstage', 'lowercase', false, 2),
  ('hubspot', 'deal', 'closeDate', 'closedate', NULL, false, 3),
  ('hubspot', 'deal', 'pipeline', 'pipeline', NULL, false, 4),
  ('hubspot', 'deal', 'ownerId', 'hubspot_owner_id', NULL, false, 5)
) AS v(system, object_type, canonical_field, native_field, to_canonical_transform, read_only, sort_order)
ON CONFLICT (tenant_id, system, object_type, canonical_field) DO NOTHING;
