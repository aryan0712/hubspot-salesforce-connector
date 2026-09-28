-- R02: a migration preview freezes the exact write it approves.
--
-- Each preview item now stores its full reconcile plan (target identity, action, conflict
-- decision, exact native payload, and source/target fingerprints) so execution consumes
-- the reviewed plan instead of re-deriving it. `position` gives items a stable order
-- (created_at alone ties within one transaction). Legacy rows keep plan = NULL and are
-- rejected at execution time: they must be re-previewed.
ALTER TABLE migration_items
  ADD COLUMN IF NOT EXISTS plan jsonb,
  ADD COLUMN IF NOT EXISTS position integer;

CREATE INDEX IF NOT EXISTS migration_items_run_position_idx
  ON migration_items(tenant_id, run_id, position);
