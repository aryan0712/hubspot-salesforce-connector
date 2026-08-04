# Production-readiness backlog

**Created:** 2026-07-29  
**Status:** Deferred — implement before a public multi-tenant launch  
**Current release posture:** Suitable for controlled local/internal pilots; not yet
safe to expose as a public SaaS.

This document records the production-readiness work identified during the repository
audit. It is a future-work backlog, not a statement that these features are already
implemented.

`HANDOFF.md` remains the source of truth for the current runtime, credentials, safety
constraints, and verified implementation state.

## What is already strong

- Migration and live sync share the same canonical reconciliation core.
- The API and CLI default to dry-run/preview.
- Saved plans support frozen previews, source drift checks, schema hashes, and explicit
  confirmation before execution.
- PostgreSQL stores product state, CRM connections, record links, jobs, plans, audit
  entries, and governance records.
- Tenant tables use forced row-level security.
- OAuth credentials and tokens are encrypted at rest.
- Sync jobs have durable event identities, retries, dead letters, manual review, and
  replay.
- Natural-key target search reduces first-migration duplicates.
- Unit and PostgreSQL integration tests run without live CRM credentials.

## Priority definitions

- **P0 — launch blocker:** must be complete before any public multi-tenant deployment.
- **P1 — production requirement:** required before general availability or meaningful
  customer volume.
- **P2 — quality/product improvement:** improves maintainability, usability, trust, or
  differentiation after the core is safe.

## P0 — launch blockers

### Request-scoped tenancy

- [ ] Resolve the authenticated user and tenant on every request.
- [ ] Remove the process-wide `DEFAULT_TENANT_SLUG` runtime model from the public app.
- [ ] Make connections, settings, mappings, repositories, connector clients, quotas,
  jobs, and audit entries tenant-scoped.
- [ ] Route HubSpot events by portal ID and Salesforce events by organization ID.
- [ ] Reject events whose account identity does not match the selected tenant.
- [ ] Ensure global mapping and natural-key caches cannot leak configuration between
  tenants.
- [ ] Run the application with a non-superuser, `NOBYPASSRLS` PostgreSQL role.
- [ ] Add negative isolation tests proving tenant A cannot read, mutate, enqueue, replay,
  or execute tenant B's data.

### User authentication and authorization

- [ ] Make production startup fail when authentication is disabled.
- [ ] Replace API-key browser login with a real user identity provider and short-lived
  server-side sessions.
- [ ] Load membership and roles from `tenant_users`.
- [ ] Support session revocation and MFA-capable authentication.
- [ ] Add login throttling, lockouts, and suspicious-login audit events.
- [ ] Keep API keys for machine-to-machine use only.
- [ ] Add CSRF protection to all browser mutations.
- [ ] Review every route against viewer/operator/admin/owner permissions.

### Protected OAuth connection flow

- [ ] Require an authenticated admin to start a Salesforce or HubSpot connection.
- [ ] Bind OAuth state to tenant, user, CRM system, environment, redirect URI, and PKCE
  verifier.
- [ ] Persist short-lived OAuth state in PostgreSQL or Redis instead of process memory.
- [ ] Consume state atomically and reject reuse.
- [ ] Audit connection creation, replacement, refresh failure, and disconnection.
- [ ] Display and confirm the exact Salesforce organization or HubSpot portal before
  replacing a connection.

### Idempotent CRM writes

- [ ] Persist a durable write intent/outbox entry before making a CRM mutation.
- [ ] Give every logical write a stable idempotency identity.
- [ ] Use vendor idempotency features or dedicated external-ID properties where
  available.
- [ ] Do not automatically retry non-idempotent `POST` creates.
- [ ] After timeouts or uncertain responses, search/reconcile before another create.
- [ ] Recover states where the CRM write succeeded but the database update failed.
- [ ] Add fault-injection tests around every CRM-write/database-commit boundary.

### Concurrency-safe record linking

- [ ] Serialize first-link creation by tenant, object type, and normalized natural key.
- [ ] Prevent two workers from creating the same target concurrently.
- [ ] Treat a natural-key ownership collision as manual review rather than silently
  moving the key to another canonical link.
