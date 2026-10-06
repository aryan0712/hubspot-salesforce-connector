import crypto from 'node:crypto';
import { z } from 'zod';
import {
  MAX_WEBHOOK_AGE_MS,
  MAX_WEBHOOK_EVENTS,
  MAX_WEBHOOK_SKEW_MS,
  WebhookRejectedError,
  type NativeWebhookEvent,
} from './types.js';

/**
 * HubSpot webhook signature v3 (R12), as documented by HubSpot ("Validating requests"):
 *   base64( HMAC-SHA256( appSecret, method + requestUri + body + timestamp ) )
 * where requestUri is the full public URI HubSpot called (https://host/path?query) with the
 * documented characters URL-decoded, and X-HubSpot-Request-Timestamp (milliseconds) must be
 * at most 5 minutes old. The URI comes from our configured public base URL, never from the
 * request's Host header.
 */
const DECODE: Record<string, string> = {
  '%3A': ':',
  '%2F': '/',
  '%3F': '?',
  '%40': '@',
  '%21': '!',
  '%24': '$',
  '%27': "'",
  '%28': '(',
  '%29': ')',
  '%2A': '*',
  '%2C': ',',
  '%3B': ';',
};

export function hubspotSignatureUri(uri: string): string {
  return uri.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (match) => DECODE[match.toUpperCase()]!);
}

export function hubspotV3Signature(secret: string, method: string, uri: string, body: string, timestamp: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${method.toUpperCase()}${hubspotSignatureUri(uri)}${body}${timestamp}`, 'utf8')
    .digest('base64');
}

export function verifyHubSpotRequest(input: {
  secret: string;
  method: string;
  uri: string;
  body: string;
  signature: string | undefined;
  timestamp: string | undefined;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  const timestamp = Number(input.timestamp);
  if (!input.timestamp || !Number.isFinite(timestamp)) throw new WebhookRejectedError('stale_timestamp', 'missing timestamp');
  if (now - timestamp > MAX_WEBHOOK_AGE_MS) throw new WebhookRejectedError('stale_timestamp');
  if (timestamp - now > MAX_WEBHOOK_SKEW_MS) throw new WebhookRejectedError('future_timestamp');
  const expected = hubspotV3Signature(input.secret, input.method, input.uri, input.body, input.timestamp);
  if (!timingSafeEqualText(input.signature ?? '', expected)) throw new WebhookRejectedError('bad_signature');
}

const idLike = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)]);
const hubspotEvent = z.object({
  eventId: idLike.optional(),
  subscriptionId: idLike.optional(),
  portalId: idLike,
  objectId: idLike,
  objectTypeId: z.string().regex(/^\d+-\d+$/).optional(),
  subscriptionType: z.string().regex(/^[a-z_]+\.[a-zA-Z_]+$/).max(100),
  occurredAt: z.number().int().positive(),
  attemptNumber: z.number().int().nonnegative().optional(),
}).passthrough();

/** Standard object type ids for subscriptions that name the object instead of an id. */
const STANDARD_TYPE_IDS: Record<string, string> = {
  contact: '0-1',
  company: '0-2',
  deal: '0-3',
  ticket: '0-5',
  line_item: '0-8',
  product: '0-7',
};

export interface ParsedHubSpotDelivery {
  accountId: string;
  events: NativeWebhookEvent[];
}

export function parseHubSpotPayload(body: string, now = Date.now()): ParsedHubSpotDelivery {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new WebhookRejectedError('malformed', 'body is not JSON');
  }
  if (!Array.isArray(raw)) throw new WebhookRejectedError('malformed', 'expected an array of events');
  if (raw.length === 0) throw new WebhookRejectedError('malformed', 'no events');
  if (raw.length > MAX_WEBHOOK_EVENTS) throw new WebhookRejectedError('too_many_events');
  const parsed = z.array(hubspotEvent).safeParse(raw);
  if (!parsed.success) throw new WebhookRejectedError('malformed', parsed.error.issues[0]?.message ?? 'invalid event');
  const accounts = new Set(parsed.data.map((event) => String(event.portalId)));
  if (accounts.size !== 1) throw new WebhookRejectedError('mixed_accounts');
  const events = parsed.data.map((event): NativeWebhookEvent => {
    if (event.occurredAt - now > MAX_WEBHOOK_SKEW_MS) throw new WebhookRejectedError('future_timestamp', 'event occurs in the future');
    const [objectName, action] = event.subscriptionType.split('.') as [string, string];
    const nativeObject = event.objectTypeId ?? STANDARD_TYPE_IDS[objectName];
    if (!nativeObject) throw new WebhookRejectedError('malformed', `unknown object in ${event.subscriptionType}`);
    return {
      system: 'hubspot',
      deliveryId: crypto
        .createHash('sha256')
        .update(
          `${event.portalId}:${event.subscriptionId ?? ''}:${event.eventId ?? ''}:` +
            `${event.subscriptionType}:${event.objectId}:${event.occurredAt}`,
        )
        .digest('hex'),
      accountId: String(event.portalId),
      nativeObject,
      sourceId: String(event.objectId),
      changeType: action === 'creation' ? 'created' : action === 'deletion' ? 'deleted' : 'updated',
      occurredAt: new Date(event.occurredAt).toISOString(),
    };
  });
  return { accountId: [...accounts][0]!, events };
}

export function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
