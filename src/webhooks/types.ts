import type { NativeWebhookEvent } from '../core/connector.js';

export type { NativeWebhookEvent };

/** Why a delivery was refused; each maps to one deterministic HTTP status. */
export type WebhookRejection =
  | 'malformed'
  | 'oversized'
  | 'too_many_events'
  | 'stale_timestamp'
  | 'future_timestamp'
  | 'bad_signature'
  | 'replayed'
  | 'secret_unavailable'
  | 'unknown_account'
  | 'account_mismatch'
  | 'mixed_accounts'
  | 'legacy_signature_disabled'
  | 'backlog_full'
  | 'internal_error';

export class WebhookRejectedError extends Error {
  constructor(
    readonly reason: WebhookRejection,
    message?: string,
  ) {
    super(message ? `${reason}: ${message}` : reason);
    this.name = 'WebhookRejectedError';
  }
}

export const WEBHOOK_STATUS: Record<WebhookRejection, number> = {
  malformed: 400,
  oversized: 413,
  too_many_events: 413,
  // Authenticity failures: the vendor should not retry an unverifiable request.
  stale_timestamp: 401,
  future_timestamp: 401,
  bad_signature: 401,
  replayed: 401,
  legacy_signature_disabled: 401,
  // Routing failures: verified structure, but not for any/this workspace.
  unknown_account: 403,
  account_mismatch: 403,
  mixed_accounts: 400,
  // Our side cannot accept it right now: the vendor retries.
  secret_unavailable: 503,
  backlog_full: 503,
  internal_error: 503,
};

/** Signed requests must be this fresh (HubSpot documents 5 minutes for v3). */
export const MAX_WEBHOOK_AGE_MS = 5 * 60_000;
/** Tolerated clock skew for timestamps in the future. */
export const MAX_WEBHOOK_SKEW_MS = 60_000;
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
export const MAX_WEBHOOK_EVENTS = 1000;
