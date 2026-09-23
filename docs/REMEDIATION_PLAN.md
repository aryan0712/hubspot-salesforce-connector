# Application review remediation plan

**Created:** 2026-09-23  
**Status:** Planned; implementation has not started under this plan.  
**Objective:** Fix every finding from the application review, prove migration and sync
correctness under failure, and establish explicit gates for pilots and public release.

## Scope and source of truth

This is the implementation plan for the September application review. It covers the
eight primary findings, the additional reliability gaps, and the product/testing
recommendations. It also groups the broader work in
[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md) into follow-on work packages so those
requirements are not lost. That document remains the comprehensive public-launch
checklist; this document supplies implementation order and acceptance criteria.
[HANDOFF.md](../HANDOFF.md) remains the source of truth for runtime state and credentials.

Creating this plan does not authorize live CRM writes, reconnecting either CRM, public
deployment, HubSpot project deployment, or previously deferred external integrations.
Implement and validate locally with mocks and isolated databases first. Preserve the
existing canonical mapping/reconciliation core for both migration and sync.

## Review baseline

- Typecheck, build, all 116 tests, and the credential-free mock demo passed during review.
- Isolated probes reproduced source writeback during a directional migration, concurrent
  duplicate target creation, multiple successful execution claims, ambiguous content
  hashes, and demo initialization replacing shared mapping configuration.
- Canary verification, retry behavior, access controls, and additional reliability gaps
  were identified through code inspection; add targeted behavioral regressions below.
- The local server was not running. Dashboard observations came from source inspection;
  a live browser and accessibility review remains part of this plan.
- Passing the existing suite is the baseline, not evidence that these findings are fixed.

## Delivery order and tracking

Use small, reviewable changes. Add a failing regression with each correctness fix and
record evidence before marking a work package complete. The phase numbers indicate
delivery order; they do not replace the severity definitions in PRODUCTION_READINESS.md.

| Phase | Work packages | Exit gate |
| --- | --- | --- |
| 1 — contain immediate correctness risks | R01–R04 | Demo isolation, exact migration intent, exclusive execution, meaningful canary verification |
| 2 — make writes recoverable | R05–R07 | Safe identity matching, concurrent linking, bounded retries, durable write recovery |
| 3 — make operations durable | R08–R10 | Resumable migrations, recoverable sync workers, durable relationships/deletions |
| 4 — establish public access boundaries | R11–R12 | Authenticated tenant routing, protected OAuth, validated webhooks |
| 5 — prove and operate the product | R13–R15 | Behavioral UI coverage, operational evidence, documentation and release gates |

Do not enable public access while phases 1–3 are being developed. Prepare the production
authentication fail-closed guard and removal of production demo routes in phase 1;
complete identity-provider integration in phase 4. Carry tests, audits, and observability
through every phase rather than deferring them all to phase 5.

### R01 — isolate runtime configuration and demo state

**Status:** [ ] Pending  
**Primary code:** `src/app.ts`, `src/core/mapping.ts`, `src/core/idMap.ts`,
`src/core/objectRegistry.ts`, configuration stores, demo routes in `src/server.ts`.

- Introduce an instance-owned configuration context containing object registrations,
  field/value/owner mappings, natural-key rules, and revision information.
- Inject it into connectors, preflight, reconciliation, and stores. Remove implicit
  process-global mutation; repositories hydrate only their own context.
- Give the demo its own context and persistence. Disable demo routes in production.
- Make mapping publication atomic after persistence; readers use one consistent
  configuration revision. Mapping changes invalidate affected approvals and canaries.
- Add a startup guard rejecting production with authentication disabled.

**Acceptance:** Initialize live-like context A with custom mappings, then initialize and
use demo B. A's mappings, custom objects, natural keys, and value translations are
unchanged. Two tenant contexts can map the same canonical type differently. Production
does not mount demo routes and rejects disabled authentication.

### R02 — make migration execution match approved intent

**Status:** [ ] Pending; depends on R01  
**Primary code:** `src/engine/reconciler.ts`, `src/engine/migrationEngine.ts`,
`src/engine/migrationPlanStore.ts`, PostgreSQL migration stores, CLI and migration routes.

