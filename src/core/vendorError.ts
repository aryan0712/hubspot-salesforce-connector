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
  name?: string;
  context?: {
    propertyName?: string[];
    missingRequiredProperty?: string[];
    invalidPropertyName?: string[];
  };
}

interface SalesforceErrorItem {
  message?: string;
  errorCode?: string;
  fields?: string[];
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
  const rawData = err.response?.data;

  const duplicate = extractDuplicateValueConflict(err);
  if (duplicate) {
    return `Can't set "${duplicate.property}" to "${duplicate.value}" -- another record (${duplicate.conflictingId}) in ${targetSystemLabel} already has that value. Merge or update the duplicate there, then replay this sync.`;
  }

  // Salesforce error shape: [{ message, errorCode, fields?: string[] }, ...]
  if (Array.isArray(rawData) && rawData.length > 0) {
    const sfItems = rawData.filter((item): item is SalesforceErrorItem => Boolean(item && typeof item === 'object'));
    if (sfItems.length > 0) {
      const formatted = sfItems.slice(0, 3).map((item) => {
        const msg = typeof item.message === 'string' ? item.message : '';
        const fields = extractSalesforceFields(item);
        return humanizeVendorMessage(msg, fields.length ? fields.join(', ') : undefined, status, targetSystemLabel);
      });
      return appendRequestContext(formatted.join(' · '), err);
    }
  }

  const data = rawData as { errors?: HubSpotFieldError[] } | undefined;
  const fieldErrors = Array.isArray(data?.errors) ? data!.errors : undefined;
  if (fieldErrors?.length) {
    const formatted = fieldErrors.slice(0, 3).map((item) => {
      const field =
        item.context?.propertyName?.[0] ??
        item.context?.missingRequiredProperty?.[0] ??
        item.context?.invalidPropertyName?.[0] ??
        item.name;
      return humanizeVendorMessage(item.message ?? '', field, status, targetSystemLabel);
    });
    const moreCount = fieldErrors.length - formatted.length;
    const more = moreCount > 0 ? ` (+${moreCount} more field${moreCount === 1 ? '' : 's'} with issues)` : '';
    return appendRequestContext(formatted.join(' · ') + more, err);
  }

  const vendorMessage = extractVendorErrorMessage(rawData);
  if (vendorMessage) {
    const embedded = parseEmbeddedHubSpotPropertyErrors(vendorMessage, status, targetSystemLabel);
    if (embedded) return appendRequestContext(embedded, err);
    const inferredField = inferFieldFromMessage(vendorMessage);
    return appendRequestContext(humanizeVendorMessage(vendorMessage, inferredField, status, targetSystemLabel), err);
  }

  return appendRequestContext(httpStatusFallback(status, targetSystemLabel), err);
}

function extractSalesforceFields(item: SalesforceErrorItem): string[] {
  if (Array.isArray(item.fields)) {
    const explicit = item.fields.filter((f): f is string => typeof f === 'string' && f.trim().length > 0);
    if (explicit.length > 0) return explicit;
  }
  const inferred = item.message ? inferFieldFromMessage(item.message) : undefined;
  return inferred ? [inferred] : [];
}

function inferFieldFromMessage(message: string): string | undefined {
  // HubSpot: "Invalid names: [Other]" or "Invalid names: [Foo, Bar]"
  const invalidNames = message.match(/Invalid names:\s*\[([^\]]+)\]/i);
  if (invalidNames?.[1]) return invalidNames[1].trim();

  // HubSpot: "Property \"foo\" does not exist" or "Provided property [foo] does not exist"
  const propNotExist = message.match(/(?:Property|propertyName)\s*[=:"[\s]+([A-Za-z0-9_.-]+)["\]\s]+does not exist/i);
  if (propNotExist?.[1]) return propNotExist[1].trim();

  // Salesforce SOQL: "No such column 'Foo__c' on entity 'Contact'"
  const noSuchCol = message.match(/No such column '([^']+)'/i);
  if (noSuchCol?.[1]) return noSuchCol[1].trim();

  // Salesforce: "Required fields are missing: [LastName]"
  const reqMissing = message.match(/Required fields are missing:\s*\[([^\]]+)\]/i);
  if (reqMissing?.[1]) return reqMissing[1].trim();

  // Salesforce: "Unable to create/update fields: Foo__c, Bar__c."
  const unableFields = message.match(/Unable to create\/update fields:\s*([^\n.]+)/i);
  if (unableFields?.[1]) return unableFields[1].trim();

  return undefined;
}

