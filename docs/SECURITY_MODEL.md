# Security model: identity, tenancy and privileges

This document describes the model delivered by remediation package R11. Evidence lives in
`test/authSessions.test.ts` (HTTP, sessions, CSRF, OAuth) and
`test/tenantIsolation.test.ts` (PostgreSQL with the restricted runtime role).

## Modes

| Setting | Behavior |
| --- | --- |
| `AUTH_REQUIRED=false` | Local development only. Every request acts as the local owner of `DEFAULT_TENANT_SLUG`. The runtime guard refuses this setting in production and on any non-loopback `PUBLIC_BASE_URL`. |
| `AUTH_REQUIRED=true`, `TENANCY_MODE=single` | Sessions and API keys are required. One workspace is served per process; a session for another workspace gets `403 workspace_not_served`. |
| `AUTH_REQUIRED=true`, `TENANCY_MODE=multi` | Each request and job runs for the authenticated workspace. The process builds one isolated App per workspace (configuration, stores, connectors, workers). Tenant stores cannot be reached outside a tenant scope; they fail closed. The runtime guard requires `AUTH_REQUIRED=true` in this mode. |

## Identity and sessions

- **Identity provider.** The provider is pluggable (`IdentityProvider` in
  `src/security/identity.ts`). The built-in `LocalPasswordProvider` hashes passwords with
  salted scrypt. Choosing an external OIDC/SAML provider is still an open product
  decision; that provider would verify the user and then call `SessionService.issue()`.
  The first owner of an empty workspace comes from `BOOTSTRAP_OWNER_EMAIL` and
  `BOOTSTRAP_OWNER_PASSWORD`, which never overwrite existing members.
- **Sessions** are stored server-side (`user_sessions`). The browser holds a random token
  in an `HttpOnly; SameSite=Lax` cookie; the cookie is `Secure` when served over HTTPS.
  Only the token's SHA-256 hash is stored.
  - Idle expiry is 30 minutes (sliding) and absolute expiry is 12 hours.
  - Logout, member removal and workspace switching revoke the session. Switching also
    rotates it.
  - Each request re-reads the membership, so role changes and removals apply immediately.
- **CSRF.** Every unsafe request made with a session must send `X-CSRF-Token`. Pages read
  the token from the `crm_csrf` cookie, and the server compares it with the hash stored
  in the session. `POST /auth/login` and `/auth/logout` also reject cross-origin form
  posts.
- **Login throttling** uses a 15-minute window:
  - 5 failures per email and IP;
  - 20 failures per email across all IPs;
  - 50 failures per IP.

  Unknown accounts are verified against a dummy hash, so response timing does not reveal
  which accounts exist.
- **API keys** are for machines only.
  - They are accepted only as `Authorization: Bearer`, never from a cookie, so they
    cannot be used for CSRF.
  - New keys embed their workspace id and are verified inside that workspace. Changing
    the embedded id does not verify.
  - Keys created before R11 are verified in the default workspace only.

## Tenancy

- Every tenant-owned table has `FORCE ROW LEVEL SECURITY` with a policy on
  `app.tenant_id`. `test/tenantIsolation.test.ts` enumerates all tables that have a
  `tenant_id` column to check this.
- There are three global tables, none holding tenant data:
  - `users` (identity);
  - `user_sessions`, which is looked up only by token hash;
  - `account_routes` (R12), which maps a CRM account to its workspace so an inbound
    webhook can be routed.
- Memberships stay in the tenant table `tenant_users`. At sign-in, a transaction can see
  only the signed-in user's own memberships (policy `tenant_users_self`, keyed on
  `app.user_id`).
- Requests are bound to their workspace App and tenant scope (`src/tenancy.ts`,
  `src/core/tenantScope.ts`). Connectors run every call inside their workspace's scope,
  so OAuth tokens and app credentials are always that workspace's, whoever calls them:
  a request, the sync worker or a poller timer.
- Ids from another workspace behave exactly like ids that do not exist (`404`). Malformed
  ids also return `404`, not `500`.

## OAuth connections

- Only an authenticated admin can start OAuth, from a browser session or local
  development; API keys cannot.
- The state is random and stored hashed, with the PKCE verifier encrypted, in
  `oauth_states`. It is single-use and expires after 10 minutes.
- The state is bound to the session, user, workspace, system, environment and redirect
  URI. The following are all refused the same way (`oauth_state_invalid`):
  - a callback to the wrong system;
  - a callback from another session;
  - a reused or expired state.
- The exact account is recorded: the Salesforce org id comes from the identity URL and
  the HubSpot portal id from the token metadata. Re-authorizing the same account replaces
  its tokens.
- Connecting a **different** account is staged, encrypted, until the same admin session
  confirms it. Confirming, or disconnecting, invalidates every prepared or approved
  migration. Connecting, re-authorizing, replacing, cancelling and disconnecting are all
  audited.

## Database privileges

- The runtime connects as a role that is not a superuser, does not have `BYPASSRLS`, and
  owns no tables (table owners can disable row-level security).
- Migrations run as a separate schema-owner role (`DATABASE_MIGRATION_URL`). That role
  grants the runtime role data privileges only and removes its write access to
  `schema_migrations`.
- At startup the process checks its role and refuses to run in production with an unsafe
  one (`src/db/roles.ts`).
- The test suite uses the same split: each test database has an owner role and a
  restricted runtime role.

## Role matrix

Roles are cumulative: viewer < operator < admin < owner. Every unsafe `/api` route
declares a minimum role, and `test/authSessions.test.ts` fails if a new route does not.

| Minimum role | Routes |
| --- | --- |
| viewer (any member) | All `GET` routes not listed below, including status, activity, plans, executions, migrations, jobs, conflicts, tombstones, mappings, catalog, usage and the session. `POST /api/session/workspace` (switch to another workspace the user belongs to). |
| operator | Plans: create/update, preflight, preview, test record/batch preview and execute, execute. Executions: pause/resume/cancel. `POST /api/migrate`. Mappings, object and value mappings. Sync: replay/dismiss jobs, poll-now, sync test, `POST /api/preflight`. Resolve conflicts. `POST /api/notifications/check-now`. |
| admin | OAuth start and callback. Confirm or cancel a connection replacement. Disconnect. App credentials (`POST /api/settings/:system`). Sync settings (`PATCH`). Approve deletes, restore tombstones. API keys, AI settings, notification settings. Read the audit log and the member list. |
| owner | Add, change or remove members (`POST/DELETE /api/members`). The last owner cannot be removed. |

## Not covered yet

- Webhook authenticity, freshness and account routing: see [WEBHOOKS.md](WEBHOOKS.md) (R12).
- Correlation ids, metrics and alerts for authentication failures are covered by R14.