- Separate planning from applying a write inside the shared reconciliation core.
  Introduce explicit migration and sync policies instead of implicitly using live-sync
  conflict behavior for a directional migration.
- Default migration to writes only in the selected destination. Resolve target conflicts
  during planning; preserving a target value must not cause source writeback.
- Freeze the exact native payload, target identity, action, conflict decision, account
  identities, mapping/value/ownership revisions, schema hashes, and source/target
  fingerprints in the approved plan. Keep sensitive payloads out of logs and Copilot.
- Make execution consume that plan. A skipped record causes no CRM write. Identity
  conflicts must not silently retarget an approved write.
- Detect changes to inputs/configuration before execution and before individual writes;
  use vendor conditional writes where available. Where atomic version checks are
  unavailable, document the residual race and route uncertain outcomes to review.
- Route API and CLI confirmed migrations through the same approved-plan service; remove
  the direct `/api/migrate` safety-gate bypass. Preserve preview-by-default behavior.

**Acceptance:** With an older Salesforce value and newer matching HubSpot value, a
Salesforce → HubSpot migration never changes Salesforce. The executed payload equals
the reviewed payload. Changed mappings, conflict policy, accounts, record values, or
schemas invalidate approval. A `skip` produces zero writes; uncertainty stops execution.

### R03 — enforce exclusive execution and immutable approval

**Status:** [ ] Pending; depends on R02  
**Primary code:** `src/db/postgresMigrationPlanStore.ts`,
`src/engine/migrationPlanStore.ts`, execution routes and operations repository.

- Define allowed plan/run state transitions and use an atomic conditional claim from an
  eligible state, with an execution identity and request idempotency key.
- Reject concurrent claims, edits to executing plans, stale approval, and unapproved
  reruns. Repeated requests return the existing execution or a stable conflict response.
- Apply equivalent claim rules to single-record and batch canaries.
- Reserve quota atomically with execution creation; record actor, configuration version,
  accounts, and approval timestamp. Define settlement for failures and cancellation.
- Preserve an immutable execution snapshot independently of future draft edits.

**Acceptance:** Two independent PostgreSQL clients submit the same plan concurrently;
only one execution is created and only one set of writes is scheduled. Double clicks,
request retries, and post-completion repeats cannot rerun the plan or charge twice.

### R04 — verify canaries against expected results

**Status:** [ ] Pending; depends on R02–R03  
**Primary code:** canary and test-batch routes in `src/server.ts`, migration services,
`src/dashboard/operations.ts`.

- Require a frozen preview for the exact selected record or batch, with explicit account,
  record count, write scope, and confirmation.
- Read each destination back and compare mapped writable values to the expected result
  using documented vendor normalization rules. Record mismatches and verification time.
- Fail the gate for zero processed records, record errors, missing targets, incorrect
  values, ambiguous matches, drift, or incomplete readback.
- A skipped existing record may pass an equality check but must not be labeled a
  successful write test. Require a representative write before unlocking a write run.
- Bind verification to configuration/account revisions and object scope. Verify every
  selected object's relevant mapping before presenting a multi-object run as tested.

**Acceptance:** An all-failed batch, empty batch, existing-but-incorrect target, failed
readback, and mixed-success batch all leave execution locked. A passing test stores
expected/actual evidence. Changing tested configuration invalidates its verification.

### R05 — repair identity matching and content hashes

**Status:** [ ] Pending; depends on R01  
**Primary code:** `src/core/idMap.ts`, `src/db/postgresIdMapStore.ts`, natural-key lookup
in both connectors, `src/core/conflict.ts`.

- Replace delimiter-concatenated hashes with versioned, typed, deterministic
  serialization and full SHA-256. Distinguish absent fields, null, empty strings,
  numbers, strings, and booleans; exclude volatile metadata deliberately.
- Define a safe upgrade from existing hashes. Rebaseline from read-only observations
  or explicitly revalidate; never trigger a mass write just because hash format changed.
- Compare normalized company domains exactly. A broad vendor search may supply
  candidates, but exact local verification is required; handle pagination/truncation
  conservatively rather than accepting an incomplete candidate set.
