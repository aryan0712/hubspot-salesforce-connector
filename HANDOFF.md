# crm-sync — Project Handoff & Status

**Last updated:** 2026-09-28 (bidirectional app verification and read-only live checks)
**Status:** PostgreSQL product upgrade is installed and running locally. Schema migrations
and the legacy-state import completed successfully, and the live app was verified healthy
on 2026-07-29. Extensive engine/security/operability work has since landed on the
`crm-sync-configure` branch. Read-only checks against the connected Salesforce and
HubSpot accounts ran on 2026-09-28; no live CRM records were written.

This is the single source of truth after a restart.

## Review remediation plan — updated 2026-09-24

The application review and implementation plan are tracked in
[docs/REMEDIATION_PLAN.md](docs/REMEDIATION_PLAN.md), which is the authoritative,
evidence-linked status for each package (R01–R15). As of this update: R01–R12 and R14 are
complete, and R13's core is delivered (route/module extraction, strict CSP, real
readiness, keyset pagination, conflict review UI, resumable runs, browser tests) with a
short remaining list noted in the plan. R15 (lint, CI, this document) is in progress.
It covers migration preview/source-write correctness, demo configuration isolation,
concurrent linking and execution, canary verification, retries, durable workers,
authentication/tenancy, webhook authenticity, and operational/product verification.

Typecheck, lint, the full test suite (38 files / 381 passed, 2 skipped, plus 14
real-browser tests), and build pass with the registered-object sync follow-up; see §5 for
commands. PostgreSQL TLS
certificate tests now generate certificates without an external OpenSSL executable. No
live CRM records were written and no OAuth connect flow was run. Automated scenarios use
mock connectors and isolated PostgreSQL; read-only live findings and remaining gaps are
recorded in [docs/BIDIRECTIONAL_VERIFICATION.md](docs/BIDIRECTIONAL_VERIFICATION.md) and
[docs/BIDIRECTIONAL_TEST_GAPS.md](docs/BIDIRECTIONAL_TEST_GAPS.md).

The plan also includes a **deferred next-phase feature roadmap** for assessment,
explainable plans, a migration control center, relationship migration, reconciliation,
data health, team workflows, AI assistance, and recovery. The user explicitly deferred
this feature work on 2026-09-23; do not start it automatically after remediation.

The operator subsequently requested sync for all standard and custom objects. The current
worktree removes the three-object live-sync gate for explicitly registered pairs and checks
both directions before activation. New non-default pairs start paused; jobs check object
pairing, mappings, key completeness, and read-only preflight before a write. Polling and
HubSpot webhook routing now include registered pairs beyond the original three. This is
code and mock-test coverage: no live sync configuration or connected CRM record has been
changed. The first account-specific pairs and vendor scopes still need review; see
[docs/CUSTOM_OBJECT_REMEDIATION_PLAN.md](docs/CUSTOM_OBJECT_REMEDIATION_PLAN.md).
Read-only inspection on 2026-09-29 found eight registrations. Company alone is enabled;
four other registrations have no field mappings or shared key. Do not infer those mappings
or turn on all eight without passing each pair's preflight.

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

Added under the 2026-09-24 remediation plan (R01–R14, R13 core; all verified against mock
connectors and isolated PostgreSQL, never against the live accounts in §3):

- Instance-owned configuration, frozen approval context for every migration write, drift
  checks before execution and before each write, and exact destination-side natural-key
  verification (`findByNaturalKey` on `CRMConnector`, with truncated-search detection)
- Durable migration executions: leases, a crash-safe worker, pause/resume/retry-failed/
  cancel, and one-record canary verification gating a full run
- Exclusive execution claims, persisted write intents (recovery evidence for every CRM
  mutation), and identity locks serializing concurrent linking
- Relationship propagation for live sync with retry once both ends are linked, labeled
  HubSpot associations, and unsupported-relationship reporting; tombstoned deletes that
  late/replayed events cannot resurrect, with an audited restore; an inspectable,
  manually-resolvable conflict log
- Sessions, CSRF, roles (viewer/operator/admin/owner), tenant-bound API keys, and an
  optional multi-tenant mode with per-workspace App composition and forced row-level
  security; session-bound OAuth state with confirmation before an account is replaced
- Verified, replay-protected, account-routed inbound webhooks persisted to an inbox before
  acknowledgement and resolved by a worker (HubSpot signature v3; a signed, nonce-protected
  Salesforce sender contract, `docs/WEBHOOKS.md`)
