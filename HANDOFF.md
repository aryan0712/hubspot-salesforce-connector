# crm-sync — Project Handoff & Status

**Last updated:** 2026-09-23 (review plan added; prior live verification remains 2026-07-29)
**Status:** PostgreSQL product upgrade is installed and running locally. Schema migrations
and the legacy-state import completed successfully, and the live app was verified healthy.

This is the single source of truth after a restart.

## Review remediation plan — 2026-09-23

The application review and implementation plan are tracked in
[docs/REMEDIATION_PLAN.md](docs/REMEDIATION_PLAN.md). Implementation under that plan has
not started. It covers migration preview/source-write correctness, demo configuration
isolation, concurrent linking and execution, canary verification, retries, durable
workers, authentication/tenancy, webhooks, and operational/product verification.

Typecheck, build, all 116 tests, and the mock demo passed during the review; isolated
probes still reproduced correctness gaps. Existing feature descriptions below describe
implemented mechanisms, not proof that the newly identified safety gaps are resolved.
No live CRM writes or connection changes were performed during the review. Follow the
new plan's delivery order alongside the broader production-readiness checklist.

The plan also includes a **deferred next-phase feature roadmap** for assessment,
explainable plans, a migration control center, relationship migration, reconciliation,
data health, team workflows, AI assistance, and recovery. The user explicitly deferred
this feature work on 2026-09-23; do not start it automatically after remediation.

## 1. Current state

The app is a Salesforce ⇄ HubSpot migration and real-time sync product. Migration and
live events share the canonical mapping/reconciliation core.

Implemented in the current worktree:

- PostgreSQL migrations and tenant-scoped repositories for all durable product state
- Forced row-level security on tenant tables
- AES-256-GCM encryption for OAuth app secrets and CRM tokens
- Destination-side natural-key search before create
- Persisted natural-key indexes across restarts
- Migration previews with actions, field diffs, warnings, and ambiguous-match blocking
- Six-step guided migration builder with autosaved plans, Back/Next navigation, live
  Salesforce/HubSpot object discovery, metadata inspection, field/value/natural-key
  mapping, schema preflight, and a compact review-first execution gate
- Persisted one-record migration canaries: operators choose a real source record, review
  its exact proposed destination action, explicitly confirm one write, and the app reads
  the destination back before unlocking preparation and execution of the full migration
- Zapier-style field mapping workspace with search/review filters, inline coverage,
  per-object navigation, reversible row removal, and bidirectional source/canonical/target
  transform configuration with live sample previews
- Five-area product navigation: focused Connections, guided Migrate, dedicated live Sync,
  combined Activity, and centralized Settings
- Migrate subnavigation separates the focused six-step Builder, Saved plans, and searchable
  Run history with status/mode filters and record-level drill-in
- Persisted live-sync policy for global conflict strategy/source of truth plus per-object
  enablement and direction; new events honor policy changes without restarting
- Dedicated webhook health and conflict/manual-review queue, consolidated sync jobs and
  audit activity, migration run drill-in, and Settings-owned Copilot/API-key/team/usage views
- Frozen preview execution: plan revisions, schema hashes, and every source record are
  rechecked before the first confirmed CRM write
- Schema preflight before confirmed execution
- Read-only Migration Copilot with structured preflight explanations, contextual workspace
  navigation, deterministic readiness enforcement, and no access to record values or writes
- Admin-only in-app OpenAI key setup with provider validation, encrypted tenant-scoped
  PostgreSQL storage, one-way fingerprints, audit events, and hot replacement without restart
- Configurable fields, transforms, field ownership, owners, pipelines, and value mappings
- Multi-object field-mapping queue with per-object coverage, filtered navigation, automatic
  save-on-switch, save-and-next, and guarded exact-match auto-mapping across selected objects
- Consistent multi-object tabs on the values step, with race-safe switching between each
  object's natural-key and picklist configuration
- Safe natural-key presets with advanced composite keys, shared-mapping validation, unstable
  metadata rejection, and sampled missing/duplicate identity checks during preflight
- Live-sync contact-company and deal-company/contact association propagation
- Durable sync jobs with idempotency, leases, retries, dead letters, manual review, replay
- Delete governance (`ignore`, `cascade`, `manual-review`)
- API-key roles, audit history, usage counters, and subscription schema
- Operator console at `/ops`
- Credential-free unit and isolated PostgreSQL integration tests, plus a passing
  end-to-end mock CRM demo
- Project-local PostgreSQL 18 for environments without Docker/admin access

## 2. Important safety/state note

The existing files under `data/` were not changed:

- `data/settings.json`
- `data/connections.json`
- `data/idmap.json`

They still contain the previously working live connection state in plaintext. They must
not be deleted, rewritten, printed, or committed.

The new live runtime intentionally requires PostgreSQL and does not silently fall back to
those files. This prevents production state from splitting between two stores.

The legacy state was copied once on 2026-07-29:

```bash
npm run db:import-legacy -- --confirm
```