- Preserve natural-key ownership, track changes/retirement, and send collisions to
  manual review. Do not silently reassign an existing identity or relink on one component
  of a composite key. Include native object identity in source lookup keys where needed.
- Prefer configured external IDs; flag weak deal keys and incomplete identity. Make
  conflict/field-ownership behavior explicit and validate vendor timestamps.

**Acceptance:** `example.com` never links to `notexample.com`. `{a:'x|b=y'}` and
`{a:'x',b:'y'}` hash differently; null differs from empty string. Changed/reused emails,
composite-key collisions, overlapping native IDs, and legacy hashes are covered.

### R06 — persist write intents and serialize record linking

**Status:** [ ] Pending; depends on R02, R05  
**Primary code:** reconciler, ID-map repositories, connectors, new database migrations.

- Persist tenant-scoped logical write intents before CRM mutations, including a stable
  operation ID, target identity, payload fingerprint, status, and recovery evidence.
- Serialize linking by tenant/object/source identity and normalized natural key, with
  a documented lock order and fencing/lease strategy for multiple processes.
- Use vendor idempotency or stable external IDs where supported and configured. Do not
  assume generic CRM create APIs provide exactly-once execution.
- Recover a successful CRM write followed by database failure, worker crash, lost
  response, or source-writeback failure without blindly repeating a create.
- If outcome lookup is inconclusive, hold for manual review. Account for delayed search
  visibility and conflicts with existing links. Apply the protocol to both sync directions.

**Acceptance:** Concurrent first-sync jobs result in one target and one stable link.
Fault injection before/after the CRM write and link commit proves recovery without
duplicate creates or identity reassignment. Tests use independent database clients and
model delayed vendor search visibility, not only an immediately consistent mock.

### R07 — bound connector requests and retries

**Status:** [ ] Pending; depends on R06 for uncertain-write recovery  
**Primary code:** `src/core/httpPolicy.ts`, both connector/auth modules, sync error routing.

- On `401`, invalidate the rejected cached token, coalesce forced refreshes, replace
  the request Authorization header, and permit exactly one authentication retry.
- Set timeouts and cancellation. Classify safe reads, idempotent mutations, and unsafe
  creates explicitly; a POST search and POST create need different retry behavior.
- Honor valid Retry-After values, apply jitter and a total retry budget, and coordinate
  HTTP retries with job retries. Uncertain mutations go through R06 recovery.
- Send permanent authorization, validation, and schema errors to actionable review;
  add connector health/circuit states and tenant-aware rate limits.

**Acceptance:** Repeated `401` terminates after one forced refresh with no stale bearer
header; simultaneous refreshes coalesce. Deterministic `429`, `5xx`, timeout, and lost
response tests prove bounded requests and no blind create retries. No test uses tokens
from the live connection store.

### R08 — execute migrations as durable jobs

**Status:** [ ] Pending; depends on R03, R06–R07  
**Primary code:** migration engine/stores/routes, worker entry point, dashboard run views.

- Have HTTP execution return a run ID promptly; a dedicated worker claims persisted
  items. Store queued/running/succeeded/skipped/failed/uncertain item states and attempts.
- Stream/paginate plans and verification work. Remove silent 100,000-item truncation
  and whole-run memory requirements.
- Support pause, cancel, resume, and safe retry of eligible items. Cancellation stops
  new claims and reconciles in-flight writes; it does not imply automatic rollback.
- Add explicit partial-success status, failure thresholds, counts, and durable progress.
  Keep the approved snapshot immutable across restart and deployment.
- Add bounded progress updates and record-level result drill-in.

**Acceptance:** Kill/restart a worker after partial execution; completed writes do not
repeat. Lost HTTP connections do not abandon runs. Cancellation and resume preserve
counts. A synthetic run exceeding 100,000 records neither truncates nor buffers all
records in memory; record measured runtime, memory, and database load.

### R09 — make sync worker lifecycle reliable

**Status:** [ ] Pending; depends on R06–R07  
**Primary code:** sync engine/event store, poller, app composition and shutdown.

