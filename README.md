# crm-sync

Commercial-grade Salesforce ⇄ HubSpot migration and real-time synchronization engine.
Migration and live sync share one canonical mapping and reconciliation core.

## What is implemented

- No-write migration previews with field diffs and ambiguous-match blocking, frozen
  approval context, drift checks before every write, and exact destination-side
  natural-key search before create
- Durable migration executions (pause/resume/retry-failed/cancel, worker-crash safe) and
  one-record canary verification before a full run unlocks
- Configurable mappings, transforms, field ownership, and value mappings
- Contacts, companies, deals, owners, pipelines, and standard associations (records-only;
  relationships sync live but are not migrated)
- Echo suppression, conflict resolution (with an inspectable/reviewable conflict log),
  idempotent event ingestion, and tombstoned deletes that late events cannot resurrect
- PostgreSQL-backed jobs, leases, retries, dead letters, replay, migration runs, durable
  executions, and audit history, with daily retention of finished operational rows
- Sessions, CSRF, role-based access (viewer/operator/admin/owner), and optional
  multi-tenant isolation with forced row-level security on every tenant table
- Session-bound OAuth with persisted single-use state and confirmation before an account
  is replaced; AES-256-GCM encryption (with versioned key rotation) for OAuth credentials,
  tokens and other stored secrets
- Verified, replay-protected inbound webhooks (HubSpot signature v3, a signed and
  nonce-protected Salesforce sender contract) persisted before acknowledgement and
  resolved into sync jobs by a worker — see [docs/WEBHOOKS.md](docs/WEBHOOKS.md)
- Liveness/readiness endpoints, Prometheus metrics, correlated logs, and operational
  alerts (stale sync, dead letters, CRM/credential failures, migration drift, webhook
  backlog) surfaced in the UI, `/metrics` and an email digest
- API-key roles, usage counters, billing/subscription schema, and governance records
- Read-only Migration Copilot for structured preflight explanations and review guidance
- Operator console at `/ops` served under a strict Content-Security-Policy (no inline
  scripts), with accessible inline error messages and real readiness/workspace identity
- Real lint (ESLint, including architectural layer boundaries), a typechecked test suite,
  and browser tests against a real Chrome/Edge (see Verification below)

## Local setup

Requirements: Node 20+. The project includes a user-local PostgreSQL binary, so Docker
and administrator access are not required.

```bash
npm install
npm run db:local
```

Leave that terminal running. In another terminal:

```bash
npm run db:migrate
npm run typecheck
npm test
npm run demo
npm run dev
```

Local development defaults to the `crm_sync` database on port 5432, creates a stable,
gitignored `data/.encryption-key` with owner-only permissions, and runs unauthenticated as
a single local owner (`AUTH_REQUIRED=false`). Hosted environments must set `DATABASE_URL`,
`APP_ENCRYPTION_KEY`, and `AUTH_REQUIRED=true` explicitly; see
[docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) for sessions, roles and multi-tenant mode,
and [docs/OPERATIONS.md](docs/OPERATIONS.md) for deployment, health checks and secrets.

Background work (sync, the webhook inbox, migrations, alert digests, retention) runs
inside `npm run dev`/`npm run start` by default; set `RUN_WORKERS=false` and run
`npm run worker` separately to scale them independently.

Open:

- `http://localhost:3000/` — connections and encrypted Migration Copilot setup
- `http://localhost:3000/ops` — previews, mappings, jobs, replay, conflicts, audit, and usage
- `http://localhost:3000/demo` — zero-credential engine demonstration
- `http://localhost:3000/health/live`, `/health/ready` — liveness and readiness
- `http://localhost:3000/metrics` — Prometheus metrics (needs `METRICS_TOKEN` once set)

## Existing local credentials

Older builds stored credentials and record links under `data/*.json`. Those files are
never modified or deleted by the PostgreSQL migration. After starting PostgreSQL and
running migrations, copy them once with:

```bash
npm run db:import-legacy -- --confirm
```

The command logs counts only; it never prints secrets. Keep the original files until the
PostgreSQL-backed connections have been verified.

## Safe migration

The API and CLI default to preview/no-write behavior.

```bash
npm run migrate -- --from salesforce --types contact,company,deal --limit 20 --dry-run
```

The CLI previews by default even when `--dry-run` is omitted. After reviewing the
preview, a real CLI write requires an explicit `--confirm`. In the operator console,
execution is also a distinct confirmed action and is blocked when schema preflight fails
or matches are ambiguous.

