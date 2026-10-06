ALTER TABLE sync_events DROP CONSTRAINT IF EXISTS sync_events_status_check;
ALTER TABLE sync_events ADD CONSTRAINT sync_events_status_check
  CHECK (status IN ('queued', 'processing', 'retry', 'completed', 'dead_letter', 'manual_review', 'dismissed'));
