# Bidirectional app verification — 2026-09-28

For detailed open issues, environment limitations, and retest gates, see
[BIDIRECTIONAL_TEST_GAPS.md](BIDIRECTIONAL_TEST_GAPS.md).

This is the current-worktree check of the three executable canonical objects in both
directions. Live account checks were read-only. The web server stayed on localhost with
background workers disabled; no live CRM record was created, updated, or deleted.

## Automated scenario matrix

`test/bidirectionalFlows.test.ts` passed all 38 cases against isolated mock CRMs:

| Scenario | Salesforce → HubSpot | HubSpot → Salesforce |
| --- | --- | --- |
| First live event creates and links a contact, company, or deal once | Pass | Pass |
| Migration preview and approved execution write only to the destination; repeat skips | Pass | Pass |
| Existing destination record matches and updates without a twin | Pass | Pass |
| Later edits flow from either linked side; echoes do not loop | Pass | Pass |
| Duplicate destination natural keys block preview | Pass | Pass |
| Approved delete leaves a tombstone; stale replay cannot recreate the record | Pass | Pass |
| Contact–company relationship propagates after both records link | Pass | Pass |

The existing suite also checks conflicts and manual override, value mapping, canary
verification, drift and approval expiry, concurrent linking, retries and crash recovery,
webhook signatures and replay protection, OAuth, sessions, tenancy, roles, polling,
retention, and backup/restore. The final full suite passed **362 tests in 36 files**, with
2 skipped. The separate webhook load run passed **21 tests**, and the real-browser suite
passed **13 tests**, including the invalid-target mapping cleanup workflow. All 8 database
operation tests passed, including TLS certificate verification without an OpenSSL
executable. Lint, both typechecks, build, secret scan, production dependency audit, and
the mock end-to-end demo passed. Synthetic migration loads succeeded for 100,001
in-memory and 2,000 isolated-PostgreSQL records, each created once.

## Connected-account read-only checks

Schema discovery, record listing, and read-back succeeded for contact, company, and deal
in both Salesforce and HubSpot. Five cross-CRM natural-key searches completed without API
errors. The sampled deal found a match in each direction; sampled contacts and the HubSpot
company had no match in the opposite account. No Salesforce company record with a
configured domain key appeared in the sampled pages, so that source-to-target lookup was
not exercised with a real key.

One-record-per-object **Salesforce → HubSpot** migration previews succeeded for contact,
company, and deal (one create, one create, one skip). The corresponding **HubSpot →
Salesforce** combined preview was correctly blocked by preflight:

| Object | Blocking live preflight result |
| --- | --- |
| Contact | Four duplicate email values in the sampled Salesforce destination |
| Company | 179 configured Salesforce target fields are read-only, including `Id` and `IsDeleted` |
| Deal | One duplicate `name + closeDate` value in the sampled Salesforce destination |

HubSpot custom-object schema discovery returned `403 MISSING_SCOPES`; standard-object
reads and previews continued. This connected app needs the appropriate custom-object
scope before custom schema discovery can pass. Custom-object migration execution remains
outside the product's supported canonical objects.

The built-in deal mapping now normalizes `closeDate` to a canonical date-only string in
both CRMs. HubSpot reads epoch milliseconds as `YYYY-MM-DD` and converts the canonical
date back to epoch milliseconds for writes; Salesforce uses date-only strings in both
directions. Migration `023` backfills existing built-in mappings without replacing
customized native fields; it was applied to this workstation's local PostgreSQL store on
2026-09-28. These fixes passed mapping, PostgreSQL persistence, and bidirectional
echo-suppression tests. No connected CRM records or OAuth state were changed.

Selected-record preflight now ignores destination duplicate keys that do not match the
selected source record, but still blocks exact duplicate matches. This is covered in
mock-backed previews for both directions; the connected-account duplicate data was not
cleaned or bypassed. The operator can now clear invalid/read-only target field mappings
from the Mapping workspace after reviewing the metadata, but the live mapping was not
changed by this test run.

The live Salesforce deal natural-key search initially failed because SOQL Date literals
were quoted; the connector now sends a bare date literal and normalizes HubSpot epoch
milliseconds and Salesforce date strings to the same key. A regression test and a live
read-only lookup in both directions passed after the fix.

## Remaining verification boundary

Live record writes, worker-driven sync, vendor webhook delivery, OAuth reconnection,
public deployment, and production-scale soak/restore were not exercised. The remaining
reverse migration natural-key collisions and invalid Salesforce company targets must be
resolved or explicitly excluded before attempting a canary. Migration execution is
records-only; relationship propagation is a separate live-sync operation. No live record,
OAuth grant, webhook registration, or deployment state was changed.
