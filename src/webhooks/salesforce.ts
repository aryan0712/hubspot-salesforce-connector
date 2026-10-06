import crypto from 'node:crypto';
import { z } from 'zod';
import { timingSafeEqualText } from './hubspot.js';
import {
  MAX_WEBHOOK_AGE_MS,
  MAX_WEBHOOK_EVENTS,
  MAX_WEBHOOK_SKEW_MS,
  WebhookRejectedError,
  type NativeWebhookEvent,
} from './types.js';

/**
 * Salesforce has no signed outbound webhook of its own; the sender is an Apex trigger (or
 * platform-event subscriber) configured by the customer. Sender contract (docs/WEBHOOKS.md):
 *
 *  v2 (replay-protected, R12):
 *    X-CrmSync-Timestamp: <milliseconds since epoch>
 *    X-CrmSync-Nonce:     <16-128 chars [A-Za-z0-9_-], unique per request>
 *    X-CrmSync-Org-Id:    <15/18-char org id>
 *    X-CrmSync-Signature: v2=<hex HMAC-SHA256(secret, "v2:" + ts + ":" + nonce + ":" + orgId + ":" + body)>
 *
 *  legacy (v1): X-Signature: <hex HMAC-SHA256(secret, body)> -- no freshness or replay
 *    protection. Accepted only in `compat` mode (the default, so existing senders keep
 *    working) and counted; SF_WEBHOOK_SIGNATURE=v2 refuses it.
 */
export type SalesforceSignatureMode = 'compat' | 'v2';

export interface VerifiedSalesforceRequest {
  version: 'v1' | 'v2';
  orgId?: string;
  nonce?: string;
  timestamp?: number;
}

type Headers = Record<string, string | string[] | undefined>;

const header = (headers: Headers, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export function salesforceV2Signature(secret: string, timestamp: string, nonce: string, orgId: string, body: string): string {
  return `v2=${crypto.createHmac('sha256', secret).update(`v2:${timestamp}:${nonce}:${orgId}:${body}`, 'utf8').digest('hex')}`;
}

/** Headers the sender reports before verification (used to route to the workspace). */
export function salesforceClaimedOrg(headers: Headers): string | undefined {
  const orgId = header(headers, 'x-crmsync-org-id');
  return orgId && /^[a-zA-Z0-9]{15,18}$/.test(orgId) ? orgId : undefined;
}

export function verifySalesforceRequest(input: {
  secret: string;
  headers: Headers;
  body: string;
  mode: SalesforceSignatureMode;
  now?: number;
}): VerifiedSalesforceRequest {
  const now = input.now ?? Date.now();
  const signature = header(input.headers, 'x-crmsync-signature');
  if (signature) {
    const timestampText = header(input.headers, 'x-crmsync-timestamp') ?? '';
    const nonce = header(input.headers, 'x-crmsync-nonce') ?? '';
    const orgId = salesforceClaimedOrg(input.headers);
    const timestamp = Number(timestampText);
    if (!/^\d{10,16}$/.test(timestampText) || !Number.isFinite(timestamp)) {
      throw new WebhookRejectedError('stale_timestamp', 'missing timestamp');
    }
    if (now - timestamp > MAX_WEBHOOK_AGE_MS) throw new WebhookRejectedError('stale_timestamp');
    if (timestamp - now > MAX_WEBHOOK_SKEW_MS) throw new WebhookRejectedError('future_timestamp');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !orgId) {
      throw new WebhookRejectedError('bad_signature', 'missing nonce or org id');
    }
    const expected = salesforceV2Signature(input.secret, timestampText, nonce, orgId, input.body);
    if (!timingSafeEqualText(signature, expected)) throw new WebhookRejectedError('bad_signature');
    return { version: 'v2', orgId, nonce, timestamp };
  }
  const legacy = header(input.headers, 'x-signature');
  if (!legacy) throw new WebhookRejectedError('bad_signature', 'unsigned request');
  if (input.mode === 'v2') throw new WebhookRejectedError('legacy_signature_disabled');
  const expected = crypto.createHmac('sha256', input.secret).update(input.body, 'utf8').digest('hex');
  if (!timingSafeEqualText(legacy, expected)) throw new WebhookRejectedError('bad_signature');
  return { version: 'v1' };
}

const salesforceEvent = z.object({
  sobject: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),
  recordId: z.string().regex(/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/),
  changeType: z.enum(['created', 'updated', 'deleted']).default('updated'),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});
const salesforcePayload = z.object({ events: z.array(z.unknown()) });

export function parseSalesforcePayload(body: string, now = Date.now()): NativeWebhookEvent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new WebhookRejectedError('malformed', 'body is not JSON');
  }
  const envelope = salesforcePayload.safeParse(raw);
  if (!envelope.success) throw new WebhookRejectedError('malformed', 'expected { events: [...] }');
  if (envelope.data.events.length === 0) throw new WebhookRejectedError('malformed', 'no events');
  if (envelope.data.events.length > MAX_WEBHOOK_EVENTS) throw new WebhookRejectedError('too_many_events');
  const events = z.array(salesforceEvent).safeParse(envelope.data.events);
  if (!events.success) throw new WebhookRejectedError('malformed', events.error.issues[0]?.message ?? 'invalid event');
  const receivedAt = new Date(now).toISOString();
  return events.data.map((event) => {
    if (event.occurredAt && Date.parse(event.occurredAt) - now > MAX_WEBHOOK_SKEW_MS) {
      throw new WebhookRejectedError('future_timestamp', 'event occurs in the future');
    }
    return {
      system: 'salesforce',
      // Same identity as before R12 when the sender reports occurredAt. Without it, the
      // receipt time is used: otherwise every later change of the record would collapse
      // onto its first delivery and be dropped as a "duplicate". (A redelivery then only
      // re-reads the record's current state, which is harmless.)
      deliveryId: crypto
        .createHash('sha256')
        .update(`${event.sobject}:${event.recordId}:${event.changeType}:${event.occurredAt ?? `received:${receivedAt}`}`)
        .digest('hex'),
      nativeObject: event.sobject,
      sourceId: event.recordId,
      changeType: event.changeType,
      occurredAt: event.occurredAt ? new Date(event.occurredAt).toISOString() : receivedAt,
    };
  });
}
