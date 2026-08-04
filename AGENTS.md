# crm-sync — agent guide

Bidirectional **Salesforce ⇄ HubSpot** migration + real-time sync engine, built as a
commercial product. Differentiator: migration and live sync share **one core**.

`HANDOFF.md` is the single source of truth for current status, credentials setup, and
gotchas — read it before doing anything non-trivial. `docs/ARCHITECTURE.md` has the
full design.

## Commands

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # vitest run — 23 tests, no credentials needed
npm run demo             # end-to-end demo against in-memory mock CRMs
npm run dev              # tsx watch src/server.ts → http://localhost:3000/
npm run migrate -- --from salesforce --types contact --limit 20 --dry-run
```

Always run `npm run typecheck` and `npm test` after changing engine or core code.

## Architecture

A neutral `CanonicalRecord` sits between the two CRMs; every record goes
native → canonical → native. Migration and real-time sync share the same mapping and
reconciliation core.

```
src/core/        canonical types, connector contract, mapping, id map, conflict, pkce, stores
src/connectors/  salesforce/ · hubspot/ · mock/   (each implements CRMConnector)
src/engine/      reconciler.ts (the heart) · migrationEngine.ts · syncEngine.ts
src/dashboard/   connections.ts (entry page /) · html.ts (/demo)
src/server.ts    pages, OAuth, status/activity/migrate APIs, webhooks
src/app.ts       composition root (wires mock or live)
```

Three hard problems the engine solves — preserve these when editing:

- **Loops/echoes** — after we write to a system its webhook fires describing our own
  write. `src/core/idMap.ts` hashes canonical content per system and drops echoes.
- **Duplicates** — natural-key matching (email/domain/name) links existing records
  instead of twinning them.
- **Conflicts** — pluggable in `src/core/conflict.ts`; default last-write-wins, set via
  `CONFLICT_STRATEGY`.

Objects covered: contact ⇄ Contact, company ⇄ Account, deal ⇄ Opportunity.

## Conventions

- ESM TypeScript (`"type": "module"`), Node >= 20 — use `.js` extensions in relative imports.
- Add a new CRM by implementing `CRMConnector` in `src/core/connector.ts`; do not let
  connector-specific shapes leak into `src/engine/`.
- Field translation belongs in `src/core/mapping.ts`, not in connectors.
- Logging goes through `src/logger.ts` (pino) — no bare `console.log` in `src/`.
- Tests live in `test/` and run against the mock connector, so they need no credentials.

## State and secrets

`data/*.json` is gitignored and holds real secrets in **plaintext**:

| File | Contents |
|------|----------|
| `data/settings.json` | app OAuth client ids/secrets (entered via the browser Setup form) |
| `data/connections.json` | OAuth refresh tokens, instance URL, cached access tokens |
| `data/idmap.json` | cross-system record links + content hashes |

**Never** delete, rewrite, or commit these — `data/settings.json` is the only on-disk
copy of the app secrets, and deleting it while the server runs loses them. Never print
their contents into logs, diffs, or chat.

`.env` holds only `PORT`, `LOG_LEVEL`, `PUBLIC_BASE_URL`.

## Safety

- **Migration writes REAL records** into a live Salesforce Dev Edition org and the
  `untangle-it.com` HubSpot portal. Never trigger a non-dry-run migration unless the
  user explicitly asks. Default to `--dry-run --limit`.
- Don't re-run the OAuth connect flows or disconnect a CRM unprompted — both accounts
  are already connected and reconnecting is manual work.
- Salesforce uses an **External Client App** (Connected Apps are deprecated) and
  **requires PKCE**. HubSpot uses a Projects-platform OAuth app (App ID 47306846);
  redeploy config changes with `cd hubspot-app && hs project upload --force`.

## Known gap

Natural-key dedup only matches records **already in the id map**, not records that
pre-exist in the target CRM but were never synced — `CRMConnector` has no
`findByNaturalKey`/search method. A first migration into a portal that already holds
some of the same contacts can create duplicates. See `HANDOFF.md` §8 item 3.