The import copied 2 settings records, 2 connections, and 38 record links. It logged
counts only and left the files untouched. Do not rerun it routinely.

## 3. Accounts previously connected

- Salesforce: `untangleit2-dev-ed.develop.my.salesforce.com` (Dev Edition). It was manually
  reauthorized on 2026-07-29 after an `invalid_grant`. Refresh-token rotation is now
  persisted and refreshes are single-flight.
- HubSpot current persisted connection: test portal `crm-sync-test-dev-246893048.com`
  (portal ID 246893048)
- HubSpot production portal available: `untangle-it.com`
- HubSpot developer account: `untangleit` (243312234), region `na2`
- HubSpot app: `crm-sync`, App ID 47306846

Do not reconnect or disconnect either CRM unless explicitly asked.

## 4. Start the upgraded app

Requirements: Node 20+.

```bash
npm run db:local
```

Leave that process running. It persists the cluster under `data/postgres/`.
Local development uses the default database URL and an automatically generated,
gitignored `data/.encryption-key` with mode `0600`. Production still requires explicit
`DATABASE_URL` and `APP_ENCRYPTION_KEY`.

Then:

```bash
npm install
npm run db:migrate
npm run typecheck
npm test
npm run dev
```

Verify:

- `GET http://localhost:3000/health`
- `GET http://localhost:3000/api/status`
- Connections at `http://localhost:3000/`
- Migrate at `http://localhost:3000/ops#migration`
- Sync at `http://localhost:3000/ops#sync`
- Activity at `http://localhost:3000/ops#activity`
- Settings at `http://localhost:3000/ops#settings`

Verified on 2026-07-29:

- PostgreSQL health returned OK
- Salesforce and HubSpot connections decrypted successfully
- `/api/status` reported `ready: true`
- `/ops` returned HTTP 200
- Salesforce reauthorization completed and live schema preflight checked 1,072 fields

## 5. Commands

```bash
npm run typecheck
npm test
npm run build
npm run demo
npm run db:local
npm run db:migrate
npm run db:import-legacy -- --confirm
npm run dev
```

The API and CLI both default to preview. A real API write requires `"confirm": true`;
a real CLI write requires `--confirm`. API writes also require a passing preflight.
Continue to use small limits first.

## 6. PostgreSQL model

Migrations are under `db/migrations/`.

Core areas:

- identity/access: `tenants`, `tenant_users`, `api_keys`
- secrets: `oauth_app_credentials`, `crm_connections`
- configuration: `object_mappings`, `field_mappings`, `value_mappings`,
  `owner_mappings`, `schema_snapshots`
- sync identity: `record_links`, `record_link_sides`, `record_natural_keys`,
  `record_associations`
- operations: `migration_runs`, `migration_items`, `sync_events`, `webhook_cursors`
- migration planning: `migration_plans` with revisioned drafts and preview/execution links
- governance: `conflicts`, `deletion_requests`, `audit_entries`
- commercial: `subscriptions`, `usage_counters`
- AI configuration: `ai_provider_credentials`

All tenant-owned tables set and enforce `app.tenant_id` via PostgreSQL RLS.

## 7. Webhooks

Backend endpoints:

- `/webhooks/hubspot`
- `/webhooks/salesforce`

HubSpot generic webhooks are not deployed yet because a stable public HTTPS backend URL
has not been selected. Use `docs/HUBSPOT_WEBHOOK_COMPONENT.example.json` only after
replacing `YOUR_PUBLIC_HOST`. Follow `hubspot-app/AGENTS.md`, validate, then upload/deploy.
Do not redeploy the HubSpot project unprompted.

Salesforce’s signed webhook endpoint works. The next infrastructure task is a real Pub/Sub
API CDC worker using the existing `webhook_cursors` table for Replay IDs.

## 8. Architecture constraints

- ESM TypeScript; relative imports use `.js`.
- Connector-specific shapes stay in connectors.
- Field translation stays in `core/mapping.ts`.
- Both migration and live sync must continue through `Reconciler`.
- Logs use pino; no bare `console.log` under `src/`.
- Tests run against mock connectors without credentials.
- Never trigger live migration writes without explicit user approval.

## 9. Deferred external/deployment actions

The user explicitly deferred these for now:

1. Public HTTPS deployment and HubSpot webhook component
2. External billing-provider integration
3. Salesforce CDC/Pub/Sub worker
4. Custom CRM object support

The complete prioritized production-readiness backlog and public go-live gates are in
`docs/PRODUCTION_READINESS.md`.

The migration workspace now discovers and displays standard/custom object metadata, but
execution remains intentionally limited to the canonical Contact, Company, and Deal
objects. Migration is intentionally record-only; relationship propagation remains part
of the separate live-sync engine. Generic custom-object execution still requires the
planned dynamic canonical-object work.

If this workstation becomes a long-term environment, add automated backups for both
`data/postgres/` and `data/.encryption-key`.

See `README.md`, `docs/ARCHITECTURE.md`, and `docs/OPERATIONS.md`.
