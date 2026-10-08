# Custom-object support remediation plan

**Created:** 2026-09-28  
**Status:** Local migration and registered-object sync paths implemented; live account onboarding remains open.  
**Owner:** Product/engineering decisions remain required for the live release.  
**Related:** [ARCHITECTURE.md](ARCHITECTURE.md), [REMEDIATION_PLAN.md](REMEDIATION_PLAN.md), [BIDIRECTIONAL_TEST_GAPS.md](BIDIRECTIONAL_TEST_GAPS.md), [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).

## Objective

Deliver safe, tenant-configured Salesforce custom-object ⇄ HubSpot custom-object support
through the existing canonical mapping, preview, approval, migration, and (later) sync
engines. Do not create a second migration/reconciliation path or weaken duplicate,
preflight, tenant-isolation, or approved-write safeguards.

## Local implementation status (2026-09-28)

The operator can explicitly pair discovered native objects, and a credential-free mock app
can now register the pair, map its fields and key, preview it, verify a canary read-back,
and execute a bounded records-only run through the existing durable migration path. A
custom-object preview is limited to 500 records per object and requires an explicit limit.
Preflight blocks missing/unshared keys, sampled missing or duplicate identities, unsupported
scalar types and enum values, missing or non-writable fields, unavailable objects, and
disabled execution. Malformed custom numeric, boolean, date, and compound values fail
translation without including record values in errors. The full preview also blocks duplicate
source keys outside the sample.
Native object and field identifiers are validated before they can enter queries or paths.
HubSpot schema permission failures surface explicitly. Mock and real-browser tests cover
the local path.

The live app still reports `CUSTOM_OBJECT_EXECUTION_DISABLED` for custom **migration**.
Following the operator's request to support standard and custom objects in live sync, sync
can now be enabled for any explicitly registered pair whose direction passes read-only
preflight. New non-default pairs start paused. The worker checks their mapping and shared
key again before writing, and polling and HubSpot webhook resolution include registered
standard/custom types. The HubSpot catalog lists its documented standard CRM object IDs;
known read-only types cannot pass a write preflight. Shared native objects require
structured conditions and an exact one-route match for webhook and poll events. Mock and
HTTP tests exercise both directions, natural-key failures, duplicate matches, pauses,
replay, deletion review, mapping drift, ambiguous routing, and relationships.
No connected-account sync configuration, vendor scope, connection, or CRM record was changed
in this implementation. A read-only inspection on 2026-09-29 found eight registered pairs;
four have no field mappings or shared key, and only Company is enabled. The first real
pair readiness review, account permissions, volume, and rollout/restore rehearsal remain
open; this is not Phase 6 approval.

At plan creation, the canonical type and object registry were runtime-extensible, and the
workspace could show broader object metadata, but migration execution had no custom-object
safety contract. The connected HubSpot app returned `403 MISSING_SCOPES` for custom
schema discovery. These are separate gaps: dynamic discovery does not itself make the
execution pipeline safe for an arbitrary object, and code changes do not grant vendor
scopes.

## Proposed initial product boundary

The first release should support an explicitly paired custom object in each CRM, such as
Salesforce `Project__c` paired with a HubSpot custom object type ID. The operator must
select the exact native objects, define field mappings, and configure a stable shared
natural key before preview. Never infer pairings from similar labels or guess identity
fields.

Initial execution scope:

- Record-level create/update/skip migration and the existing frozen-preview, canary,
  read-back, idempotency, write-intent, drift, quota, and audit controls.
- Scalar fields with an explicit supported type/transform matrix: text, numeric, boolean,
  date/datetime, and enumerations. Unknown, compound, calculated, or unsupported values
  are excluded with a visible reason, not coerced silently.
- Custom-object discovery and field metadata must be account-scoped and tenant-scoped.
  Stable vendor identifiers, not display labels, are persisted.
- A required, explicitly reviewed natural key for migration. If a dependable shared key
  cannot be configured, migration is blocked rather than defaulting to create-all.
- Migration remains records-only. Live sync may propagate registered relationships through
  the existing association engine; unsupported relationships go to operator review. Deletes
  retain the existing ignore, manual-review, or explicitly configured cascade policy.

This boundary does not include arbitrary CRM support, custom-object schema creation,
workflow automation parity with Make, or migration of unsupported binary/compound fields.