- Gate claims on connector/configuration readiness; separate worker and web lifecycles.
- Recover stale leases periodically, heartbeat long operations, and fence completion
  against a newer lease holder. Add cross-process queue wakeups or bounded polling.
- Bound concurrency per tenant and record; define pause versus discard semantics so
  disabling sync does not silently lose changes users expect to resume later.
- Stop claims during shutdown, finish/recover in-flight operations, and close resources.
- Test polling cursors, late visibility, boundary timestamps, pagination, and vendor
  search limits. Use overlap plus durable deduplication where appropriate.

**Acceptance:** Crash recovery works without restarting every replica. A stale worker
cannot complete another worker's lease. Backlogged jobs never run against an uninitialized
connector. Polling and webhook overlap do not lose or duplicate logical changes.

### R10 — persist relationship, deletion, and conflict recovery

**Status:** [ ] Pending; depends on R05–R09  
**Primary code:** association engine/stores, governance stores, reconciler, connectors.

- Persist deferred associations and retry when both records are linked. Paginate reads,
  preserve supported labels, and define replacement/removal behavior and unsupported
  relationship reporting.
- Keep migration explicitly record-only for the initial remediation release. Show that
  scope before approval and in results; do not imply later sync guarantees relationship
  backfill. If relationship migration is added, use an explicitly approved durable stage.
- Add tombstones and defined archive/delete/restore semantics so delayed events and
  replay cannot resurrect intentionally deleted records. Preserve approval provenance.
- Provide inspectable conflict decisions and deliberate manual resolution; audit owner
  mappings, field ownership, and deletion decisions. Preserve opt-in cascade behavior.

**Acceptance:** A contact processed before its company eventually gains its relationship
without a new contact edit. Replay after an approved delete does not recreate the record.
Labels, paging, duplicate association jobs, and unsupported relationships are tested.

### R11 — establish authenticated request-scoped tenancy

**Status:** [ ] Pending; depends on R01 and tenant-aware stores/jobs  
**Primary code:** `src/security/`, server/app composition, tenant/API-key repositories,
OAuth modules and new session/state persistence.

- Resolve user, membership, role, and tenant per request and carry that context into
  repositories, caches, connectors, jobs, quotas, and audit records.
- Integrate a selected identity provider with short-lived revocable browser sessions;
  retain scoped API keys for machine use. Add CSRF checks, login throttling, secure
  cookies, and a documented viewer/operator/admin/owner route matrix.
- Require an authenticated admin to begin OAuth. Persist single-use expiring state bound
  to session/user, tenant, system, environment, redirect URI, and PKCE verifier.
- Confirm the exact connected account before replacement and invalidate approvals tied
  to the previous account. Audit connection and permission changes.
- Run as a non-superuser NOBYPASSRLS database role; separate schema-migration privileges.

**Acceptance:** Tenant A cannot read, edit, execute, replay, or resolve tenant B's data
through any API or worker path. Test with the actual restricted runtime role. Unauthenticated
OAuth, wrong-system callbacks, reused/expired state, revoked sessions, and role violations
fail. Local development remains explicit and cannot silently become public production.

### R12 — validate and route webhook delivery securely

**Status:** [ ] Pending; depends on R09, R11  
**Primary code:** webhook routes, connector parsers, type resolver, event/cursor stores.

- Enforce HubSpot timestamp freshness and signature verification against the correct
  trusted public URI; verify implementation against current official vendor fixtures.
- Define Salesforce timestamp/nonce replay protection and update the sender contract
  before enforcing it. Do not silently break an existing signed sender.
- Validate payload structure, batch limits, object/event types, and timestamps. Route by
  verified portal/org identity and reject account mismatch.
- Persist accepted events before acknowledgement, acknowledge duplicate legitimate
  delivery safely, and separate malformed/signature/internal-failure responses.
- Avoid slow CRM reads before acknowledgement where possible; defer type resolution to
  initialized workers. Add ingestion limits and signature/account-mismatch telemetry.

**Acceptance:** Old/future timestamps, tampered bodies/URIs, wrong accounts, oversized
payloads, duplicate events, and database failures have deterministic outcomes. Legitimate
retries do not duplicate processing. Burst tests measure acknowledgement latency against
the verified vendor deadline. Public webhook deployment remains a separate release action.