- [ ] Track active and retired natural keys when emails, domains, or business keys change.
- [ ] Prefer customer-configured external IDs over weak inferred keys.
- [ ] Replace partial Salesforce domain matching with normalized exact matching.
- [ ] Reconsider `deal name + close date` as a safe default business key.

### Webhook security and delivery

- [ ] Enforce HubSpot v3 signature timestamp freshness and replay protection.
- [ ] Validate the proxy-aware public request URI used in signature calculation.
- [ ] Add timestamp/nonce replay protection to the Salesforce signed endpoint.
- [ ] Validate webhook payloads with strict runtime schemas.
- [ ] Limit event count, body size, supported object types, and supported event types.
- [ ] Separate invalid-signature responses from malformed payload and internal failures.
- [ ] Persist accepted events quickly and acknowledge within the vendor timeout.
- [ ] Gate workers on connector readiness so an accepted event cannot execute against an
  uninitialized connector.
- [ ] Add webhook rate limiting/WAF protection and signature-failure alerts.
- [ ] Add official signature fixtures and duplicate/replay tests.

### Durable migration execution

- [ ] Run migrations in a dedicated worker instead of inside an HTTP request.
- [ ] Persist per-item queued/running/completed/failed state.
- [ ] Support pause, cancel, resume, and safe item retry.
- [ ] Stream records and plans instead of loading up to 100,000 into memory.
- [ ] Resume after process or deployment failure without repeating completed writes.
- [ ] Add `completed_with_errors` semantics and configurable failure thresholds.
- [ ] Persist association work as a durable second stage.
- [ ] Expose progress through server-sent events or another low-noise mechanism.

### Approved-plan-only writes

- [ ] Disable or tightly restrict direct confirmed execution through `/api/migrate`.
- [ ] Require a saved, revisioned plan for every production write.
- [ ] Require successful preflight and a frozen preview.
- [ ] Recheck source fingerprints and CRM schemas before execution.
- [ ] Require the operator to confirm the exact source and target accounts.
- [ ] Reserve quota atomically before execution.
- [ ] Record the approving actor and immutable execution configuration.

### Safe deletion lifecycle

- [ ] Add canonical tombstones when deletion propagates.
- [ ] Define retention, hard-delete, archive, restore, and undelete behavior.
- [ ] Prevent later webhook replay from accidentally recreating an intentionally deleted
  record.
- [ ] Preserve source, actor, policy, and approval provenance.
- [ ] Keep cascade deletion explicitly opt-in.
- [ ] Require two-person approval for bulk or high-volume deletion.

## P1 — correctness and reliability

### Reconciliation

- [ ] Store full SHA-256 content hashes.
- [ ] Use typed canonical serialization that distinguishes missing, `null`, empty string,
  zero, and `false`.
- [ ] Include relevant association/deletion/version state in change identity where
  appropriate.
- [ ] Track field-level provenance or versions instead of relying only on whole-record
  modified timestamps.
- [ ] Validate missing or invalid vendor timestamps.
- [ ] Make conflict ownership rules tenant-scoped and explainable.
- [ ] Add a first-class manual conflict-resolution workflow.

### Connector HTTP policy

- [ ] Set request/connect timeouts and support cancellation.
- [ ] Retry only errors classified as transient.
- [ ] Send permanent validation, authorization, and schema errors directly to review or
  dead letter.
- [ ] Honor vendor `Retry-After` behavior.
- [ ] Add jittered exponential backoff with a retry budget.
- [ ] Add circuit breakers and connector health states.
- [ ] Allow exactly one token-refresh retry after a `401`.
- [ ] Use a distributed, tenant-aware rate limiter across replicas.

### Sync workers

- [ ] Split sync workers from the web process.
- [ ] Recover stale leases periodically, not only at startup.
- [ ] Extend leases/heartbeats during slow CRM operations.
- [ ] Wake workers across replicas with polling, `LISTEN/NOTIFY`, or a dedicated queue.
- [ ] Add per-tenant fairness and concurrency controls.
- [ ] Support global, tenant, CRM, and object-level pause controls.
- [ ] Store and monitor Salesforce CDC replay cursors continuously.

### Associations and related data

