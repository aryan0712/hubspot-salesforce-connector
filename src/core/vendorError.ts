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
