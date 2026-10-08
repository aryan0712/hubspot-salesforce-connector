# Bidirectional test gaps and follow-up — 2026-09-28

This note summarizes the gaps found while testing Salesforce ⇄ HubSpot in both
directions on 2026-09-28. It complements [BIDIRECTIONAL_VERIFICATION.md](BIDIRECTIONAL_VERIFICATION.md),
which records the scenario matrix and read-only connected-account observations.

## Summary

Mock-backed behavioral coverage is strong for the supported canonical objects. Contact,
company, and deal flows passed in both directions, including create, update, replay,
duplicate-key rejection, deletion protection, and contact-company association scenarios.
The local implementation now fixes the built-in deal date mapping, selected-record
duplicate preflight, invalid-target mapping cleanup, portable TLS tests, and poller task
tracking. It does not clean or rewrite connected CRM data. The sampled full HubSpot →
Salesforce preview remains blocked by account data and mapping state; a selected,
unambiguous record can now be previewed without unrelated destination duplicates
stopping it. No live CRM writes were made.

## Product and connected-account gaps

### HubSpot → Salesforce full migration remains gated by preflight

The read-only combined preview was blocked for all three sampled object types:

| Object | Observed blocker | Required follow-up |
| --- | --- | --- |
| Contact | Four duplicate email values in the sampled Salesforce destination | An operator must decide whether each collision needs data cleanup or should be excluded from the selected scope. Exact duplicate matches remain blocked; do not bypass natural-key verification. |
| Company | 179 configured Salesforce target fields were reported read-only, including `Id` and `IsDeleted` | The field workspace now offers **Remove invalid targets**. Review proposed target removals and explicitly save, then rerun preflight. This changes mapping configuration only; it does not modify Salesforce records. |
| Deal | A duplicate `name + closeDate` natural key was found in the sampled Salesforce destination | Resolve or exclude the ambiguous record through an approved scope/data decision, then rerun the exact-key preflight. Do not silently select one duplicate. |

Separately, the persisted HubSpot deal `closeDate` value is an epoch-millisecond number,
while Salesforce `CloseDate` expects a date-only value. Add and test a direction-aware
transform to produce the correct date before any reverse-direction deal write is
considered. The duplicate natural key blocked this path before a live write could test
the mapping.

These findings have different owners: duplicate natural keys are connected-data
conditions; read-only target fields and the deal date representation are mapping or
configuration issues. A passing preview in another direction does not clear them.
The default deal mapping is now direction-aware: both CRMs normalize `closeDate` to a
canonical `YYYY-MM-DD`; Salesforce reads and writes date-only strings, while HubSpot
reads date-only from epoch milliseconds and writes epoch milliseconds. Migration `023`
backfills only the built-in native fields, and PostgreSQL tests verify customized native
mappings are preserved. Migration `023` was applied to this workstation's local
PostgreSQL store on 2026-09-28. This updates app-side mapping configuration only; it did
not call either CRM or change CRM records. Other environments must apply the migration
through their normal release process.

Scoped preflight now profiles destination duplicates against source IDs selected for a
canary/record preview. Unrelated duplicate keys no longer block that preview, but an exact
duplicated target key still does. Full previews continue to check their source scope, and
each planned record still undergoes exact destination matching before approval.

These findings have different owners: duplicate natural keys are connected-data
conditions; read-only target fields are mapping configuration; the built-in date-format
defect is fixed. A passing preview in another direction does not clear account-specific
blockers.

### Salesforce → HubSpot real-account coverage is sampled

One-record-per-object previews succeeded for contact, company, and deal. Their planned
actions were one create, one create, and one skip, respectively. This confirms the
sampled preview path, not full-dataset correctness or execution against the live account.
The sampled Salesforce pages did not contain a company with a configured domain key, so
the real-account company natural-key lookup was not exercised with a matching key.
Broader read-only sampling is still needed before making claims about collision rates or
coverage across the account.

### Custom-object discovery and execution are out of scope

HubSpot custom-object schema discovery returned `403 MISSING_SCOPES`. The connected app
needs the applicable custom-object scope before that metadata check can pass. Separately,
custom-object migration execution is intentionally unsupported: execution currently
covers only Contact, Company, and Deal. Obtaining the scope would enable discovery, not
generic custom-object migration. The proposed phases, scope decisions, safety gates, and
acceptance tests are in [CUSTOM_OBJECT_REMEDIATION_PLAN.md](CUSTOM_OBJECT_REMEDIATION_PLAN.md).

## Test environment gap resolved

`test/databaseOperations.test.ts` now generates its temporary PostgreSQL TLS certificate
using the Node-native `selfsigned` development dependency instead of spawning OpenSSL.
All three certificate cases pass on this Windows environment:

- Reject an untrusted self-signed server certificate.
- Connect when the correct CA is supplied.
- Reject a certificate whose hostname does not match.

The production refusal of unverified TLS and development-only insecure configuration
checks also pass. The external OpenSSL prerequisite is closed.

The scheduler now tracks scheduled poll tasks while scheduling its next tick
independently. The earlier poller assertion failure and Vitest shutdown warning did not
recur in the final full suite. During the latest full-suite run, concurrent database
migrations exceeded Vitest's default 5-second per-test timeout once; the test passed in
isolation, so its budget is now 30 seconds to account for parallel Windows load. The
complete suite passed after that adjustment.

## Live behavior not exercised

The following were deliberately not tested against connected accounts or public
infrastructure:

- Any live record create, update, or delete, including canary and full migration writes.
- Worker-driven live sync and vendor webhook delivery.
- OAuth reconnect or account replacement.
- Public deployment or production-scale soak testing.
- A production-scale backup and restore exercise.

These require external access, explicit authorization, and operational safeguards. The
read-only reverse-migration blockers above must be resolved before proposing a live
write. Synthetic migration-load tests and mock webhook tests do not substitute for
production soak, restore, or vendor-delivery evidence. No implementation or test in this
work changed CRM records, OAuth grants, webhook registrations, or deployment state.

## Test-run observations

Final results from the 2026-09-28 implementation and verification runs:

- The full unit/integration suite passed **362 tests in 36 files**, with 2 skipped.
- All **8** database-operation tests passed, including all three TLS certificate cases.
- The real-browser suite passed **13 tests**, including invalid-target mapping cleanup.
- The 21 webhook-load tests, synthetic migration-load command, and mock demo passed.
- Lint, both typechecks, production build, secret scan, and the configured production
   dependency audit completed. The audit reports one moderate `qs` advisory; no high
   severity production dependency finding was reported at its configured threshold.
- The final full suite had no poller assertion failure and no Vitest shutdown-timeout
   warning. The bidirectional matrix caught a temporary deal-echo regression during
   implementation; canonical date normalization fixed it before the final run.

## Suggested closure order

1. Apply the application/database migration in the intended environment. Review and save
   valid Salesforce company mappings using **Remove invalid targets**, then rerun
   preflight. This implementation does not automatically alter stored mappings.
2. Have the data owner resolve or explicitly exclude the sampled duplicate natural keys.
   Repeat read-only previews for a narrow, unambiguous scope in both directions; exact
   duplicate matches must continue to block.
3. Obtain the HubSpot custom-object scope only if custom schema discovery is needed.
   Generic custom-object migration still requires the separately deferred dynamic
   canonical-object feature.
4. Schedule worker/webhook, production soak, and production backup/restore exercises in
   their proper environments. Do not expose endpoints or reconnect accounts as part of
   local code validation.
5. Separately request authorization before any live canary or migration write. No item
   in this document authorizes one.