- [ ] Persist deferred associations and retry them after related records are linked.
- [ ] Paginate all association reads.
- [ ] Preserve HubSpot association labels where supported.
- [ ] Define association deletion and replacement behavior.
- [ ] Add relationship integrity and orphan detection.
- [ ] Finish owner mapping support.
- [ ] Enforce stored sync direction, filters, and enabled/disabled object mappings.

## P1 — security, privacy, and compliance

- [ ] Verify PostgreSQL TLS certificates; do not use `rejectUnauthorized: false` in
  production.
- [ ] Separate migration-owner and runtime database roles.
- [ ] Configure connection, statement, lock, and idle-transaction timeouts.
- [ ] Move encryption keys to KMS or a managed secrets service.
- [ ] Implement key rotation using the existing key-version fields.
- [ ] Remove production secret fallbacks after migration to managed secrets.
- [ ] Keep legacy plaintext `data/*.json` outside images, volumes, logs, backups, and
  support bundles.
- [ ] Remove inline-script CSP exceptions by serving versioned static assets or using
  nonces.
- [ ] Add HSTS, trusted-proxy configuration, hardened cookies/sessions, and consistent
  security headers.
- [ ] Return stable public error codes without raw exception details.
- [ ] Audit API-key changes, OAuth changes, job replay, mapping changes, delete decisions,
  logins, and permission failures.
- [ ] Define PII classification, retention, export, deletion, and support-access rules.
- [ ] Prepare privacy policy, DPA, incident response, breach handling, and customer audit
  evidence.

## P1 — database and infrastructure

- [ ] Run schema migrations as a locked release job rather than from every web replica.
- [ ] Make migrations safe for rolling deployments.
- [ ] Document forward-fix and rollback procedures.
- [ ] Correct RLS policy migration blocks so one duplicate policy cannot skip later
  tables.
- [ ] Add indexes for migration items, conflicts, schema snapshots, associations,
  deletion queues, and operational list queries.
- [ ] Add retention/archival or partitioning for `sync_events`, `migration_items`, and
  `audit_entries`.
- [ ] Monitor table growth, vacuum health, slow queries, locks, and pool saturation.
- [ ] Use managed PostgreSQL with encryption and point-in-time recovery.
- [ ] Schedule backup restore drills and record results.
- [ ] Define RPO, RTO, failover, and disaster-recovery runbooks.
- [ ] Split web, sync worker, and migration worker deployments.
- [ ] Add graceful shutdown: stop claims, drain or return leases, flush telemetry, and
  close PostgreSQL.
- [ ] Add separate liveness and readiness endpoints.
- [ ] Build a minimal non-root container with a read-only filesystem and SBOM.
- [ ] Deploy behind managed TLS, a reverse proxy/load balancer, and WAF.

## P1 — observability and operations

- [ ] Add structured request-completion logs with tenant, actor, correlation ID, status,
  and duration.
- [ ] Propagate correlation IDs into jobs, connector requests, audits, and errors.
- [ ] Add OpenTelemetry traces.
- [ ] Add metrics for queue depth, oldest-event age, latency, retries, dead letters,
  migrations, conflicts, deletes, and deferred associations.
- [ ] Track CRM request latency, `401`, `429`, `5xx`, quota headers, and token refresh
  failures.
- [ ] Alert on disconnected CRMs, webhook signature failures, schema drift, queue lag,
  dead-letter growth, migration failure, and database saturation.
- [ ] Define SLOs for webhook acknowledgement, sync freshness, migration accuracy, and
  control-plane availability.
- [ ] Write operational runbooks for every alert and common recovery procedure.

## P1 — tests and release controls

- [ ] Replace the placeholder lint command with ESLint and TypeScript-aware rules.
- [ ] Add formatting enforcement and architectural import boundaries.
- [ ] Add coverage reporting and meaningful thresholds.
- [ ] Add shared connector contract tests for mock, Salesforce, and HubSpot.
- [ ] Export the Express app and add authenticated API integration tests.
- [ ] Add property-based tests for mapping, normalization, hashing, and conflict rules.
- [ ] Add natural-key concurrency tests.
- [ ] Add timeout/crash tests around CRM mutations.
- [ ] Add migration resume, cancel, and retry tests.
- [ ] Add browser E2E tests for setup, preview, approval, execution, and conflict review.
- [ ] Add webhook burst, queue backlog, and 100k-record load tests.
- [ ] Add long-running soak tests with injected `401`, `429`, timeout, and `5xx` behavior.
- [ ] Add backup restore and disaster-recovery tests.
- [ ] Add dependency update automation, secret scanning, SAST, container scanning, and
  migration linting.
