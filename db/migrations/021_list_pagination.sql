-- R13: keyset pagination (newest first) for the sync job and audit lists.
CREATE INDEX IF NOT EXISTS sync_events_tenant_created_id_idx
  ON sync_events (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_entries_tenant_created_id_idx
  ON audit_entries (tenant_id, created_at DESC, id DESC);
