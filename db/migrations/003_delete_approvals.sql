ALTER TABLE deletion_requests
  ADD COLUMN IF NOT EXISTS sync_event_id uuid REFERENCES sync_events(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS deletion_requests_sync_event_idx
  ON deletion_requests (tenant_id, sync_event_id)
  WHERE sync_event_id IS NOT NULL;
