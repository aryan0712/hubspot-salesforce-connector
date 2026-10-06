# Webhook ingress

This document describes the model delivered by remediation package R12. The code is in
`src/webhooks/` and `src/engine/webhookInboxProcessor.ts`. The tests are in
`test/webhookIngress.test.ts`.

## Pipeline

1. **Size limit.** Bodies over 1 MB are refused with `413` before they are parsed. A
   delivery may contain at most 1,000 events.
2. **Validate** the payload structure, event types, ids and timestamps (zod).
3. **Route by account.** In multi-tenant mode, the delivery goes to the workspace
   connected to the account it names: the HubSpot `portalId` or the Salesforce org id.
   Each CRM account can belong to only one workspace (`account_routes`).
4. **Verify** the signature and its freshness with that workspace's secret.
5. **Check the account.** The account must be the workspace's connected account.
6. **Persist** the delivery to the workspace's inbox (`webhook_inbox`), and only then
   **acknowledge** it. Redeliveries of the same vendor event collapse onto one row.
7. **Resolve later.** An initialized worker turns inbox rows into sync jobs. This step
   covers object-type resolution, including HubSpot custom-object type ids and CRM reads
   for native objects shared by several canonical objects.
   - Rows for objects the workspace does not sync are discarded **with a recorded reason**.
   - Transient failures are retried with backoff.
   - Before R12, events that arrived before connectors were initialized were acknowledged
     and dropped. That no longer happens.

## Responses

| Status | Meaning | Reasons |
| --- | --- | --- |
| 200 | Verified and persisted, whether new or a duplicate. | — |
| 400 | Malformed. Retrying cannot succeed. | `malformed`, `mixed_accounts` |
| 401 | Not authentic. | `bad_signature`, `stale_timestamp`, `future_timestamp`, `replayed`, `legacy_signature_disabled` |
| 403 | Not for any workspace, or not for this workspace's account. | `unknown_account`, `account_mismatch` |
| 413 | Too large. | `oversized`, `too_many_events` |
| 503 | Cannot be accepted right now. The sender should retry. | `secret_unavailable`, `backlog_full` (`WEBHOOK_MAX_BACKLOG`), `internal_error` (e.g. database unavailable) |

A persistence failure stores nothing, including the nonce, so the sender's retry is
accepted normally. Counters for each outcome, plus acknowledgement latency, are kept per
workspace and served at `GET /api/webhooks/stats`. Signature, replay, freshness and
account failures are also recorded in the workspace's activity log.

## HubSpot (signature v3)

The signature is `base64(HMAC-SHA256(appSecret, method + requestUri + body + timestamp))`.
This follows HubSpot's "Validating requests" documentation:

- `requestUri` is the **configured** `PUBLIC_BASE_URL` plus the path and query that were
  called. It is never taken from the `Host` header.
- The documented characters are URL-decoded in `requestUri`: `%3A %2F %3F %40 %21 %24 %27
  %28 %29 %2A %2C %3B`.
- `X-HubSpot-Request-Timestamp` is in milliseconds and must be at most 5 minutes old.
  Up to 1 minute of future clock skew is tolerated.
- The implementation reproduces HubSpot's published example signature
  (`gbj1XPRvUt0noT7i7fXfTzOD4sLzQmf0VT28ZYq0EYg=`) in the test suite.
- The app secret is the workspace's stored HubSpot client secret. Single-tenant
  processes fall back to `HUBSPOT_APP_SECRET`.
- A delivery must name exactly one portal. Mixed-portal batches are refused.

Two limits could not be confirmed in HubSpot's current documentation (checked
2026-09-24):

- **Response deadline.** Acknowledgement latency is measured, not assumed.
- **Maximum events per request.** The ingress accepts up to 1,000 events per delivery.

## Salesforce sender contract

Salesforce has no signed outbound webhook of its own. The sender is an Apex trigger or a
platform-event subscriber that you configure.

**v2 (replay-protected; use this for new senders)**

```
POST {PUBLIC_BASE_URL}/webhooks/salesforce
Content-Type: application/json
X-CrmSync-Timestamp: <milliseconds since epoch>
X-CrmSync-Nonce:     <16-128 chars [A-Za-z0-9_-], new for every request>
X-CrmSync-Org-Id:    <15/18-char org id>
X-CrmSync-Signature: v2=<hex HMAC-SHA256(secret, "v2:" + timestamp + ":" + nonce + ":" + orgId + ":" + body)>

{"events":[{"sobject":"Contact","recordId":"003...","changeType":"updated","occurredAt":"2026-09-24T12:00:00Z"}]}
```

- The timestamp must be at most 5 minutes old.
- Each nonce is accepted once.
- The org id must be the workspace's connected org.
- `changeType` is `created`, `updated` or `deleted`.
- Send `occurredAt` whenever possible. It makes redeliveries recognizable as duplicates.

```apex
String body = JSON.serialize(new Map<String, Object>{ 'events' => events });
String ts = String.valueOf(Datetime.now().getTime());
String nonce = EncodingUtil.convertToHex(Crypto.generateAesKey(128));
String orgId = UserInfo.getOrganizationId();
Blob mac = Crypto.generateMac('hmacSHA256',
    Blob.valueOf('v2:' + ts + ':' + nonce + ':' + orgId + ':' + body), Blob.valueOf(secret));
HttpRequest req = new HttpRequest();
req.setEndpoint(endpoint);
req.setMethod('POST');
req.setHeader('Content-Type', 'application/json');
req.setHeader('X-CrmSync-Timestamp', ts);
req.setHeader('X-CrmSync-Nonce', nonce);
req.setHeader('X-CrmSync-Org-Id', orgId);
req.setHeader('X-CrmSync-Signature', 'v2=' + EncodingUtil.convertToHex(mac));
req.setBody(body);
```

To retry after a `503`, resend the **same** request, with the same nonce and signature,
within 5 minutes.

**Legacy (v1):** `X-Signature: <hex HMAC-SHA256(secret, body)>`.

- There is no freshness or replay protection.
- It is accepted in the default `SF_WEBHOOK_SIGNATURE=compat` mode, so existing senders
  keep working, and it is counted as `signature_legacy`.
- It is accepted only in single-tenant processes, because it names no org to route by.
- Migrate senders to v2, then set `SF_WEBHOOK_SIGNATURE=v2` to refuse legacy requests.

**Secrets**

- Single-tenant processes use `SF_WEBHOOK_SECRET`.
- Multi-tenant processes derive a separate secret for each workspace from it, so one
  workspace's sender cannot sign for another. Admins read their workspace's endpoint and
  secret from `GET /api/webhooks/salesforce/contract`, and each read is audited.

## Deployment notes

- `ALLOW_UNSIGNED_WEBHOOKS` is for local development only. The server refuses to start
  with it in production.
- Acknowledgement cost was measured with every delivery in flight at once, on a
  development machine with workers paused:
  - in memory, 200 deliveries of 50 events each: p95 about 340–390 ms;
  - PostgreSQL, 100 deliveries of 20 events each: p95 about 165–200 ms.
- Workers that share the web process's event loop (`RUN_WORKERS=true`) delay
  acknowledgements under heavy reconcile load. For webhook-heavy workspaces, run
  `RUN_WORKERS=false` with a separate `npm run worker`.
- Exposing a public webhook endpoint and registering it with HubSpot or Salesforce are
  separate release actions. The code does neither.