### R13 — strengthen operator UX and application structure

**Status:** [ ] Pending; incremental extraction can accompany earlier packages  
**Primary code:** `src/server.ts`, `src/dashboard/`, request schemas and application services.

- Export a testable HTTP app; extract routes, validation, and services. Preserve the
  dependency direction from routes through services/engines to connector/store contracts.
- Move embedded JavaScript into typed frontend modules, tighten CSP, and replace browser
  alerts with actionable inline errors and correlation IDs.
- Show actual connection/readiness state instead of hardcoded healthy status; use real
  workspace identity. Explain matching reason, direction, account, exact field impact,
  verification result, and recovery options in the approval/results flows.
- Add cursor pagination and bounded/adaptive updates. Check keyboard access, focus,
  responsive layout, empty states, permission errors, loading, and failures.
- Preserve Copilot's advisory/metadata-only boundary and deterministic readiness gates.

**Acceptance:** Browser tests exercise save/reload, mapping changes invalidating approval,
  double execution, failed canaries, resumable runs, role restrictions, and conflict review.
  Tests assert behavior and visible outcomes rather than only HTML substrings. Complete a
  browser walkthrough at desktop and narrow widths with mock services.

### R14 — harden operations, secrets, and release infrastructure

**Status:** [ ] Pending; depends on durable execution and tenant boundaries  
**Primary code/docs:** `src/db/`, runtime secrets, notification digester, observability,
deployment configuration, [OPERATIONS.md](OPERATIONS.md).

- Verify database TLS certificates; add pool/query/lock timeouts, serialized release
  migrations, rolling-upgrade compatibility, indexes, retention, and growth monitoring.
- Prepare managed secret storage and versioned rotation with tested recovery. Never
  delete, rewrite, expose, or commit the legacy `data/*.json` files or encryption key.
  Exclude plaintext legacy credentials from deployment artifacts and support bundles.
- Add request/job/CRM correlation, operational metrics, readiness/liveness checks, and
  alerts for stale sync, auth failures, dead letters, drift, migrations, and database health.
- Persist notification delivery state; only mark alerts delivered after actual success.
  Retry SMTP failures and distinguish unconfigured transport from sent mail.
- Document backup/restore, recovery objectives, incident response, data retention,
  support access, and forward-fix/rollback procedures. Exercise restores in isolation.
- Prepare deployment packaging and dependency/secret/security scanning. Managed hosting,
  KMS, WAF, and production alert destinations require explicit environment selection.

**Acceptance:** Restore encrypted test state into a clean environment and decrypt it with
  the backed-up key. Failed email is retried and never reported as sent. TLS rejection,
  runtime DB privileges, graceful shutdown, migration locking, and operational alerts are
  demonstrated. Record measured recovery time and data-loss window.

### R15 — consolidate tests, documentation, and release evidence

**Status:** [ ] Pending; runs throughout all phases  
**Primary areas:** `test/`, CI/lint configuration, README, AGENTS, HANDOFF, architecture
and operations documentation.

- Promote review probes into permanent regressions, including database concurrency tests.
  Add shared connector contracts, API authorization tests, property-based mapping/hash
  tests, crash injection, browser flows, load tests, and a multi-day soak suite.
- Replace placeholder linting, enforce architectural boundaries, and establish CI checks
  and meaningful coverage requirements around risky behaviors.
- Reconcile stale documentation with verified code: test count, target-side natural-key
  search, custom-object execution scope, canary guarantees, and record-only migration.
  Preserve the dates of prior live verification; do not imply this review revalidated CRM
  connectivity. Update the production-readiness checklist only with supporting evidence.
- Record each completed package with commit/PR, tests, schema changes, upgrade procedure,
  known limitations, and rollback/recovery notes. Add release notes and launch evidence.

**Acceptance:** Every review finding maps to a regression and completed package. README,
  HANDOFF, and operator copy agree on supported behavior. CI covers local reproducible
  verification; release evidence includes isolation, failure recovery, and browser results.

## Broader backlog coverage

