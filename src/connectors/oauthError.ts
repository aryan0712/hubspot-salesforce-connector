import axios from 'axios';
import type { SystemId } from '../core/types.js';
import { PublicError } from '../core/publicError.js';

const RECONNECT_ERRORS = new Set(['invalid_grant', 'invalid_client']);

export function reconnectRequired(
  system: SystemId,
  error: unknown,
): PublicError | undefined {
  if (!axios.isAxiosError(error) || ![400, 401].includes(error.response?.status ?? 0)) {
    return undefined;
  }
  const data = error.response?.data;
  const vendorCode =
    data && typeof data === 'object' && typeof data.error === 'string'
      ? data.error
      : undefined;
  if (!vendorCode || !RECONNECT_ERRORS.has(vendorCode)) return undefined;

  const label = system === 'salesforce' ? 'Salesforce' : 'HubSpot';
  return new PublicError(
    'connection_refresh_required',
    `${label} authorization has expired. Reconnect ${label} from the Connections page, then run preflight again.`,
    409,
    { system, actionUrl: '/' },
  );
}