## Phases and exit gates

### Phase 0 — product contract and permissions

Decide and record: the first supported Salesforce/HubSpot custom-object pairs; required
HubSpot/Salesforce scopes; supported field types and transforms; natural-key rules;
maximum object/field/record limits; custom-object sync is required by the operator;
relationship/delete behavior; and rollback expectations.

Request the minimum vendor scopes only after the account owner approves the scope change.
Do not reconnect the existing account or deploy a HubSpot project as part of code work.

**Exit gate:** approved scope matrix, API permission checklist, threat/data review, and
clear behavior for missing keys, duplicate keys, unsupported fields, and schema drift.

### Phase 1 — registry, metadata, and tenant persistence

- Model a canonical custom-object registration bound to stable Salesforce object API name
  and HubSpot object type ID. Labels remain presentation-only.
- Persist object capabilities and schema snapshots per tenant and CRM account; invalidate
  previews when an object pairing or relevant schema revision changes.
- Add connector contract coverage for custom-object list/describe/read/page/write and
  natural-key search. Keep vendor-specific payloads inside connector implementations.
- Enforce allowlists for object names/type IDs and field names before constructing SOQL,
  HubSpot requests, or dynamic SQL. Values remain parameterized; never concatenate
  operator-supplied field values into queries.
- Return explicit unsupported/permission errors, including HubSpot `MISSING_SCOPES`,
  without falling back to guessed schemas.

**Exit gate:** multiple tenant contexts can register the same label with different vendor
IDs without cross-talk; metadata is tenant/account-bound; identifier validation and
permission failures have regression tests.

### Phase 2 — mapping, typing, identity, and preflight

- Allow per-object mapping rules for custom fields using the existing mapping store and
  transform mechanism. Add no custom-object-specific translation in the migration engine.
- Build a schema compatibility matrix and reject missing required targets, read-only or
  non-createable/non-updateable targets, incompatible data types, unsupported enums, and
  unknown transforms before preview.
- Require a shared explicit natural key; check missing/duplicate values on both sides and
  exact-verify every natural-key search candidate. Treat truncated candidate sets as
  incomplete and block linking.
- Define normalization for Salesforce IDs, HubSpot IDs, dates/time zones, numeric
  precision, blank/null semantics, and enum values. Hash canonical typed values so echo
  suppression is stable across vendors.
- Keep `CanonicalType` values opaque strings throughout the engine. Avoid assumptions
  that object types are only `contact`, `company`, or `deal` in migration, plans, events,
  sync policy, audit, and dashboard code.

**Exit gate:** table-driven type/key tests cover both directions; unknown types, key
collisions, partial candidate search, and schema drift fail closed; no custom field/value
leaks into logs or Copilot prompts.

### Phase 3 — generic migration path

- Remove built-in-object execution assumptions from plan validation, source record
  listing, preflight, plan storage, canary routes, worker execution, progress, and CLI.
- Preserve the single approved-plan path: schema snapshot, frozen native payload, exact
  target identity, fingerprints, account identity, mapping/config revision, explicit
  confirmation, one-time execution claim, durable write intent, and destination readback.
- Support pagination and bounded-memory preview/execution for custom objects; apply
  connector rate limits and per-object quotas. Define safe failure thresholds and resume
  behavior.
- Do not create custom destination schemas automatically. A missing HubSpot property or
  Salesforce field blocks preflight and directs the operator to configure the vendor
  schema separately.
- Keep migration records-only. Report unsupported relationship fields as deferred, not
  silently dropped.

**Exit gate:** mock custom-object pair completes preview → canary → read-back → limited
execution → resume/replay without duplicate creates; two tenants and two independent
workers cannot cross-link or double-claim; injected timeouts recover through write intents.

### Phase 4 — operator workflow and observability

- Extend object selection, schema inspection, field mapping, transforms, identity setup,
  preflight, preview, canary, and run history to custom objects.
- Show native object IDs, field API names/types, unsupported fields, permission errors,
  key coverage/duplicates, estimates, and exact proposed actions before confirmation.
- Add bounded search/filter/pagination and accessible failure states for large schemas.
- Audit object registration, mappings, natural-key changes, preview approvals, canary
  results, and executions. Keep secrets and record payload values out of audit details.

