-- R05: identity matching integrity.
--
-- 1. Native ids are only unique within an object: HubSpot contact 123 and company 123 are
--    different records. Link sides now carry the canonical object type and are unique per
--    (system, object type, native id) instead of (system, native id).
ALTER TABLE record_link_sides ADD COLUMN IF NOT EXISTS object_type text;

UPDATE record_link_sides s
SET object_type = l.object_type
FROM record_links l
WHERE s.tenant_id = l.tenant_id AND s.link_id = l.id AND s.object_type IS NULL;

ALTER TABLE record_link_sides ALTER COLUMN object_type SET NOT NULL;

ALTER TABLE record_link_sides
  DROP CONSTRAINT IF EXISTS record_link_sides_tenant_id_system_native_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS record_link_sides_object_native_idx
  ON record_link_sides(tenant_id, system, object_type, native_id);

-- 2. Natural-key ownership is preserved and changes are tracked instead of overwritten.
--    A key has at most one CURRENT owner; a key that stops describing its record is retired
--    (kept for provenance) so a reused value can later identify a different record without
--    silently reassigning the old link.
ALTER TABLE record_natural_keys ADD COLUMN IF NOT EXISTS retired_at timestamptz;

ALTER TABLE record_natural_keys DROP CONSTRAINT IF EXISTS record_natural_keys_pkey;
ALTER TABLE record_natural_keys
  ADD CONSTRAINT record_natural_keys_pkey PRIMARY KEY (tenant_id, object_type, natural_key, link_id);

CREATE UNIQUE INDEX IF NOT EXISTS record_natural_keys_current_idx
  ON record_natural_keys(tenant_id, object_type, natural_key)
  WHERE retired_at IS NULL;

-- 3. A plan item can require an operator decision (natural-key collision, incomplete
--    destination search, or an untrustworthy vendor timestamp). Like 'ambiguous', it blocks
--    execution until resolved.
ALTER TABLE migration_items DROP CONSTRAINT IF EXISTS migration_items_action_check;
ALTER TABLE migration_items ADD CONSTRAINT migration_items_action_check
  CHECK (action IN ('create', 'update', 'match', 'skip', 'conflict', 'ambiguous', 'review', 'error'));
