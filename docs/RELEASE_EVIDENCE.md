# Release evidence

Consolidated evidence for the 2026-09-24 remediation effort (R01–R15,
[docs/REMEDIATION_PLAN.md](REMEDIATION_PLAN.md)). Each package's own evidence line in that
plan is authoritative for exactly which test file proves which behavior; this document
gathers the verification commands, current counts, and load/timing results in one place
for a release or pilot go/no-go conversation.

The automated numbers below come from mock connectors and isolated, embedded PostgreSQL
clusters. Read-only checks against the connected Salesforce and HubSpot accounts on
2026-09-28 are documented separately in
[BIDIRECTIONAL_VERIFICATION.md](BIDIRECTIONAL_VERIFICATION.md). No live CRM records were written.

## How to reproduce this evidence

```bash
npm run lint              # ESLint, including the architectural layer rules
npm run typecheck         # tsc --noEmit against src/
npm run typecheck:test    # tsc --noEmit against src/ + test/
npm run scan:secrets      # tracked/new files for credentials
npm test                  # the unit/integration suite below
npm run build
npm run demo              # end-to-end mock-CRM walkthrough
npm run test:browser      # real Chrome/Edge against the HTTP app
npm run audit:deps        # production dependency advisories
npm run test:load             # R08 migration throughput (opt-in, ~minutes)
npm run test:load:webhooks    # R12 webhook acknowledgement latency (opt-in)
```

The test suite, browser suite, lint, both typechecks, build, demo, and secret scan passed
on 2026-09-28 (Windows, Node 24). The dependency audit result below is from 2026-09-24.

## Test counts

| Suite | Command | Result |
| --- | --- | --- |
| Unit / integration | `npm test` | 36 files, 353 tests passed, 2 skipped (load tests, gated behind `RUN_LOAD_TESTS=1`) |
| Browser (real Chrome/Edge) | `npm run test:browser` | 12 tests passed |
| Load — webhook ingress | `npm run test:load:webhooks`* | 21 tests passed (includes the 2 gated above) |
| Static analysis | `npm run lint`, `npm run typecheck`, `npm run typecheck:test` | clean |
| Secrets | `npm run scan:secrets` | 0 findings across all tracked and new files |
| Dependency audit | `npm run audit:deps` | 1 moderate advisory (transitive, `qs`), below the high-severity gate |
| Build | `npm run build`, `npm run demo` | pass |

\* `npm run test:load:webhooks` runs `test/webhookIngress.test.ts` with load tests enabled;
`npm run test:load` (below) is the separate, larger R08 migration-throughput script.

Every review finding tracked in the plan maps to at least one of the test files named in
that package's evidence line; none of the packages above rely on manual verification alone.

## Load and timing evidence

### R08 — durable migration execution throughput (`npm run test:load`)

| Store | Records | Preview | Execute | Throughput | Peak heap | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| In-memory | 100,001 | 7.7 s | 19.1 s | 3,740 records/s | 1.1 GB | Every record created exactly once; heap includes the in-memory stores by design. |
| PostgreSQL | 2,000 | 4.5 s | 19.9 s | 82 records/s | 50 MB | ~16.5 commits/record (33,080 total): 16,808 inserts, 8,061 updates, 1.97 M tuples fetched. Batching writes is the known next optimization before very large tenant runs — do not extrapolate this rate to a multi-hundred-thousand-record production migration without it. |