**Exit gate:** browser tests prove an operator can configure, validate, preview, run, and
inspect a custom-object plan; viewer/operator/admin boundaries and strict CSP remain
intact.

### Phase 5 — custom-object live sync and relationships (separate release gate)

Only after migration has passed a controlled pilot:

- Enroll the custom object in stored per-object sync policy with explicit direction,
  enabled state, polling conditions, conflict strategy, and delete policy.
- Resolve inbound webhook object identifiers to the correct tenant registration; reject
  unknown or unregistered object IDs. Validate vendor signatures/replay rules before
  queueing.
- Add custom-object relationship metadata, type resolution, association persistence,
  delayed-link retries, deletion/tombstone behavior, and vendor-specific association
  labels only for explicitly supported relationship kinds.
- Verify webhook delivery and scheduled polling independently; neither should rely on
  guessed object identity or process-local registration state.

**Exit gate:** both directions pass create/update/echo/conflict/retry/delete/replay and
relationship tests on mocks; then separately authorized read-only account verification
and a controlled canary prove the configured vendor object pair. No broad sync enablement
by default.

### Phase 6 — rollout and recovery

- Use a feature flag scoped to tenant and object; default custom objects to disabled.
- Test upgrade from existing PostgreSQL state, rollback/forward-fix procedure, schema
  migration lock, backup restore, and plan invalidation for changed schema/configuration.
- Start with one approved object pair and a small bounded canary/batch. Compare source and
  destination counts, key coverage, field diffs, errors, and readback evidence.
- Expand record limits and tenants only after reconciliation and operational review.
- Document a kill switch: pause object jobs, stop new webhooks/polls for that object,
  preserve durable evidence, and resume only after operator review. Do not automatically
  delete destination records as rollback.

**Exit gate:** measured pilot evidence, successful restore/recovery rehearsal, alert and
manual-review runbook, and explicit release approval.

## Cross-cutting safety requirements

- Keep tenant RLS and account routing mandatory for metadata, mappings, links, jobs, and
  audit rows.
- Never let CRM-native object names, property IDs, or shapes leak into `src/engine/`.
- Never bypass destination natural-key search, exact local candidate verification,
  approval drift checks, canary verification, conditional writes where supported, or
  durable write intents.
- Treat schema changes as approval invalidation. Do not silently drop a field or retarget
  a record after preview.
- Do not run migrations, canaries, live sync, OAuth reconnects, scope changes, HubSpot
  uploads, webhook registrations, or public deployments without the corresponding
  explicit authorization.
- Keep logs and AI assistance free of CRM record values and credentials.

## Required test matrix

For every supported object pair and direction, cover:

- Create, update, skip, exact natural-key link, duplicate-key block, missing-key block,
  and incomplete/truncated search block.
- Field type conversion, null/blank semantics, enum translation, required/read-only
  fields, unknown metadata, and required destination field handling.
- Preview drift from record, schema, account, object pairing, or mapping changes.
- Canary write/readback success and mismatch; no full run unlock on failure.
- Concurrent first-link and execution claims; idempotent request replay; timeouts before,
  during, and after vendor mutation; crash recovery and safe resume.
- Tenant isolation for same object labels and different vendor object IDs.
- Pagination, configured rate limits, large metadata responses, and bounded memory.
- Webhook signature/replay routing and per-object polling filters if live sync is enabled.
- Deletion policy, tombstones, stale events, and relationships when those features are
  explicitly in scope.

All tests use mock connectors and isolated PostgreSQL. Add real-browser coverage for the
operator workflow. Connected-account testing remains read-only until a separate canary
write is approved.

## Decisions required before implementation

1. Which Salesforce custom object and HubSpot custom object should be the first supported
   pair? Provide stable API name/type ID, not just labels.
2. Is the first release migration-only, or must live sync ship at the same time?
3. Which fields form a stable shared identity key, and who owns resolving duplicates?
4. Which custom field types, enums, and relationships are in the initial contract?
5. Is the HubSpot app scope change approved, and who can authorize/reconnect the account?
6. What is the allowed pilot volume, maintenance window, and acceptable recovery behavior?

Until these decisions and vendor permissions are available, implementation should remain
local/mock-backed and the production custom-object execution gate should stay closed.
