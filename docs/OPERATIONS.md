# Operations guide

This guide is for the people who deploy and run crm-sync. For security design, see
[SECURITY_MODEL.md](SECURITY_MODEL.md). For inbound events, see [WEBHOOKS.md](WEBHOOKS.md).

## Local boot

1. Start project-local PostgreSQL with `npm run db:local`.
2. Keep the generated `data/.encryption-key` safe. It encrypts every stored OAuth token
   and secret.
3. Run `npm run db:migrate`, then start with `npm run dev`.
4. If you are upgrading from the JSON build, run `npm run db:import-legacy -- --confirm`.
   The legacy `data/*.json` files are only read, and they are kept.
5. Check `/health/ready`, then `/api/status` and `/api/readiness`.

The local database lives in `data/postgres/`. Both it and the key file are gitignored and
excluded from images (`.dockerignore`). Never delete, rewrite or commit anything under
`data/`.

## Deployment

The image is built from `Dockerfile` and contains no state and no secrets. One image runs
three roles:

| Role | Command | Notes |
| --- | --- | --- |
| Release step | `node dist/db/migrate.js` | Runs as the schema owner (`DATABASE_MIGRATION_URL`). An advisory lock serializes it, so concurrent deploys cannot race. It grants the runtime role data privileges. |
| Web | `node dist/server.js` | Use `RUN_WORKERS=false` when workers run separately. |
| Workers | `node dist/worker.js` | Sync, polling, the webhook inbox, migrations, alert digests and daily retention. Multiple replicas are safe (leases and advisory locks). |

Required production settings:

| Setting | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `AUTH_REQUIRED` | `true` |
| `DATABASE_URL` | The runtime role: not a superuser, no BYPASSRLS, not the schema owner. The process refuses an unsafe role in production. |
| `DATABASE_MIGRATION_URL` | The schema-owner role. |
| `DATABASE_SSL` | `true`, with `DATABASE_SSL_CA` set to the provider's CA bundle. Certificates and hostnames are verified. `DATABASE_SSL_INSECURE` is refused in production. |
| `APP_ENCRYPTION_KEY` and `APP_ENCRYPTION_KEY_VERSION` | From the secret manager. |
| `PUBLIC_BASE_URL` | The exact HTTPS origin. |
| `METRICS_TOKEN` | Required for `/metrics`. |

Database timeouts:

| Setting | Default |
| --- | --- |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 30,000 |
| `DATABASE_LOCK_TIMEOUT_MS` | 10,000 |
| Idle-in-transaction timeout | 60 s |
| `DATABASE_POOL_MAX` | 10 |

Choosing managed hosting, KMS, WAF and production alert destinations is an explicit
environment decision. It is not made here.

## Health, metrics and alerts

- **Liveness.** `GET /health/live` answers 200 while the process runs. Restart the process
  only if liveness fails.
- **Readiness.** `GET /health/ready` answers 503 in three cases: while the process is
  draining for shutdown, when the database is unreachable, and when this build has
  migrations the database has not applied. Load balancers should route on readiness.
- **Metrics.** `GET /metrics` serves the Prometheus text format and needs
  `Authorization: Bearer $METRICS_TOKEN`.
  - Event counters and histograms: HTTP requests and latency, authentication failures,
    webhook outcomes, and refused migration writes.
  - Gauges: sync jobs by status, age of the oldest pending change, webhook inbox backlog,
    CRM circuit state, database pool, active alerts, and shutdown state.
- **Alerts.** `GET /api/alerts` lists a workspace's alerts. The same alerts are included
  in the email digest, at most once a day per alert. They are:
  - database unreachable;
  - sync stale (older than 15 minutes);
  - dead letters;
  - changes waiting for review;
  - CRM unavailable or must be reconnected;
  - migrations paused, failed or partial (drift called out);
  - webhook backlog.

  `deploy/prometheus-alerts.yml` has matching Prometheus rules.
