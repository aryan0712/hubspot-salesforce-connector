# crm-sync

Commercial-grade Salesforce ⇄ HubSpot migration and real-time synchronization engine.
Migration and live sync share one canonical mapping and reconciliation core.

## What is implemented

- No-write migration previews with field diffs and ambiguous-match blocking
- Destination-side natural-key search before create
- Configurable mappings, transforms, field ownership, and value mappings
- Contacts, companies, deals, owners, pipelines, and standard associations
- Echo suppression, conflict resolution, idempotent event ingestion
- PostgreSQL-backed jobs, retries, dead letters, replay, migration runs, and audit history
- Tenant-scoped PostgreSQL schema with forced row-level security
- AES-256-GCM encryption for OAuth credentials and tokens
- API-key roles, usage counters, billing/subscription schema, and governance records
- Read-only Migration Copilot for structured preflight explanations and review guidance
- Operator console at `/ops`

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

Local development defaults to the `crm_sync` database on port 5432 and creates a stable,
gitignored `data/.encryption-key` with owner-only permissions. Hosted environments must
set `DATABASE_URL` and `APP_ENCRYPTION_KEY` explicitly.

Open:

- `http://localhost:3000/` — connections and encrypted Migration Copilot setup
- `http://localhost:3000/ops` — previews, mappings, jobs, replay, audit, and usage
- `http://localhost:3000/demo` — zero-credential engine demonstration

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

Migrations live in `db/migrations/`. PostgreSQL stores:

- tenants, users, API keys, subscriptions, quotas, and usage
- encrypted OAuth app credentials and CRM connections
- object/field/value/owner mappings and schema snapshots
- record links, natural keys, hashes, and associations
- migration runs and per-record plans
- sync events, attempts, leases, dead letters, and replay state
- conflicts, delete approvals, replay cursors, and audit records

Every tenant-owned table has row-level security enabled and forced. Application queries
set `app.tenant_id` inside a transaction.

Admins can add or replace the OpenAI key from `/ops#settings`. It is validated before save,
encrypted with `APP_ENCRYPTION_KEY`, and never returned to the browser.

## Webhooks

- `POST /webhooks/hubspot`
- `POST /webhooks/salesforce`

HubSpot generic webhook configuration is provided as
`docs/HUBSPOT_WEBHOOK_COMPONENT.example.json`. Replace `YOUR_PUBLIC_HOST`, copy it into
`hubspot-app/src/app/webhooks/`, validate it, and deploy only after the backend has a
stable HTTPS URL.

Salesforce can currently deliver normalized events to the Salesforce webhook endpoint.
Production CDC should use Salesforce Pub/Sub API with persisted replay IDs; the database
already includes `webhook_cursors` for that worker.

## Verification

```bash
npm run typecheck
npm test
npm run demo
npm run build
```

Tests use mock connectors and an isolated project-local PostgreSQL process, so CRM
credentials, Docker, and the developer database are not required.

See [architecture](docs/ARCHITECTURE.md), [operations](docs/OPERATIONS.md), and
[Migration Copilot](docs/AI_COPILOT.md).

The [application review remediation plan](docs/REMEDIATION_PLAN.md) tracks prioritized
fixes and acceptance tests. The broader [production-readiness backlog](docs/PRODUCTION_READINESS.md)
defines public-launch requirements.