| Existing production-readiness area | Work packages |
| --- | --- |
| Request tenancy, authentication, OAuth | R01, R11 |
| CRM idempotency, record linking, approved plans | R02–R07 |
| Durable migrations and worker lifecycle | R08–R09 |
| Reconciliation, relationships, deletes, manual review | R05, R10 |
| Webhook security and delivery | R09, R12 |
| Privacy, secrets, database, infrastructure | R11, R14 |
| Observability, alerts, recovery | R08–R09, R14 |
| Tests, maintainability, release controls | R13–R15 |
| Explainable impact reports and post-write verification | R02, R04, R13 |

Optional product expansion (templates, lineage explorer, compensating-action tooling,
additional CRMs) stays in the P2 backlog. External billing, public hosting/webhook
activation, Salesforce Pub/Sub transport, and generic custom-object expansion remain
deferred pending explicit scope decisions. They are not prerequisites for local fixes.

## Validation and rollout rules

For engine/core changes, run `npm run typecheck` and `npm test`. Run `npm run build` and
the credential-free mock demo for integrated changes. Add focused API/browser/contract
checks appropriate to the package. Use temporary isolated PostgreSQL clusters for schema,
RLS, concurrency, and recovery tests; never use live `data/` as test fixtures.

Use additive, versioned schema changes. Test upgrades with legacy link hashes, queued
jobs, saved previews, and encrypted credentials. Invalidate incompatible previews
explicitly. Preserve old data until conversion is verified. Do not roll back into an
older writer that cannot understand new intent/lease/hash semantics; pause workers and
use a documented forward fix when needed.

| Gate | Required evidence |
| --- | --- |
| Local remediation complete | R01–R10 regressions pass; no unexplained duplicate, source writeback, false verification, or unrecoverable job in fault tests |
| Controlled pilot | Local gate plus applicable R11–R15 controls, explicit account/scope authorization, backup recovery, reviewed operational limits, and record reconciliation |
| Public multi-tenant beta | R01–R15 complete; restricted-role tenant isolation, protected OAuth/webhooks, durable workers, monitoring and deployment runbooks verified |
| General availability | All applicable public go-live gates in PRODUCTION_READINESS.md pass, including soak, restore, incident, privacy, and vendor requirements |

For implementation tracking, update the status in each R-section as pending, in progress,
or complete and append its evidence. A completed document or passing baseline suite does
not complete a remediation package.

## Decisions to settle when their phase starts

- Identity provider and hosted environment: select before R11 integration/deployment.
- Vendor external-ID/idempotency strategy: verify capabilities per object in R06;
  configure actual CRM properties only through a separately authorized change.
- Conflict handling for directional migrations: implement destination-only writes as
  the safe default; expose any alternate write scope through explicit reviewed intent.
- Initial supported object set: reconcile code and documentation in R15; do not promise
  generic execution solely because metadata discovery works.
- Pilot volume, recovery objectives, and sync-freshness targets: define measurable limits
  before load/soak acceptance and customer rollout. Avoid invented capacity guarantees.

**First implementation slice:** R01 isolation and production guards, with regression
coverage for demo initialization and two independent configuration contexts.

## Deferred next phase — CRM data operations platform

**Status:** Deferred by the user on 2026-09-23; planning only. Do not start this feature
phase until the user explicitly resumes it. Completing remediation does not automatically
activate this roadmap. No delivery dates or implementation commitments are assigned.

**Product direction:** Help teams understand their CRM data, move it safely, and keep
both systems healthy through one journey:
**assess → prepare → approve → migrate → verify → monitor**.

R01–R15 remain the remediation work. Where features below overlap those packages,
complete the existing safety requirements without expanding into the deferred product
scope. This roadmap builds on those guarantees and does not add new remediation gates.

### Proposed features