- A strict-CSP operator console (no inline scripts/handlers), accessible inline error
  messages with correlation ids, real readiness/workspace identity, keyset pagination, a
  conflict-review UI, and resumable-run controls
- Verified TLS, pooled timeouts, serialized release migrations, versioned secret-key
  rotation, persisted notification delivery state, daily data retention, correlated logs,
  Prometheus metrics, operational alerts, liveness/readiness endpoints, and a Docker image
- Real lint (with architectural layer boundaries), a typechecked test suite, and browser
  tests against a real Chrome/Edge

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

`npm run dev` runs background workers (sync, the webhook inbox, migrations, alert
digests, daily retention) in the same process by default. Set `RUN_WORKERS=false` and run
`npm run worker` separately to scale them independently; either mode is fine locally.

Verify:

- `GET http://localhost:3000/health` (legacy alias), or the more specific
  `GET http://localhost:3000/health/live` and `GET http://localhost:3000/health/ready`
- `GET http://localhost:3000/api/status` and `GET http://localhost:3000/api/readiness`
- Connections at `http://localhost:3000/`
- Migrate at `http://localhost:3000/ops#migration`
- Sync at `http://localhost:3000/ops#sync`
- Activity at `http://localhost:3000/ops#activity` (jobs, conflicts, and audit)
- Settings at `http://localhost:3000/ops#settings`

Verified on 2026-07-29 (predates the remediation-plan work in §1):

- PostgreSQL health returned OK
- Salesforce and HubSpot connections decrypted successfully
- `/api/status` reported `ready: true`
- `/ops` returned HTTP 200
- Salesforce reauthorization completed and live schema preflight checked 1,072 fields

Read-only checks on 2026-09-28: schema/list/read succeeded for all three supported objects
in both CRMs; Salesforce → HubSpot one-record previews passed; HubSpot → Salesforce was
blocked by duplicate destination natural keys and read-only company mappings. The persisted
reverse deal mapping has since been corrected in local PostgreSQL by migration `023`:
HubSpot epoch milliseconds now normalize to a canonical date-only value and Salesforce
`CloseDate` remains date-only. This mapping fix is covered by mock and isolated-PostgreSQL
tests; it has not been exercised as a live CRM write. The destination duplicate keys and
read-only company mappings remain blockers. HubSpot custom-schema discovery returned 403
for missing scope. See
[docs/BIDIRECTIONAL_VERIFICATION.md](docs/BIDIRECTIONAL_VERIFICATION.md) for the exact
direction-by-direction results. No live CRM write or reconnection was performed.

## 5. Commands

```bash
npm run lint              # ESLint (correctness + architectural layer boundaries)
npm run typecheck
npm run typecheck:test    # tsc against src/ + test/ (vitest itself does not typecheck)
npm run scan:secrets      # tracked/new files for credentials
npm test
npm run test:browser      # real Chrome/Edge against the HTTP app
npm run build
npm run demo
npm run db:local
npm run db:migrate
npm run db:import-legacy -- --confirm
npm run dev
npm run worker            # separate background-worker process
npm run secrets:rotate    # re-encrypts stored secrets under the current key (dry run by default)
npm run db:retention      # applies data retention once by hand (workers also run it daily)
```

The API and CLI both default to preview. A real API write requires `"confirm": true`;
a real CLI write requires `--confirm`. API writes also require a passing preflight.
Continue to use small limits first. Do not run `secrets:rotate -- --confirm` or
`db:retention` against this environment's real data unless asked.

## 6. PostgreSQL model

Migrations are under `db/migrations/` (currently through `022_notification_deliveries.sql`)
and run as a serialized release step (`npm run db:migrate`); see
[docs/OPERATIONS.md](docs/OPERATIONS.md) for the schema-owner vs. runtime-role split.

Core areas:

- identity/access: `tenants`, `tenant_users`, `api_keys`, `users`, `user_sessions`,
  `login_attempts` (sessions/roles are global identity tables; `tenant_users` stays
  tenant-scoped)
- secrets: `oauth_app_credentials`, `crm_connections`, `oauth_states` (persisted,
  session-bound OAuth state, including staged account-replacement confirmations)
- account routing: `account_routes` (global CRM account → workspace map for inbound
  webhooks)