A 20,000-record PostgreSQL run exceeded 10 minutes before the query-plan fixes that
produced the numbers above (indexed operation-base lookups instead of a `left()` prefix
scan; see the plan's R08 section).

### R12 — webhook acknowledgement latency (`npm run test:load:webhooks`)

Measured with every delivery of the burst in flight concurrently, workers paused (as with
`RUN_WORKERS=false` plus a separate worker process):

| Store | Deliveries | Events/delivery | p50 | p95 |
| --- | --- | --- | --- | --- |
| In-memory | 200 | 50 | 213–265 ms | 301–389 ms |
| PostgreSQL | 100 | 20 | 145–241 ms | 165–244 ms |

Two runs are shown because the range varied slightly by machine load; both are well inside
the 2 s / 5 s budgets the tests assert. HubSpot's own response-timeout and maximum-batch-size
requirements could not be confirmed in current vendor documentation (checked 2026-09-24)
and are not assumed — see [WEBHOOKS.md](WEBHOOKS.md).

### R14 — backup and restore (`test/operationsRecovery.test.ts`, runs in `npm test`)

A cluster holding encrypted OAuth tokens is stopped, its data directory and encryption key
are copied ("backup"), and the copy is restored into a clean cluster on a new port
("restore") and the tokens decrypted with the backed-up key.

- **Measured:** 5.8 s from the start of the restore copy to the first successfully
  decrypted secret (small dataset, development machine — not a production-scale number).
- **Recovery point objective:** the managed provider's point-in-time recovery granularity
  (typically under 5 minutes) — not independently measured here.
- **Recovery time objective:** provider restore time plus well under a minute of
  application startup (migrate — a no-op on an up-to-date backup — then wait for
  readiness).
- A wrong key is confirmed unable to decrypt the restored secrets (fail-closed).

See [OPERATIONS.md](OPERATIONS.md) for the full backup/restore and incident-response
runbook.

## Static and dependency verification

- **Lint** (`npm run lint`): ESLint with `typescript-eslint`'s recommended rules plus
  project rules — no bare `console.log` under `src/` (CLIs excepted), and architectural
  layer boundaries (`eslint.config.js`): core depends on nothing app-specific; engines
  depend on core contracts only, never connector or database implementations; connectors
  implement core contracts only; HTTP routes go through services and contracts, never
  connectors or the database directly.
- **Typecheck** (`npm run typecheck`, `npm run typecheck:test`): `src/` and, separately,
  `src/` + `test/` together (`tsconfig.test.json`) — vitest's esbuild-based test runner
  does not itself typecheck, so this is the only thing that would have caught the type
  errors fixed in this pass (invalid generic assertions, un-narrowed `unknown` from
  `fetch().json()`, an interface/implementation signature drift in the in-memory sync
  store, and DOM globals used inside real-browser `page.evaluate()` callbacks).
- **Secret scan** (`npm run scan:secrets`): every tracked and newly created file, checked
  for private keys, cloud/vendor API key patterns (AWS, OpenAI, HubSpot, Salesforce,
  Slack, GitHub) and connection strings with an embedded password, plus a check that no
  `data/*` state or `.env` file is tracked. It prints only the file, line and rule name —
  never the matched text — so the scan itself cannot leak a secret into a log.
- **Dependency audit** (`npm run audit:deps`): production dependencies only
  (`--omit=dev`), failing on high/critical advisories. One moderate, transitive advisory
  (`qs`) remains open; it is below the gate and tracked for a routine dependency bump.

## CI

`.github/workflows/ci.yml` runs, on every push and pull request, against a real
`postgres:17-alpine` service (distinct from the embedded cluster the test suite creates
for itself, so the release migration step is exercised against a standard server): secret
scan, lint, both typechecks, `db:migrate`, the full test suite, the build, the real-browser
suite (GitHub-hosted `ubuntu-latest` runners ship Google Chrome, so no browser download
step is needed), and the dependency audit.

## What this evidence does not cover

- Live CRM write paths and vendor webhook delivery; read-only account checks are reported
  in [BIDIRECTIONAL_VERIFICATION.md](BIDIRECTIONAL_VERIFICATION.md).
- A multi-day soak test, chargeback/quota load beyond the R08 numbers above, or
  property-based mapping/hash fuzzing — not built in this pass; see
  [REMEDIATION_PLAN.md](REMEDIATION_PLAN.md) R15's remaining items.
- Managed hosting, KMS/secret-manager, WAF, production alert routing, and a point-in-time
  recovery restore measured on the actual chosen provider — explicit environment decisions
  called out as remaining in R14.
- R13's remaining items: page scripts are plain external JS, not yet typed TypeScript
  modules; a further ~2,270-line slice of `src/httpApp.ts` (beyond the governance router
  already extracted to `src/http/`) is not yet split into route modules.
