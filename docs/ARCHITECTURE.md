# crm-sync — Architecture

A bidirectional **Salesforce ⇄ HubSpot** integration that does two jobs on one foundation:

1. **Migration** — a bulk backfill that moves every record from one CRM into the other.
2. **Real-time sync** — ongoing, two-way propagation of changes as they happen.

Both jobs run through the *same* mapping + reconciliation core, so live sync inherits
migration's record linkage the instant the backfill finishes.

All durable product state lives in PostgreSQL. Mock connectors and in-memory repositories
exist only for tests and the demo.

---

## The central idea: a canonical model

Salesforce and HubSpot never talk to each other directly. Every record is translated
**into** a neutral `CanonicalRecord` and **out of** it:

```
Salesforce record ──▶ toCanonical ──▶ CanonicalRecord ──▶ fromCanonical ──▶ HubSpot record
        ▲                                                                        │
        └──────────────────────── (same path, reversed) ◀────────────────────────┘
```

Benefits:
- Migration and sync share one translation layer (`src/core/mapping.ts`).
- Conflict logic reasons about one neutral shape, not two vendor schemas.
- A third system later = one new connector + one mapping column.

Object coverage today: **contact ⇄ Contact**, **company ⇄ Account**, **deal ⇄ Opportunity**.

---

## Components

| Layer | File | Responsibility |
|-------|------|----------------|
| Canonical model | `core/types.ts` | Neutral record + change-event shapes |
| Connector contract | `core/connector.ts` | The one interface every CRM implements |
| Field mapping | `core/mapping.ts` | native ⇄ canonical translation + transforms |
| ID map | `core/idMap.ts` | Cross-system id links, content hashes, echo detection |
| PostgreSQL | `db/` + `db/migrations/` | Tenant-isolated durable state and repositories |
| Mapping config | `core/mappingStore.ts` | Field rules, transforms, field ownership |
| Conflict resolution | `core/conflict.ts` | source-of-truth / last-write-wins / field-merge |
| Salesforce connector | `connectors/salesforce/*` | OAuth, SOQL read, sObject upsert, webhook verify |
| HubSpot connector | `connectors/hubspot/*` | Private-app/OAuth, CRM v3 read/upsert, webhook verify |
| Reconciler | `engine/reconciler.ts` | The heart: link → dedupe echoes → resolve → write |
| Migration engine | `engine/migrationEngine.ts` | Bulk streaming backfill |
| Sync engine | `engine/syncEngine.ts` | Real-time queue over webhook events |
| Event store | `engine/syncEventStore.ts` | Idempotent leases, retries, dead letters, replay |
| Associations | `engine/associationEngine.ts` | Contact/company/deal relationship propagation |
| Preflight | `engine/preflight.ts` | Schema drift, required fields, and type validation |
| HTTP server | `server.ts` | Webhook + OAuth endpoints |
| CLI | `cli/migrate.ts` | Run the backfill |

---

## Real-time data flow

```
 HubSpot ──webhook──▶ /webhooks/hubspot ─▶ verify sig ─▶ SyncEngine.enqueue
                                                              │
                                                    read full record + canonicalize
                                                              │
                                                        Reconciler.reconcile
                                                              │
                    ┌─────────────────────────────────────────┼──────────────────────────┐
                    ▼                                          ▼                          ▼
             find/create Link                          echo? drop it              conflict? resolve
             (id map / natural key)                                                     │
                                                                                        ▼
                                                                          upsert winner ▶ Salesforce
```

The reverse direction is symmetric (`/webhooks/salesforce`).

---

## The three hard problems & how we solve them

### 1. Infinite loops (echoes)
When we write to HubSpot, HubSpot fires a webhook back at us describing *our own* write.
Without protection, that would bounce back to Salesforce, forever.

**Solution — content hashing in the ID map.** After every write we store
`hash(canonical fields)` per system on the `Link`. When a webhook arrives we hash the
incoming record; if it equals the hash we last wrote for that system, it's an echo and we
drop it (`reconciler.ts`, step 2).

### 2. Duplicate records on first sync
Both CRMs already contain overlapping data. A naive backfill creates twins.

**Solution — natural-key matching.** Before creating a new link we look up a business key
(email for contacts, domain for companies, name for deals) in the id map. A match links
the two records instead of duplicating (`idMap.ts::naturalKey`, `reconciler.ts::findOrCreateLink`).

### 3. Conflicting concurrent edits
The same record changes in both systems between reconciliations.

**Solution — pluggable strategy** (`conflict.ts`, set via `CONFLICT_STRATEGY`):
- `source-of-truth` — one system always wins wholesale.
- `last-write-wins` — newer `modifiedAt` wins wholesale (default).
- `field-merge` — per-field newest-wins, non-null beats null.

---

## Migration ↔ sync unification

`MigrationEngine.run()` streams records from the source connector and calls the **same**
`Reconciler.reconcile()` the live engine uses. So the backfill also populates the id map.
The instant migration finishes, real-time sync already knows how every record lines up —
no separate "linking" phase, no drift between the two code paths.

Bidirectional seed = run migration once per direction; the second pass links to (never
duplicates) records the first created, thanks to natural-key matching.

---

## PostgreSQL control plane

The schema separates operational concerns instead of using one JSON document:

```
tenants
 ├─ oauth_app_credentials ── encrypted client secrets
 ├─ crm_connections ──────── encrypted refresh/access tokens
 ├─ field/value mappings ─── runtime mapping configuration
 ├─ record_links
 │   ├─ record_link_sides ── native IDs, hashes, timestamps
 │   ├─ record_natural_keys
 │   └─ record_associations
 ├─ migration_runs ───────── migration_items
 ├─ sync_events ──────────── durable jobs and replay
 ├─ conflicts / deletion_requests / audit_entries
 └─ subscriptions / usage_counters / api_keys
```

Repositories execute inside transactions that set `app.tenant_id`. Row-level security is
enabled and forced on every tenant table. OAuth material is encrypted with AES-256-GCM
using tenant/system-specific authenticated context.

## Durable event flow

Webhook delivery follows:

```
verify signature → normalize → INSERT sync_events → acknowledge 2xx
                                      │
                       claim with SKIP LOCKED
                                      │
                 reconcile → complete / retry / review / dead letter
```

Vendor event identities make ingestion idempotent. Worker leases older than five minutes
are recovered at startup. Retries use capped exponential backoff, and operators can replay
manual-review or dead-letter events.

## Remaining deployment work

- Run Salesforce Change Data Capture through Pub/Sub API and commit Replay IDs to
  `webhook_cursors`. `SalesforceCdcWorker` already provides the persistence/commit
  orchestration; a deployment-specific gRPC/Avro transport and Salesforce CDC enablement
  are still required. The signed Salesforce webhook remains a supported fallback.
- Choose a stable public HTTPS origin, instantiate the HubSpot webhook component from the
  checked-in example, and deploy it.
- Put the service and PostgreSQL in managed infrastructure with backups and alerting.
- Add a distributed rate-limit coordinator when running more than one application replica.
- Complete external billing-provider callbacks and formal compliance work before selling
  regulated-data plans.

---

## Extending

- **New field**: add a matching row to both systems' tables in `mapping.ts`.
- **New object type**: add an `object_mappings` row, its field/value mappings, connector
  metadata, and object-specific association behavior.
- **New CRM**: implement `CRMConnector`, add a mapping column, register it in `app.ts`.