- **Correlation.** Every request gets an `X-Request-Id`; a safe caller-supplied id is kept.
  Every log line carries the request, workspace and job ids, and API errors return the id
  as `requestId` (shown in the UI as "Reference").

## Email alerts

A digest is recorded **before** it is sent, together with the issues it covers, and is
marked `sent` only after the SMTP server accepts it. You can review delivery state at
`GET /api/notifications/deliveries` (admin).

| Status | Meaning |
| --- | --- |
| `sent` | The SMTP server accepted the email. |
| `failed` | Sending failed. It is retried with backoff (1 min, 4 min, 16 min, … up to 6 h). |
| `abandoned` | Sending failed 8 times. |
| `unconfigured` | No SMTP transport is set up. The digest is sent once one is configured. |

A restart never re-sends alerts for issues that were already covered.

## Migration rollout

1. Confirm the source and target accounts. They are shown with their org and portal ids.
2. Run schema preflight. Resolve mapping issues, then run preflight again.
3. Run and verify a one-record test for every selected object.
4. Prepare (preview) the full migration and review creates, updates, matches and anything
   marked for review.
5. Execute the prepared preview. Runs are durable: they can be paused, resumed (optionally
   retrying failures) or cancelled, and a run survives restarts.
6. Reconcile record counts. Relationships are not migrated (records-only scope).

A migration request without `"confirm": true` is only a preview. A confirmed request must
name the preview it approves (`previewRunId`).

## Sync jobs

Inbound deliveries are persisted to the webhook inbox before they are acknowledged. Workers
turn them into `sync_events` rows. Workers claim jobs with leases
(`FOR UPDATE SKIP LOCKED` plus lease tokens), so one record is processed by one worker at
a time.

| State | Meaning |
| --- | --- |
| `queued` | Ready for a worker. |
| `processing` | Leased by a worker. An expired lease is recovered by any worker. |
| `retry` | A transient failure; retried with backoff that respects `Retry-After`. |
| `manual_review` | Waits for a person: a delete to approve, an ambiguous match, or a vendor error that retrying cannot fix. |
| `dead_letter` | The retry budget is exhausted. |
| `dismissed` | An operator gave up on the job. |
| `completed` | Processed, or intentionally ignored. |

Use `/ops#activity` to inspect jobs and replay them, review conflicts, and (as an admin)
read the audit log.

## Deletes

`DELETE_POLICY` takes one of three values:

- `manual-review` (the default): records an approval request and pauses the job.
- `ignore`: records the event and does not delete the destination record.
- `cascade`: deletes or archives the linked destination record.

An approved delete leaves a tombstone, so late or replayed events never recreate the
record. An admin can restore it (`/api/tombstones/:linkId/restore`). Use `cascade` only
after you have validated retention and compliance requirements.

## Data retention

Workers apply retention daily. To run it once by hand: `npm run db:retention`.

| Data | Rule |
| --- | --- |
| Completed or dismissed sync jobs | Purged after 30 days. |
| Processed webhook inbox rows | Purged after 30 days. |
| Sent or abandoned notification deliveries | Purged after 30 days. |
| Committed or abandoned write intents | Purged after 30 days. |
| Expired replay nonces and OAuth states | Purged once expired. |
| Ended sessions and login attempts | Purged after 30 days. |
| Audit entries, conflicts, tombstones, migration plans, runs and items, record links, and unresolved write intents | Always kept. |

Watch table growth with `crm_sync_sync_jobs` and `crm_sync_webhook_inbox_pending`. For
per-table sizes, query `pg_total_relation_size`.

## Secrets and key rotation

Stored secrets are AES-256-GCM encrypted and bound to their row. The ciphertext carries
the key version (`v<N>.`). To rotate the key:

1. Deploy with the new key as `APP_ENCRYPTION_KEY`, raise `APP_ENCRYPTION_KEY_VERSION`,
   and list the old key under `APP_ENCRYPTION_PREVIOUS_KEYS` (format `1:<old key>`).
