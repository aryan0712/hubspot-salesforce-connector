# Sync gap remediation plan

**Created:** 2026-10-08  
**Status:** G1, G3, G4, G5, G6, G7, G8 implemented and verified on branch `crm-database-recover`. G2's code fix is done; its HubSpot redeploy and reconnect are operator-gated and still pending.  
**Owner:** Engineering. G2 also needs an operator decision and a manual HubSpot reauthorize.  
**Related:** [CUSTOM_OBJECT_REMEDIATION_PLAN.md](CUSTOM_OBJECT_REMEDIATION_PLAN.md), [OPERATIONS.md](OPERATIONS.md), [BIDIRECTIONAL_TEST_GAPS.md](BIDIRECTIONAL_TEST_GAPS.md).

## Objective

Merging `crm-sync-new` and `crm-sync` into `crm-sync-configure` brought in new launcher
scripts, HubSpot custom-object scopes and changes to the sync wizard and dashboard. Those
changes introduced or exposed the gaps below. The goal is to close them so that startup,
the background worker and custom-object sync stay reliable. The fixes must not weaken the
existing safeguards against duplicates, echoes and conflicts.

## Current verification baseline (2026-10-08)

| Check | Result |
|-------|--------|
| `npm run lint` | Clean |
| `npm run typecheck` / `npm run typecheck:test` | Clean |
| `npm test` | 38 files, 387 passed, 2 skipped |
| `npm run test:browser` | 13 of 14 pass. `operatorUx › explains a role restriction inline with a correlation reference` fails (G3). |
| Local run | The server crashed twice at startup with `57P03` and then `Connection terminated unexpectedly` (G1). |

## Phase 1 verification (after G1, G3, G4)

| Check | Result |
|-------|--------|
| `npm run lint` | Clean |
| `npm run typecheck` / `npm run typecheck:test` | Clean |
| `npm test` | 39 files, 393 passed, 2 skipped (added `test/postgresRetry.test.ts`, 6 tests) |
| `npm run test:browser` | 17 of 17 pass (added 3 tests: field-mapping sort-then-save, wizard enrollment grouping, concurrent-refresh guard) |

## Phase 2 + 3 verification (after G2's code fix, G5, G6, G7, G8)

| Check | Result |
|-------|--------|
| `npm run lint` | Clean |
| `npm run typecheck` / `npm run typecheck:test` | Clean |
| `npm test` | 40 files, 399 passed, 2 skipped (added `test/localPostgresLock.test.ts`, 6 tests) |
| `npm run test:browser` | 17 of 17 pass |
| `npm run scan:secrets` | 2597 files, no credentials found |

## Gap register