Never perform a live migration without confirming the target account and preview.

## PostgreSQL

Migrations live in `db/migrations/` and run as a serialized, additive release step
(`npm run db:migrate`; see [docs/OPERATIONS.md](docs/OPERATIONS.md) for the schema-owner
vs. runtime-role split). PostgreSQL stores:

- tenants, users, sessions, API keys, subscriptions, quotas, and usage
- encrypted OAuth app credentials, CRM connections, and OAuth state (including staged
  account-replacement confirmations)
- global account → workspace routing for inbound webhooks, and the webhook inbox itself
- object/field/value/owner mappings and schema snapshots
- record links, natural keys, hashes, and associations, plus tombstones for approved
  deletes and pending (not-yet-linkable) relationships
- migration plans, runs, durable executions and per-record items, and write intents
  (recovery evidence for every CRM mutation)
- sync events, attempts, leases, dead letters, and replay state
- conflicts (with field-level decisions), delete approvals, replay cursors, notification
  delivery state, and audit records

Every tenant-owned table has row-level security enabled and forced; the runtime connects
as a role with no BYPASSRLS and no schema ownership. Application queries set
`app.tenant_id` (or, at sign-in, `app.user_id`) inside a transaction. Finished operational
rows (completed jobs, processed webhook deliveries, sent notifications) are purged by a
daily retention job; audit entries, conflicts, tombstones and migration history are kept.

Admins can add or replace the OpenAI key from `/ops#settings`. It is validated before save,
encrypted with `APP_ENCRYPTION_KEY`, and never returned to the browser.

## Webhooks

- `POST /webhooks/hubspot` — verifies signature v3 (freshness, exact signature, the
  account named matches the connected portal)
- `POST /webhooks/salesforce` — verifies a signed, timestamped, single-use-nonce sender
  contract (`v2`); a legacy body-only signature is accepted in the default `compat` mode
  for existing senders

Every verified delivery is persisted to a per-workspace inbox before it is acknowledged;
a worker resolves inbox entries into sync jobs once connectors are ready. See
[docs/WEBHOOKS.md](docs/WEBHOOKS.md) for the full contract, response codes, and the
Apex snippet for the Salesforce sender.

HubSpot generic webhook configuration is provided as
`docs/HUBSPOT_WEBHOOK_COMPONENT.example.json`. Replace `YOUR_PUBLIC_HOST`, copy it into
`hubspot-app/src/app/webhooks/`, validate it, and deploy only after the backend has a
stable HTTPS URL.

Production Salesforce CDC should use the Pub/Sub API with persisted replay IDs; the
database already includes `webhook_cursors` for that worker (not yet built — deferred, see
[docs/REMEDIATION_PLAN.md](docs/REMEDIATION_PLAN.md)).

## Verification

```bash
npm run lint              # ESLint, including architectural layer boundaries
npm run typecheck         # tsc --noEmit against src/
npm run typecheck:test    # tsc --noEmit against src/ + test/
npm run scan:secrets      # tracked/new files for credentials, never prints a match
npm test                  # vitest — see current counts below
npm run demo
npm run build
npm run test:browser      # real Chrome/Edge against the HTTP app (playwright-core)
npm run audit:deps        # production dependency advisories
```

`npm test` uses mock connectors and an isolated, embedded-per-file PostgreSQL cluster —
CRM credentials, Docker, and the developer database are not required. As of this writing:
35 test files / 314 tests pass (2 load-only tests are gated behind `RUN_LOAD_TESTS=1`,
run via `npm run test:load` and `npm run test:load:webhooks`); `npm run test:browser` runs
10 further tests in a real browser. See
[docs/REMEDIATION_PLAN.md](docs/REMEDIATION_PLAN.md) for load-test throughput numbers and
[docs/RELEASE_EVIDENCE.md](docs/RELEASE_EVIDENCE.md) for a consolidated evidence summary.

See [architecture](docs/ARCHITECTURE.md), [operations](docs/OPERATIONS.md),
[security model](docs/SECURITY_MODEL.md), [webhooks](docs/WEBHOOKS.md), and
[Migration Copilot](docs/AI_COPILOT.md).

The [application review remediation plan](docs/REMEDIATION_PLAN.md) tracks prioritized
fixes and acceptance tests (R01–R12 and R14 complete; R13's core delivered — see the plan
for what remains). The broader
[production-readiness backlog](docs/PRODUCTION_READINESS.md) defines public-launch
requirements.
