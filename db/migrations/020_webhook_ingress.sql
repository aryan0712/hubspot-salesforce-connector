-- R12: validated, account-routed webhook ingress.
--
-- A verified delivery is persisted to the inbox BEFORE it is acknowledged; turning its
-- native events into sync jobs (object type resolution, which may need CRM metadata) is
-- done later by an initialized worker, never on the request path.

CREATE TABLE IF NOT EXISTS webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  -- Stable per vendor event: legitimate redeliveries collapse onto one row.
  delivery_id text NOT NULL,
  account_id text,
  native_object text NOT NULL,
  source_id text NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('created', 'updated', 'deleted')),
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'discarded')),
  reason text,
  attempts integer NOT NULL DEFAULT 0,
  -- Worker lease / retry backoff: a pending row is claimable once this has passed.
  available_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id, system, delivery_id)
);
CREATE INDEX IF NOT EXISTS webhook_inbox_pending_idx
  ON webhook_inbox (tenant_id, available_at) WHERE status = 'pending';

-- Salesforce sender contract v2: each (timestamp, nonce) signature is accepted once.
CREATE TABLE IF NOT EXISTS webhook_nonces (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, system, nonce)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['webhook_inbox', 'webhook_nonces']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    BEGIN
      EXECUTE format(
        'CREATE POLICY tenant_isolation_%I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
        table_name,
        table_name
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- Which workspace a CRM account (HubSpot portal id, Salesforce org id) belongs to. Global
-- by necessity: an inbound webhook names only the account. Holds no secrets and no tenant
-- data; one account may be connected to one workspace, so routing is unambiguous.
CREATE TABLE IF NOT EXISTS account_routes (
  system text NOT NULL CHECK (system IN ('salesforce', 'hubspot')),
  account_id text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (system, account_id)
);
CREATE INDEX IF NOT EXISTS account_routes_tenant_idx ON account_routes (tenant_id, system);
