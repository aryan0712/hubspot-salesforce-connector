# crm-sync — agent guide

Bidirectional **Salesforce ⇄ HubSpot** migration + real-time sync engine, built as a
commercial product. Differentiator: migration and live sync share **one core**.

`HANDOFF.md` is the single source of truth for current status, credentials setup, and
gotchas — read it before doing anything non-trivial. `docs/ARCHITECTURE.md` has the
full design.

## Commands

```bash
npm install
npm run lint              # ESLint (correctness + architectural layer boundaries)
npm run typecheck         # tsc --noEmit against src/
npm run typecheck:test    # tsc --noEmit against src/ + test/ (vitest itself does not typecheck)
npm test                  # vitest run — 36 files / 353 tests, no credentials needed
npm run test:browser      # real Chrome/Edge against the HTTP app (playwright-core)
npm run scan:secrets      # tracked/new files for credentials
npm run demo              # end-to-end demo against in-memory mock CRMs
npm run dev               # tsx watch src/server.ts → http://localhost:3000/
npm run worker            # separate background-worker process (sync, webhooks, migrations)
npm run migrate -- --from salesforce --types contact --limit 20 --dry-run
```

Always run `npm run typecheck` and `npm test` after changing engine or core code; run
`npm run lint` and `npm run typecheck:test` too if you touched test files.

## Architecture

A neutral `CanonicalRecord` sits between the two CRMs; every record goes
native → canonical → native. Migration and real-time sync share the same mapping and
reconciliation core. `eslint.config.js` enforces the dependency direction below.

```
src/core/          canonical types, connector contract, mapping, id map, conflict, pkce, stores
src/connectors/    salesforce/ · hubspot/ · mock/   (each implements CRMConnector)
src/engine/        reconciler.ts (the heart) · migrationEngine.ts/Service.ts · syncEngine.ts ·
                    webhookInboxProcessor.ts · executionStore.ts (durable executions)
src/webhooks/      inbound signature verification, payload validation, the inbox (R12)
src/security/      sessions, CSRF, roles, runtime guard, OAuth state (R11)
src/http/          route modules, request validation, central error mapping (R13)
src/observability/ metrics, alerts, request/job log correlation (R14)
src/db/            Postgres implementations of every core/engine store contract
src/dashboard/     connections.ts (entry page /) · operations.ts (/ops) · html.ts (/demo)
src/httpApp.ts     Express app: pages, OAuth, APIs, webhooks (built by buildHttpApp)
src/server.ts      web-process entry point (listens, starts workers, graceful shutdown)
src/worker.ts      dedicated background-worker entry point (no HTTP surface)
src/app.ts         composition root (wires mock or live, single- or multi-tenant)
```

Three hard problems the engine solves — preserve these when editing:

- **Loops/echoes** — after we write to a system its webhook fires describing our own
  write. `src/core/idMap.ts` hashes canonical content per system (typed, versioned hash)
  and drops echoes.
- **Duplicates** — natural-key matching (email/domain/name) links existing records
  instead of twinning them, with exact local verification of every vendor-search candidate
  (`CRMConnector.findByNaturalKey`) so a truncated or sloppy search can't mislink one.
- **Conflicts** — pluggable in `src/core/conflict.ts`; default last-write-wins, set via
  `CONFLICT_STRATEGY`, and every automatic resolution is recorded for manual override.

Objects covered: contact ⇄ Contact, company ⇄ Account, deal ⇄ Opportunity. Migration is
records-only; relationships propagate through live sync, not migration.

## Conventions

- ESM TypeScript (`"type": "module"`), Node >= 20 — use `.js` extensions in relative imports.
- Add a new CRM by implementing `CRMConnector` in `src/core/connector.ts`; do not let
  connector-specific shapes leak into `src/engine/`. ESLint enforces this boundary.
- Field translation belongs in `src/core/mapping.ts`, not in connectors.
- Logging goes through `src/logger.ts` (pino) — no bare `console.log` in `src/`
  (`no-console` is an ESLint error there; CLIs under `src/cli/` are exempt).
- Tests live in `test/` and run against the mock connector or an isolated embedded
  PostgreSQL cluster, so they need no credentials. Browser tests live in `test/browser/`.

## State and secrets

PostgreSQL is the live store for this environment (migrated from the older JSON-file
build; see `HANDOFF.md` §2). The legacy `data/*.json` files are gitignored, hold real
secrets in **plaintext**, and are kept as an untouched historical backup:

| File | Contents |
|------|----------|
| `data/settings.json` | app OAuth client ids/secrets (pre-PostgreSQL) |
| `data/connections.json` | OAuth refresh tokens, instance URL, cached access tokens (pre-PostgreSQL) |
| `data/idmap.json` | cross-system record links + content hashes (pre-PostgreSQL) |
| `data/.encryption-key` | the local `APP_ENCRYPTION_KEY` — decrypts every secret PostgreSQL now stores |
| `data/postgres/` | the project-local PostgreSQL cluster's data directory |

**Never** delete, rewrite, or commit any of these. Losing `data/.encryption-key` (or a
production `APP_ENCRYPTION_KEY`) without first following the rotation procedure in
`docs/OPERATIONS.md` makes every stored OAuth token and secret permanently unreadable.
Never print any of their contents into logs, diffs, or chat. Never run
`npm run secrets:rotate -- --confirm` or `npm run db:retention` against this environment's
real data unless the user asks.

`.env` holds runtime configuration (ports, database/TLS settings, `AUTH_REQUIRED`,
`TENANCY_MODE`, encryption key version, webhook signing mode, and CRM app settings) — see
`.env.example` for the full, current list. This environment currently runs with
`AUTH_REQUIRED=false` (single local owner); don't turn on `AUTH_REQUIRED`/`TENANCY_MODE=multi`
or add real workspace members here without being asked.

## Safety

- **Migration writes REAL records** into a live Salesforce Dev Edition org and the
  `untangle-it.com` HubSpot portal. Never trigger a non-dry-run migration unless the
  user explicitly asks. Default to `--dry-run --limit`.
- Don't re-run the OAuth connect flows or disconnect a CRM unprompted — both accounts
  are already connected and reconnecting is manual work. A reconnect to a *different*
  account now stages behind a confirmation step (`/api/connections/:system/pending/...`);
  never confirm one unprompted.
- Salesforce uses an **External Client App** (Connected Apps are deprecated) and
  **requires PKCE**. HubSpot uses a Projects-platform OAuth app (App ID 47306846);
  redeploy config changes with `cd hubspot-app && hs project upload --force`.
- Don't expose a public webhook endpoint, register it with either vendor, or deploy the
  Docker image, unless asked — those are separate release actions the code does not take
  on its own.

## Known gap

Live custom-object migration remains gated. Sync can process a registered standard/custom
object pair after the pair, both field mappings, and a shared natural key pass preflight;
new non-default pairs start paused. Connected-account scopes and permissions still govern
which objects can actually sync. Migration is records-only; relationship propagation uses
the separate live-sync engine. See `docs/CUSTOM_OBJECT_REMEDIATION_PLAN.md`.