| ID | Feature | User experience and intended outcome | Foundation |
| --- | --- | --- | --- |
| F01 | Migration assessment | After connecting accounts, inspect record counts, duplicate candidates, missing required values, unmapped owners, incompatible stages, and relationship gaps. Reports state whether findings come from a sample or a complete scan, with scope and timestamps. | R05, R10, R11 |
| F02 | Explainable migration plans | See why records match, which values win, and the exact account/fields affected. Exclude records, resolve ambiguity, and export a versioned impact report tied to the approved plan. | R02–R05, R13 |
| F03 | Migration control center | Start a background run, close the browser, and return to durable progress. Pause, cancel, resume, and retry eligible failures. Separate attempted writes from verified outcomes and provide record-level results. | R03–R04, R06–R09, R13 |
| F04 | Relationship-aware migration | Move companies, contacts, and deals with relationships, owner translations, and pipeline mappings. Preview dependencies and unsupported relationships before approval; execute relationship work as an explicit durable stage. | R06, R08, R10 |
| F05 | Continuous reconciliation | Schedule scans for missing records, unexplained differences, broken relationships, and duplicate candidates, including changes missed by event delivery. Turn proposed repairs into reviewable plans. | R05–R10, R12 |
| F06 | Exception resolution workspace | Inspect source/target values, matching evidence, failure reasons, and proposed corrections together. Resolve individual exceptions or preview a rule against a selected group before approving it. | R02, R05, R10–R13 |
| F07 | Data Health home page | Show verified migration progress, sync freshness, unresolved conflicts, missing relationships, and required actions. Every metric links to affected records and states its measurement scope and freshness. | R08–R10, R13–R14 |
| F08 | Team review and configuration publishing | Named users prepare drafts, compare mapping versions, submit immutable plans for approval, and publish reviewed configuration. Support consultant → customer administrator → operator handoff with a clear audit trail. | R01–R03, R11, R13 |
| F09 | Assisted mapping and remediation | Extend Copilot to propose mappings, explain specific failures, and draft transforms with sample previews and supporting evidence. Users approve changes; deterministic checks still govern readiness. | R02, R04–R05, R11, R13 |
| F10 | Recovery and compensating changes | Retain relevant before-values and approved payloads, explain what can be reversed, and prepare a separate reviewed recovery plan. Distinguish reversible changes, manual recovery, and irreversible actions. | R02, R06, R08, R10–R14 |

### Boundaries for future design

- F04 is deferred: remediation continues to describe migration as record-only until an
  explicitly approved relationship-migration release exists. Metadata discovery alone
  does not imply support for migrating every discovered object or relationship.
- F05 starts with read-only detection. Repair writes use the same reviewed, durable
  execution path as migration; scanning does not authorize silent corrections.
- F07 uses explainable metrics. Avoid a single health score until its calculation,
  coverage, and limitations are transparent.
- F08 extends the remediation authentication and audit controls with customer-facing
  collaboration. It does not defer the access controls required by R11.
- F09 preserves the current metadata-only, advisory Copilot boundary. Local sample
  previews need not send record values to AI. Any future sharing of record values
  requires a separate privacy/security design and explicit scope decision. Autonomous
  CRM writes are outside this roadmap.
- F10 must account for edits made after migration before proposing reversal. Do not
  promise universal rollback; document vendor limitations and retention/access rules
  for before-values.

### Suggested release sequence when resumed

1. **Migration confidence:** F01 assessment, F02 explainable plans, and F03 control
   center, supported by a minimal F07 status overview. Validate the complete journey
   from account connection to verified results with a controlled pilot.
2. **Connected and continuously healthy data:** F04 relationship migration, F05
   reconciliation, and F06 exception resolution; expand F07 around measured outcomes.
3. **Team operations and assistance:** F08 publishing/approval workflows, F09 targeted
   assistance, and F10 reviewed recovery tooling, prioritized from pilot evidence.

Before starting a feature, define its supported objects, limits, API costs, permissions,
acceptance tests, and rollout scope. Reuse remediation services rather than introducing
a second mapping, reconciliation, approval, or write engine.

### Success measures

Capture a baseline and agree targets when this phase is resumed:

- Time from connecting accounts to an approved migration plan.
- Percentage of in-scope migrated records verified correctly, with unverified and failed
  records shown separately.
- Operator effort and elapsed resolution time per failed record.
- Unexplained duplicate or divergent records after migration, measured over a stated
  scope and observation window.
- Time to detect and resolve sync problems, including events missed by webhooks.

**Customer promise:** See what will happen, verify what happened, and understand how to
recover when something goes wrong.