function parseEmbeddedHubSpotPropertyErrors(
  message: string,
  status: number | undefined,
  targetSystemLabel: string,
): string | undefined {
  const match = message.match(/Property values were not valid:\s*(\[[\s\S]*\])/i);
  if (!match?.[1]) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as { name?: string; message?: string; error?: string }[];
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const parts = parsed.slice(0, 3).map((entry) =>
      humanizeVendorMessage(entry.message ?? entry.error ?? 'invalid value', entry.name, status, targetSystemLabel),
    );
    const more = parsed.length > 3 ? ` (+${parsed.length - 3} more field${parsed.length - 3 === 1 ? '' : 's'} with issues)` : '';
    return parts.join(' · ') + more;
  } catch {
    return undefined;
  }
}

function appendRequestContext(formatted: string, err: unknown): string {
  // If a specific field is already identified in the message, no extra fallback is needed.
  if (/\bField(?:s)?\s+"/i.test(formatted) || /^Can't set "/i.test(formatted) || /^Skipped: missing required value for /i.test(formatted)) {
    return formatted;
  }
  if (!axios.isAxiosError(err) || !err.config) return formatted;

  const url = err.config.url ?? '';
  const assocMatch =
    url.match(/\/objects\/([^/]+)\/[^/]+\/associations\/(?:default\/)?([^/?]+)/i) ??
    url.match(/\/associations\/([^/]+)\/([^/?]+)/i);
  if (assocMatch?.[1] && assocMatch?.[2]) {
    return `${formatted} (while syncing relationship: ${assocMatch[1]} → ${assocMatch[2]})`;
  }

  const fields = extractSentPayloadFields(err.config.data);
  if (fields.length > 0) {
    const listed = fields.slice(0, 8).join(', ') + (fields.length > 8 ? `, +${fields.length - 8} more` : '');
    return `${formatted} (fields in request: ${listed})`;
  }
  return formatted;
}

function extractSentPayloadFields(rawData: unknown): string[] {
  if (!rawData) return [];
  let parsed: unknown = rawData;
  if (typeof rawData === 'string') {
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const obj = parsed as Record<string, unknown>;
  // HubSpot create/update payload: { properties: { name: "...", domain: "..." } }
  if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
    return Object.keys(obj.properties as Record<string, unknown>);
  }
  // HubSpot search payload: { filterGroups: [{ filters: [{ propertyName: "..." }] }] }
  if (Array.isArray(obj.filterGroups)) {
    const props = new Set<string>();
    for (const group of obj.filterGroups) {
      const filters = (group as { filters?: { propertyName?: string }[] })?.filters;
      if (Array.isArray(filters)) {
        for (const f of filters) {
          if (typeof f?.propertyName === 'string' && f.propertyName) props.add(f.propertyName);
        }
      }
    }
    return [...props];
  }
  // Salesforce create/update payload: { Name: "...", Phone: "..." }
  return Object.keys(obj);
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

  const prefix = field
    ? field.includes(',')
      ? `Fields "${field}" in ${targetSystemLabel}`
      : `Field "${field}" in ${targetSystemLabel}`
    : undefined;

  // "X was not one of the allowed options: [...]" / "X was not a valid long/integer/number"
  if (/was not one of the allowed options|was not a valid (long|integer|number)/i.test(trimmed)) {
    return prefix ? `${prefix}: ${trimmed}` : `${targetSystemLabel}: ${trimmed}`;
  }

  return prefix ? `${prefix}: ${trimmed}` : trimmed;
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

