# Sync gap remediation plan

**Created:** 2026-10-08  
**Status:** Phase 1 (G1, G3, G4) implemented and verified on branch `crm-database-recover`. Phase 2 (G2) and Phase 3 (G5-G8) remain open.  
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

## Gap register

| ID | Gap | Missing now | Effect on syncing | Fix | Check | Priority |
|----|-----|-------------|-------------------|-----|-------|----------|
| G1 | Database not ready at startup | **Done.** Nothing retried on Postgres error `57P03` ("database system is starting up"). | The server or worker crashed at boot. If the database restarted while the app was running, queries failed and sync jobs and webhook-inbox processing stopped until a manual restart. | Added `connectWithRetry()` in [postgres.ts](../src/db/postgres.ts), used by `runMigrations`: bounded retry (10 attempts, 500ms) on `57P03`, `ECONNREFUSED`, `ECONNRESET`, and "Connection terminated unexpectedly"; fails immediately on permanent errors (bad credentials, unknown database). `startDb.mjs`/`waitForDb.mjs` port-only readiness and `stop.bat`'s force-kill are unchanged (still P2, see G5/G6 area) -- this fix is at the code level, not the launcher scripts. | `test/postgresRetry.test.ts` (6 unit tests, no DB needed): succeeds immediately, retries through transient errors then succeeds, exhausts its budget and gives up, and fails fast on permanent errors. | P0 -- **done** |
| G2 | HubSpot scope mismatch | [app-hsmeta.json](../hubspot-app/src/app/app-hsmeta.json) declares 3 custom-object scopes. [auth.ts](../src/connectors/hubspot/auth.ts) requests 7, including four `sensitive` / `highly_sensitive` scopes. | `/crm/v3/schemas` returns 403 `MISSING_SCOPES`, so custom objects can't be discovered, listed in the wizard or synced. The OAuth connect can be rejected for undeclared scopes. | Align the two lists. Put the sensitive scopes under `optionalScopes`, or drop them if not needed. Then run `cd hubspot-app && hs project upload --force` and reauthorize manually. **Only when the operator asks.** | After reconnecting, listing custom-object schemas returns 200 and the custom objects appear in the sync wizard. | P0 |
| G3 | Browser test regression | **Done.** [operations.ts](../src/dashboard/operations.ts) (view switch, ~line 295) made the activity view call the combined `loadConflicts`, which also filled the hidden Sync conflicts table. | Operator UI only: the first Replay button on the page was a hidden one. | The activity view now calls `loadConflictReview()` directly. The now-unused combined `loadConflicts()` function was removed. | `npm run test:browser` passes 17 of 17, including the previously failing test. | P1 -- **done** |
| G4 | No behavior tests for the new UI | **Done.** Tests only checked that strings exist in the page HTML. Nothing covered the field-mapping sort, the wizard's "already mapped" grouping or refresh double-firing. | Inferred: the wizard picks one preferred row per source object, so a wrong grouping could enroll the wrong object pair. Sorting reorders the field list that gets saved. | Added 3 browser tests to `test/browser/operatorUx.browser.test.ts`: (1) sort the field-mapping table by each column then save, asserting the saved rule set is unchanged; (2) register two canonical objects sharing one native Salesforce object and drive the sync wizard through 0/1/2 enrolled-for-sync combinations, asserting the option list and its "already mapped to" tag; (3) call `refreshAll()` twice back to back via the in-flight guard and assert exactly one "Refreshed" notice. | All 3 new tests pass; full suite is 17 of 17. | P1 -- **done** |
| G5 | Launcher hardcodes ports | `start.bat`, `waitAndOpen.mjs`, `startDb.mjs` and `waitForDb.mjs` assume ports 3000 and 5432. | If `PORT` or `DATABASE_URL` changes, the launcher opens the wrong page or reuses the wrong database. | Read `PORT` and `DATABASE_URL`, with the current values as defaults. | Launch with a non-default port. | P2 |
| G6 | Launcher runs the dev watcher | `start.bat` runs `tsx watch`. | Any file change restarts the app, interrupting in-flight sync work. | Add a non-watch start mode for normal operation. | Run the launcher and edit a file: no restart. | P2 |
| G7 | Stale lock-file check | [local.ts](../src/db/local.ts) treats `postmaster.pid` as live whenever its process ID exists. On Windows a reused ID can belong to an unrelated process. | The local database won't start until someone deletes the file by hand. | Also check that the process is a Postgres process before treating the lock as live. | Unit-test the stale-lock check. | P2 |
| G8 | Tracked file still in git | `.sf/` is now in `.gitignore`, but `.sf/.../catalog.json` is still tracked. | No runtime effect. Noise in every diff. | `git rm --cached` the file. | `git status` is clean after a Salesforce CLI run. | P2 |

## Execution order

1. **Phase 1 (code only, safe):** G1, then G3 and G4.
2. **Phase 2 (operator-gated):** G2, once the operator decides on the sensitive scopes and
   asks for the HubSpot redeploy and reauthorize.
3. **Phase 3 (hardening):** G5 to G8.

After each phase, run `npm run lint`, `npm run typecheck`, `npm run typecheck:test`,
`npm test` and `npm run test:browser`.

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