| ID | Gap | Missing now | Effect on syncing | Fix | Check | Priority |
|----|-----|-------------|-------------------|-----|-------|----------|
| G1 | Database not ready at startup | **Done.** Nothing retried on Postgres error `57P03` ("database system is starting up"). | The server or worker crashed at boot. If the database restarted while the app was running, queries failed and sync jobs and webhook-inbox processing stopped until a manual restart. | Added `connectWithRetry()` in [postgres.ts](../src/db/postgres.ts), used by `runMigrations`: bounded retry (10 attempts, 500ms) on `57P03`, `ECONNREFUSED`, `ECONNRESET`, and "Connection terminated unexpectedly"; fails immediately on permanent errors (bad credentials, unknown database). `startDb.mjs`/`waitForDb.mjs` port-only readiness and `stop.bat`'s force-kill are unchanged (still P2, see G5/G6 area) -- this fix is at the code level, not the launcher scripts. | `test/postgresRetry.test.ts` (6 unit tests, no DB needed): succeeds immediately, retries through transient errors then succeeds, exhausts its budget and gives up, and fails fast on permanent errors. | P0 -- **done** |
| G2 | HubSpot scope mismatch | **Code fixed; redeploy/reconnect still pending (operator-gated).** [app-hsmeta.json](../hubspot-app/src/app/app-hsmeta.json) declared 3 custom-object scopes. [auth.ts](../src/connectors/hubspot/auth.ts) requested 7, including four `sensitive`/`highly_sensitive` scopes that nothing in the connector reads or writes. | `/crm/v3/schemas` returns 403 `MISSING_SCOPES`, so custom objects can't be discovered, listed in the wizard or synced. The OAuth connect can be rejected for undeclared scopes. | Dropped the four unused sensitive/highly_sensitive scopes from `auth.ts` (least privilege; grep confirmed nothing in `src/` reads a sensitive-tier property) so both lists now name the same 3 scopes: `crm.objects.custom.read`, `crm.objects.custom.write`, `crm.schemas.custom.read`. **Still needed, and not done here:** `cd hubspot-app && hs project upload --force` to redeploy the app config, then a manual HubSpot reauthorize so the existing connection's token actually carries the custom-object scopes -- AGENTS.md reserves both of those for an explicit operator request. | Code: lint/typecheck clean, `test/customObjectMigration.test.ts` and `test/registeredObjectSync.test.ts` pass (20/20), no test asserts the old 7-scope list. End-to-end (after the operator asks for the redeploy + reconnect): listing custom-object schemas returns 200 and the custom objects appear in the sync wizard. | P0 -- code done, redeploy/reconnect pending |
| G3 | Browser test regression | **Done.** [operations.ts](../src/dashboard/operations.ts) (view switch, ~line 295) made the activity view call the combined `loadConflicts`, which also filled the hidden Sync conflicts table. | Operator UI only: the first Replay button on the page was a hidden one. | The activity view now calls `loadConflictReview()` directly. The now-unused combined `loadConflicts()` function was removed. | `npm run test:browser` passes 17 of 17, including the previously failing test. | P1 -- **done** |
| G4 | No behavior tests for the new UI | **Done.** Tests only checked that strings exist in the page HTML. Nothing covered the field-mapping sort, the wizard's "already mapped" grouping or refresh double-firing. | Inferred: the wizard picks one preferred row per source object, so a wrong grouping could enroll the wrong object pair. Sorting reorders the field list that gets saved. | Added 3 browser tests to `test/browser/operatorUx.browser.test.ts`: (1) sort the field-mapping table by each column then save, asserting the saved rule set is unchanged; (2) register two canonical objects sharing one native Salesforce object and drive the sync wizard through 0/1/2 enrolled-for-sync combinations, asserting the option list and its "already mapped to" tag; (3) call `refreshAll()` twice back to back via the in-flight guard and assert exactly one "Refreshed" notice. | All 3 new tests pass; full suite is 17 of 17. | P1 -- **done** |
| G5 | Launcher hardcodes ports | **Done.** `start.bat`, `waitAndOpen.mjs`, `startDb.mjs` and `waitForDb.mjs` assumed ports 3000 and 5432. | If `PORT` or `DATABASE_URL` changed, the launcher opened the wrong page or reused the wrong database. | [startDb.mjs](../scripts/startDb.mjs), [waitForDb.mjs](../scripts/waitForDb.mjs) and [waitAndOpen.mjs](../scripts/waitAndOpen.mjs) now load `.env` (`dotenv/config`) and parse the port from `DATABASE_URL`/`PORT`, defaulting to 5432/3000. [local.ts](../src/db/local.ts) itself now binds the embedded cluster to the port parsed from `env.DATABASE_URL` instead of a literal `5432`, so the actual listener and the readiness checks can never disagree. | Lint/typecheck clean; behavior unchanged with the default `.env` (still 3000/5432). | P2 -- **done** |
| G6 | Launcher runs the dev watcher | **Done.** `start.bat` ran `tsx watch`. | Any file change restarted the app, interrupting in-flight sync work. | [start.bat](../start.bat) now runs `tsx` without `watch`. `npm run dev` (unchanged) is still there for iterating on the code. | Reviewed the batch file; no automated test runs `.bat` files in this suite. | P2 -- **done** |
| G7 | Stale lock-file check | **Done.** [local.ts](../src/db/local.ts) treated `postmaster.pid` as live whenever its process ID existed. On Windows a reused ID can belong to an unrelated process. | The local database wouldn't start until someone deleted the file by hand. | Extracted the lock-file logic into [localLock.ts](../src/db/localLock.ts) (so it's testable without importing `local.ts`'s side-effecting `main()`). `cleanStalePidFile()` now also checks, via `tasklist` (Windows) / `/proc/<pid>/comm` (POSIX), that the live process at that PID is actually named `postgres`; otherwise it treats the lock as stale and removes it. | `test/localPostgresLock.test.ts` (6 unit tests, against a scratch temp directory, never `data/postgres/`): no lock file, PID gone, PID alive but not PostgreSQL (uses the test process's own PID), and a corrupted PID line. | P2 -- **done** |
| G8 | Tracked file still in git | **Done.** `.sf/` is now in `.gitignore`, but `.sf/.../catalog.json` was still tracked. | No runtime effect. Noise in every diff. | `git rm --cached` on the file (contents checked first: only Salesforce CLI org metadata, no secrets). | `git status` after a Salesforce CLI run no longer shows it modified. | P2 -- **done** |

## Execution order

1. **Phase 1 (code only, safe):** G1, then G3 and G4. **Done.**
2. **Phase 2 (operator-gated):** G2's code fix (aligning the scope lists) is **done**.
   Still outstanding, and intentionally not done here: `cd hubspot-app && hs project
   upload --force` to redeploy the app config, then a manual HubSpot reauthorize --
   both reserved for an explicit operator request per AGENTS.md.
3. **Phase 3 (hardening):** G5 to G8. **Done.**

After each phase, run `npm run lint`, `npm run typecheck`, `npm run typecheck:test`,
`npm test` and `npm run test:browser`. All of the above ran clean on branch
`crm-database-recover` as of 2026-10-08 (see the verification tables above).

## End-to-end sync check

1. Start the database, then `npm run dev` and `npm run worker`. Both connectors log
   `connector ready`.
2. The sync wizard lists the standard objects, plus the custom objects once G2 is done.
3. Run a dry-run migration only:
   `npm run migrate -- --from salesforce --types contact --limit 20 --dry-run`.
4. Restart Postgres while the server and worker are running. Both recover, the
   webhook inbox drains, and the dead-letter count doesn't grow.

## Safety constraints (from AGENTS.md)

- No non-dry-run migration unless the operator asks.
- No OAuth reconnect, disconnect or HubSpot redeploy unless the operator asks.
- Never read, print, rewrite or commit `data/*` secrets or `data/.encryption-key`.
- No public webhook exposure or Docker deploy as part of this work.
