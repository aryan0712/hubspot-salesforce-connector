# Migration Copilot

Migration Copilot is a read-only assistant inside the schema-preflight step of `/ops`.
It explains blockers and warnings, recommends where an operator should review the plan,
and provides navigation back to the relevant workspace.

The deterministic migration engine remains authoritative. Copilot cannot save mappings,
approve a plan, generate a preview, or execute CRM writes.

## Configure in the app

1. Open `http://localhost:3000/ops#settings`.
2. Select **Replace key** or **Save key**.
3. Paste an OpenAI project API key.
4. Select **Save key**.

The server validates the key with OpenAI before saving it, encrypts it in PostgreSQL with
the application encryption key, and activates it immediately. The key is write-only: the
browser receives only configuration status, a one-way fingerprint, and the active model.

`OPENAI_API_KEY` remains an optional deployment fallback:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-sol
```

An encrypted workspace key takes precedence over the environment fallback. Removing the
workspace key returns to the fallback when one exists. `OPENAI_MODEL` is optional; the
default follows the current GPT-5.6 model guidance.

The implementation uses the OpenAI Responses API with Structured Outputs and
`store: false`. Requests include a stable one-way hash of the authenticated actor as the
provider safety identifier. See the official [Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
documentation.

## Operator flow

1. Save a migration plan.
2. Run schema preflight.
3. Select **Ask Copilot**.
4. Review each explanation and suggested next step.
5. Use the contextual navigation to open field, value, owner, relationship, or object
   settings.
6. Make changes manually, save the plan, and rerun preflight.

Changing the plan or any mapping invalidates both the prior preflight and prior Copilot
analysis.

## Data boundary

The server builds Copilot input itself from the authenticated, tenant-scoped migration
plan. The browser cannot submit an arbitrary prompt.

Sent to OpenAI:

- migration direction and plan revision
- selected canonical object types
- preflight issue codes, severities, field names, and messages
- field mapping names, transforms, read-only flags, and field ownership
- schema field counts

Never sent:

- CRM record values or natural-key values
- Salesforce or HubSpot record IDs
- OAuth tokens, client secrets, or app credentials
- schema hashes
- database credentials or encryption keys

Inputs are bounded to three canonical objects, thirty issues, six mapping sets, and one
hundred rules per mapping set. CRM and mapping strings are treated as untrusted data in
the system instruction.

## Safety and failure behavior

- The endpoint requires the `operator` role.
- Reading, replacing, or removing the provider key requires the `admin` role.
- Replacement keys are validated before the database or active runtime is changed.
- Workspace keys use tenant-scoped AES-256-GCM storage and forced row-level security.
- The provider response must match a strict JSON schema and is validated again with Zod.
- Readiness is recomputed from deterministic preflight results; the model cannot mark an
  error as ready.
- Finding identity is checked against actual preflight issues; invented findings are
  discarded.
- Every recommendation is forced to `requiresApproval: true`.
- No model tools are configured, so the model has no mutation path.
- Provider authentication errors, rate limits, refusals, timeouts, malformed responses,
  and missing configuration are converted to safe operator-facing errors.
- Audit history records only model name, readiness, and finding count—not prompt or
  response content.

Before public launch, add representative preflight evals, per-tenant AI usage limits,
latency/cost telemetry, retention policy review, and a documented model-upgrade process.
