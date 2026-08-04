CREATE TABLE IF NOT EXISTS ai_provider_credentials (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('openai')),
  api_key_ciphertext text NOT NULL,
  key_fingerprint text NOT NULL,
  model text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

ALTER TABLE ai_provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_provider_credentials FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY tenant_isolation_ai_provider_credentials ON ai_provider_credentials
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