- [ ] Require branch protection, CI, reviews, and CODEOWNERS before merge.
- [ ] Create versioned releases, changelogs, deployment evidence, and rollback markers.

## P2 — cleaner and quieter application

- [ ] Split `src/server.ts` into route modules, request schemas, and application services.
- [ ] Split large inline dashboard HTML/JavaScript into maintainable static modules or
  components.
- [ ] Add Zod schemas for every request, query, webhook, and stored configuration.
- [ ] Introduce a typed error hierarchy with stable public error codes.
- [ ] Centralize pagination, limits, API responses, and audit recording.
- [ ] Enforce the dependency direction: routes → services → engines → connectors/stores.
- [ ] Remove demo endpoints and mock initialization from the production bundle.
- [ ] Replace browser `alert()` calls with actionable inline errors and correlation IDs.
- [ ] Replace rapid polling with events or adaptive polling.
- [ ] Use cursor pagination in operational views.
- [ ] Log successful per-record operations at debug and concise run summaries at info.
- [ ] Add accessibility, keyboard navigation, and responsive-layout testing.

## P2 — product differentiators

- [ ] Visual field-lineage explorer: native → canonical → native.
- [ ] Exportable migration impact report before approval.
- [ ] Automatic post-migration sample validation.
- [ ] Reconciliation score for matched, drifted, ambiguous, and orphaned records.
- [ ] Rollback or compensating-action plans where vendor APIs permit them.
- [ ] Schema-drift inbox with suggested mapping repairs.
- [ ] Sandbox-to-production promotion for reviewed mapping configurations.
- [ ] Per-field ownership explanations in every conflict.
- [ ] Bulk conflict review with reversible decisions.
- [ ] Reusable migration templates.
- [ ] Continuous duplicate detection and safe merge recommendations.
- [ ] Customer-facing sync health and downloadable audit evidence.
- [ ] Maintenance windows and scheduled backfills.
- [ ] Usage and cost forecasting before large migrations.

## Recommended implementation sequence

1. Make CRM writes idempotent and natural-key linking concurrency-safe.
2. Complete webhook validation, tenant routing, and connector-readiness gating.
3. Introduce request-scoped tenancy and real user authentication.
4. Separate web, sync, and migration workers.
5. Make migrations resumable and require approved frozen plans for all writes.
6. Complete deletion, association, conflict, and retry semantics.
7. Harden PostgreSQL, TLS, secrets, migrations, and graceful shutdown.
8. Add full API, connector, fault-injection, load, and browser testing.
9. Add metrics, alerts, backups, restore drills, SLOs, and runbooks.
10. Clean the server/dashboard structure and remove production demo noise.
11. Run a controlled single-tenant pilot.
12. Run a multi-tenant beta before public general availability.

## Public go-live gates

Do not call the service production-ready until all of the following are true:

- [ ] No open P0 item.
- [ ] Cross-tenant isolation tests pass using the actual production database role.
- [ ] Duplicate-write fault tests pass for creates and updates in both CRMs.
- [ ] A production-shaped migration can stop and resume without duplicate records.
- [ ] Webhook replay, signature, burst, and timeout tests pass.
- [ ] A multi-day soak test finishes without unexplained drift.
- [ ] Queue lag, migration failures, dead letters, auth failures, and database health have
  working alerts.
- [ ] Backup restoration has been demonstrated in a clean environment.
- [ ] Security review and threat model are complete.
- [ ] Privacy, retention, support-access, and incident-response procedures are approved.
- [ ] Salesforce and HubSpot public app requirements are complete.
- [ ] Pilot customers have reconciled results with no unexplained data loss or duplication.
- [ ] Deployment, rollback, failover, and incident runbooks have been exercised.

## Deferred external work

Public deployment, HubSpot webhook activation, billing-provider integration, Salesforce
CDC/Pub/Sub, and generic custom-object execution remain deferred. Do not perform those
external actions without explicit user approval.
