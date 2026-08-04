# Operations guide

## Boot

1. Start project-local PostgreSQL with `npm run db:local`.
2. For local development, keep the generated `data/.encryption-key` safe. For hosted
   environments, set `DATABASE_URL` and a stable `APP_ENCRYPTION_KEY`.
3. Run `npm run db:migrate`.
4. If upgrading from the JSON build, run `npm run db:import-legacy -- --confirm`.
5. Start with `npm run dev`.
6. Check `/health`, then `/api/status`.

Never rotate `APP_ENCRYPTION_KEY` without a re-encryption procedure. Existing tokens are
authenticated with the key and cannot be recovered if it is lost.

The project-local database persists under `data/postgres/`; both it and the local key are
gitignored. Back them up together if this workstation becomes the long-term environment.

Migration Copilot is optional. Admins configure its OpenAI key from the Migration Copilot
card at `/ops#settings`; the key is validated, encrypted in PostgreSQL, and activated without
a restart. `OPENAI_API_KEY` is an optional deployment fallback. See
`docs/AI_COPILOT.md` for the data boundary and safeguards.

## Migration rollout

1. Confirm the source and target account labels.
2. Run schema preflight.
3. Optionally ask Migration Copilot to explain findings, then make any mapping changes
   manually and rerun preflight.
4. Preview a small sample.
5. Resolve ambiguous natural-key matches.
6. Review creates, updates, conflicts, and required-field warnings.
7. Execute a small confirmed run.
8. Reconcile record and relationship counts.
9. Scale the limit gradually.

The migration endpoint treats requests without `"confirm": true` as previews.

## Sync jobs

Inbound events are inserted into `sync_events` before the webhook is acknowledged.
Repeated vendor deliveries reuse the same job. Workers claim jobs using
`FOR UPDATE SKIP LOCKED`.

States:

- `queued` — ready for a worker
- `processing` — leased by a worker
- `retry` — transient failure with exponential backoff
- `manual_review` — ambiguous match or deletion requiring approval
- `dead_letter` — retry budget exhausted
- `completed` — successfully processed or intentionally ignored

Use `/ops` to inspect and replay manual-review/dead-letter jobs.

## Deletes

`DELETE_POLICY` can be:

- `manual-review` (default) — records an approval request and pauses the job
- `ignore` — records the event without deleting the destination
- `cascade` — deletes/archives the linked destination record

Use `cascade` only after validating retention and compliance requirements.

## Security

- OAuth secrets and tokens are encrypted before insertion into PostgreSQL.
- Tenant tables use forced PostgreSQL row-level security.
- Set `AUTH_REQUIRED=true` in hosted environments.
- API keys are shown once and stored as SHA-256 hashes.
- Use `viewer`, `operator`, and `admin` roles; reserve owner access for account setup.
- Put TLS in front of the service and use a managed secret store for the encryption key.

## HubSpot subscriptions

The checked-in example intentionally contains `YOUR_PUBLIC_HOST`. A public webhook URL is
an external deployment decision and must not be guessed. After choosing it:

1. Copy the example to `hubspot-app/src/app/webhooks/webhooks-hsmeta.json`.
2. Replace the placeholder with the exact HTTPS origin.
3. Add subscriptions for any custom mapped properties.
4. Run `hs project validate`.
5. Upload/deploy only after reviewing the resulting build.

## Backups

Back up PostgreSQL with point-in-time recovery. The critical tables are
`crm_connections`, `oauth_app_credentials`, `record_links`, `record_link_sides`,
`record_natural_keys`, `field_mappings`, and `sync_events`.