2. Run `npm run secrets:rotate` (a dry run), then `npm run secrets:rotate -- --confirm`.
   This re-encrypts every stored secret in every workspace, and it is safe to run again.
3. When a dry run reports `rotated: 0`, remove the old key from
   `APP_ENCRYPTION_PREVIOUS_KEYS`.

Never lose a key that stored values still use: tokens encrypted with it cannot be
recovered. The local `data/.encryption-key` is never rewritten by rotation.

## Backup and restore

**Production.** Use the managed database's point-in-time recovery. The **encryption key
must be backed up separately**, in the secret manager, with its version history. A restored
database without its key is unreadable.

- **Recovery point objective:** the provider's point-in-time recovery granularity,
  typically under 5 minutes.
- **Recovery time objective:** provider restore time plus under 1 minute for the
  application: deploy, run migrations (a no-op), and wait for readiness.

**Exercised restore.** `test/operationsRecovery.test.ts` runs on every test run:

1. It stops a cluster holding encrypted OAuth tokens and copies the data directory and the
   key.
2. It restores the copy into a clean environment on a new port.
3. It decrypts the tokens with the backed-up key and checks that a wrong key cannot
   decrypt them.

**Measured on 2026-09-24: 5.8 s from the start of the restore copy to the first decrypted
secret.** That is a small dataset on a development machine; the data-loss window for this
cold copy is everything since the copy was taken.

The most critical tables:

- `crm_connections` and `oauth_app_credentials`;
- `record_links`, `record_link_sides` and `record_natural_keys`;
- `field_mappings`;
- `migration_plans` and `migration_executions`;
- `write_intents`;
- `sync_events` and `webhook_inbox`.

## Upgrades and rollback

Schema changes are additive and versioned. Run the release step before new web and worker
processes start.

Do **not** roll back to an older build once newer writers have written new
intent, lease, hash or delivery semantics. Instead:

1. Pause workers: scale them to 0, or set `RUN_WORKERS=false`.
2. Ship a forward fix.
3. Resume. Queued work, leases and paused migration runs are recovered automatically.

## Incident response

1. **Assess.** Check `/health/ready`, `/api/alerts` and the `crm_sync_alert_active`
   metric. Find the affected request or job by its reference id in the logs.
2. **Contain.**
   - Pause sync for an object from the Sync tab.
   - Pause migration runs from the run banner.
   - Scale workers to 0 to stop all CRM writes. Queued work is kept.
3. **CRM credentials.** A "must be reconnected" alert means an admin reconnects the CRM
   from `/`. If a different account is connected, the replacement has to be confirmed, and
   confirming invalidates prepared migrations.
4. **Suspected secret exposure.** Rotate the encryption key (above). Revoke API keys and
   sessions: removing a member revokes their sessions. Rotate the OAuth app secrets with
   the vendors.
5. **Record.** Write the timeline and link the request ids. The audit log keeps connection,
   member, API key, mapping and approval changes.

## Support access

Support staff act through their own accounts, added as workspace members with the least
role needed (`viewer` to inspect, `operator` to replay or resolve). Their actions are
audited under their identity. They never use the owner's session or the encryption key,
and are removed when the support case is closed.

## HubSpot subscriptions

The checked-in example intentionally contains `YOUR_PUBLIC_HOST`. A public webhook URL is
an external deployment decision and must not be guessed. After choosing it:

1. Copy the example to `hubspot-app/src/app/webhooks/webhooks-hsmeta.json`.
2. Replace the placeholder with the exact HTTPS origin.
3. Add subscriptions for any custom mapped properties.
4. Run `hs project validate`.
5. Upload or deploy only after reviewing the resulting build.

## Scanning

| Command | What it checks |
| --- | --- |
| `npm run scan:secrets` | Tracked and new files for credentials and tracked local state. It prints the file, line and rule name, never the secret itself. |
| `npm run audit:deps` | Production dependencies. Fails on high-severity advisories. |
