import axios from 'axios';

/**
 * Salesforce error responses are `[{ message, errorCode }, ...]`; HubSpot's are
 * `{ message, category }`. Pull the human-readable message out of either shape so a live
 * CRM API failure surfaces its actual cause instead of a generic/opaque error.
 */
export function extractVendorErrorMessage(data: unknown): string | undefined {
  const first = Array.isArray(data) ? data[0] : data;
  if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).message === 'string') {
    return (first as Record<string, unknown>).message as string;
  }
  return undefined;
}

/** Best-effort human-readable message for any error, preferring the CRM's own wording. */
export function describeError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return extractVendorErrorMessage(err.response?.data) ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

interface HubSpotFieldError {
  message?: string;
  code?: string;
  context?: { propertyName?: string[] };
}

export interface DuplicateValueConflict {
  /** Native field name that collided (e.g. HubSpot's "email"). */
  property: string;
  value: string;
  /** Native id of the OTHER record that already owns this value. */
  conflictingId: string;
}

/**
 * Structured version of the "Cannot set PropertyValueCoordinates{... propertyName=email,
 * value=x} on 123. 456 already has that value." pattern HubSpot returns for a uniqueness
 * conflict -- used both for the human-readable error text and by the reconciler to
 * self-heal a stale link (see Reconciler.reconcile()).
 */
export function extractDuplicateValueConflict(err: unknown): DuplicateValueConflict | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const message = extractVendorErrorMessage(err.response?.data);
  if (!message) return undefined;
  const match = message.match(/propertyName=([^,}]+),\s*value=([^}]+)\}\s*on\s*\S+\.\s*(\S+)\s*already has that value/i);
  if (!match) return undefined;
  const [, property, value, conflictingId] = match;
  return { property: property!, value: value!, conflictingId: conflictingId! };
}

/**
 * Thrown by Reconciler BEFORE it ever calls a connector's upsert(), when the record about to
 * be written is missing a value for one of the target's required (and writable) fields. Vendor
 * APIs reject this too, but as a generic 400 indistinguishable from any other validation
 * failure -- catching it here first makes it unmistakable and skips the wasted network call.
 */
export class MissingRequiredFieldError extends Error {
  constructor(readonly fieldLabels: string[]) {
    super(`missing required value for: ${fieldLabels.join(', ')}`);
    this.name = 'MissingRequiredFieldError';
  }
}

/**
 * Turns a raw CRM error into plain English an operator (not a developer) can act on without
 * digging further. Two things the CRMs' own error bodies are bad at on their own:
 *  - HubSpot's multi-field validation response puts a JSON-dump of every issue in `message`
 *    and the actually-readable per-field breakdown in a separate `errors[]` array -- prefer
 *    the latter.
 *  - Even a single, "clean" vendor message is often written for a developer (a raw internal
 *    object dump for a duplicate-value conflict, a bare HTTP reason phrase for others) --
 *    pattern-match the shapes seen in practice and translate them; fall back to the vendor's
 *    own wording, then to a plain explanation of the HTTP status, when nothing matches.
 */
export function friendlyErrorMessage(err: unknown, targetSystemLabel = 'the target system'): string {
  if (err instanceof MissingRequiredFieldError) {
    return `Skipped: missing required value for ${err.fieldLabels.join(', ')} in ${targetSystemLabel}. Fill in ${err.fieldLabels.length > 1 ? 'these fields' : 'this field'} at the source and replay, or exclude the field from this object's mapping.`;
  }
  if (!axios.isAxiosError(err)) {
    return err instanceof Error ? err.message : String(err);
  }
  const status = err.response?.status;
  const data = err.response?.data as { errors?: HubSpotFieldError[] } | undefined;

  const duplicate = extractDuplicateValueConflict(err);
  if (duplicate) {
    return `Can't set "${duplicate.property}" to "${duplicate.value}" -- another record (${duplicate.conflictingId}) in ${targetSystemLabel} already has that value. Merge or update the duplicate there, then replay this sync.`;
  }

  const fieldErrors = Array.isArray(data?.errors) ? data!.errors : undefined;
  if (fieldErrors?.length) {
    const first = fieldErrors[0]!;
    const field = first.context?.propertyName?.[0];
    const detail = humanizeVendorMessage(first.message ?? '', field, status, targetSystemLabel);
    const more = fieldErrors.length > 1 ? ` (+${fieldErrors.length - 1} more field${fieldErrors.length - 1 === 1 ? '' : 's'} with issues)` : '';
    return detail + more;
  }

  const vendorMessage = extractVendorErrorMessage(err.response?.data);
  if (vendorMessage) return humanizeVendorMessage(vendorMessage, undefined, status, targetSystemLabel);

  return httpStatusFallback(status, targetSystemLabel);
}

function humanizeVendorMessage(
  message: string,
  field: string | undefined,
  status: number | undefined,
  targetSystemLabel: string,
): string {
  const trimmed = message.trim();

  if (/^resource not found$/i.test(trimmed) || status === 404) {
    return `The record could not be found in ${targetSystemLabel} -- it may have been deleted there, or the link between the two systems is stale.`;
  }

  // "X was not one of the allowed options: [...]" / "X was not a valid long/integer/number"
  if (/was not one of the allowed options|was not a valid (long|integer|number)/i.test(trimmed)) {
    return field ? `Field "${field}" in ${targetSystemLabel}: ${trimmed}` : `${targetSystemLabel}: ${trimmed}`;
  }

  return field ? `Field "${field}" in ${targetSystemLabel}: ${trimmed}` : trimmed;
}

function httpStatusFallback(status: number | undefined, targetSystemLabel: string): string {
  switch (status) {
    case 400:
      return `${targetSystemLabel} rejected this record as invalid, but didn't say which field -- check the record's values, or contact support if this keeps happening.`;
    case 401:
      return `Authentication to ${targetSystemLabel} failed or expired -- reconnect the account from the Connections tab.`;
    case 403:
      return `Permission denied -- the connected ${targetSystemLabel} account doesn't have access to this record or field.`;
    case 404:
      return `The record could not be found in ${targetSystemLabel} -- it may have been deleted there, or the link between the two systems is stale.`;
    case 415:
      return `${targetSystemLabel} rejected the request format -- this is usually a brief, transient issue and will retry automatically; try Replay if it doesn't clear on its own.`;
    case 429:
      return `Rate-limited by ${targetSystemLabel} -- this will retry automatically after a short delay.`;
    default:
      if (status && status >= 500) {
        return `${targetSystemLabel} had a temporary server error (HTTP ${status}) -- this will retry automatically.`;
      }
      return status ? `Request to ${targetSystemLabel} failed (HTTP ${status}).` : `Request to ${targetSystemLabel} failed.`;
  }
}
