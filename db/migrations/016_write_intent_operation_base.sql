-- R08: resuming a migration item looks up its earlier write intents by the item's
-- deterministic operation base ("mig:<preview>:<type>:<sourceId>"). A plain indexed column
-- keeps that lookup an index scan on every encoding and collation (text-range tricks are not).
ALTER TABLE write_intents ADD COLUMN IF NOT EXISTS operation_base text;

UPDATE write_intents
SET operation_base = array_to_string(
  (string_to_array(operation_id, ':'))[1:greatest(array_length(string_to_array(operation_id, ':'), 1) - 3, 0)],
  ':')
WHERE operation_base IS NULL AND array_length(string_to_array(operation_id, ':'), 1) > 4;

CREATE INDEX IF NOT EXISTS write_intents_operation_base_idx
  ON write_intents(tenant_id, operation_base)
  WHERE operation_base IS NOT NULL;
