CREATE TABLE IF NOT EXISTS notification_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  alert_email text,
  smtp_host text,
  smtp_port integer,
  smtp_user text,
  smtp_password_ciphertext text,
  smtp_from text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_settings FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY tenant_isolation_notification_settings ON notification_settings
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
