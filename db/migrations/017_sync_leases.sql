-- R09: reliable sync worker lifecycle.
--
-- Every claim gets a fresh lease token; completion, retry and review are fenced on it, so a
-- worker whose lease expired (and was taken over) can never overwrite the newer holder's
-- result. Heartbeats extend locked_at while a long reconcile runs. Changes for an object
-- whose sync is paused are deferred (kept, not discarded) and resume later.
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS deferred_reason text;

CREATE INDEX IF NOT EXISTS sync_events_processing_record_idx
  ON sync_events(tenant_id, system, object_type, source_id)
  WHERE status = 'processing';