- configuration: `object_mappings`, `field_mappings`, `value_mappings`,
  `owner_mappings`, `schema_snapshots`
- sync identity: `record_links`, `record_link_sides`, `record_natural_keys`,
  `record_associations`, `pending_associations`, `record_tombstones`
- operations: `migration_runs`, `migration_items`, `sync_events`, `webhook_cursors`,
  `webhook_inbox`, `webhook_nonces`, `write_intents`
- migration planning and execution: `migration_plans` with revisioned drafts and
  preview/execution links, `migration_executions`, `migration_execution_items`
- governance: `conflicts` (with field-level decisions), `deletion_requests`,
  `audit_entries`
- commercial: `subscriptions`, `usage_counters`
- AI configuration: `ai_provider_credentials`
- notifications: `notification_settings`, `notification_deliveries`,
  `notification_alert_items`

All tenant-owned tables set and enforce `app.tenant_id` via PostgreSQL RLS (`users`,
`user_sessions`, `login_attempts` and `account_routes` are the only global, non-tenant
tables, by design — see [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)).

## 7. Webhooks

Backend endpoints:

- `/webhooks/hubspot` — verifies signature v3 (exact signature against the configured
  public URI, 5-minute freshness, the delivery's portal must match the connected account)
- `/webhooks/salesforce` — verifies a signed, timestamped, single-use-nonce sender
  contract (`v2`); a legacy body-only signature keeps working in the default `compat`
  mode

Every verified delivery is persisted to a per-workspace inbox before it is acknowledged; a
worker resolves inbox entries into sync jobs once connectors are ready. Full contract,
response codes and the Apex sender snippet: [docs/WEBHOOKS.md](docs/WEBHOOKS.md).

HubSpot generic webhooks are not deployed yet because a stable public HTTPS backend URL
has not been selected. Use `docs/HUBSPOT_WEBHOOK_COMPONENT.example.json` only after
replacing `YOUR_PUBLIC_HOST`. Follow `hubspot-app/AGENTS.md`, validate, then upload/deploy.
Do not redeploy the HubSpot project unprompted. Do not expose a public webhook endpoint or
register it with either vendor unless asked.

Salesforce's signed webhook endpoint works (now with the stronger `v2` sender contract
above). The next infrastructure task remains a real Pub/Sub API CDC worker using the
existing `webhook_cursors` table for Replay IDs — still deferred, not built.

## 8. Architecture constraints

- ESM TypeScript; relative imports use `.js`.
- Connector-specific shapes stay in connectors; engines depend on core contracts only,
  never connector or database implementations; routes go through services and contracts,
  never connectors or the database directly. `eslint.config.js` enforces this layering —
  `npm run lint` fails on a violation.
- Field translation stays in `core/mapping.ts`.
- Both migration and live sync must continue through `Reconciler`.
- Logs use pino; no bare `console.log` under `src/` (`no-console` is an ESLint error there).
- Tests run against mock connectors or an isolated embedded PostgreSQL cluster, without
  credentials; `npm run typecheck:test` typechecks them (vitest itself does not).
- Never trigger live migration writes without explicit user approval.

## 9. Deferred external/deployment actions

The user explicitly deferred these for now:

1. Public HTTPS deployment and HubSpot webhook component
2. External billing-provider integration
3. Salesforce CDC/Pub/Sub worker
4. Live custom CRM object rollout

The complete prioritized production-readiness backlog and public go-live gates are in
`docs/PRODUCTION_READINESS.md`.

The migration workspace discovers and displays standard/custom object metadata. Local
mock-backed custom-object registration, strict preflight, bounded preview, canary/read-back,
and records-only execution now use the shared migration core. Live custom-object execution
and sync remain gated pending the explicit pair/key/scope decisions and vendor permissions.
No live custom CRM records were written. The remaining phases and release gates are in
[docs/CUSTOM_OBJECT_REMEDIATION_PLAN.md](docs/CUSTOM_OBJECT_REMEDIATION_PLAN.md).

If this workstation becomes a long-term environment, add automated backups for both
`data/postgres/` and `data/.encryption-key`. `docs/OPERATIONS.md` now documents a measured
restore procedure and objectives for a deployed environment, but nothing here has been
scheduled or exercised specifically for this workstation.

See `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`,
`docs/SECURITY_MODEL.md`, `docs/WEBHOOKS.md`, and `docs/REMEDIATION_PLAN.md`.
