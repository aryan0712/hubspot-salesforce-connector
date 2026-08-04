import axios from 'axios';
import { describe, expect, it } from 'vitest';
import { reconnectRequired } from '../src/connectors/oauthError.js';

describe('OAuth refresh errors', () => {
  it('turns an expired Salesforce grant into an actionable public error', () => {
    const response = {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      config: { headers: {} },
      data: { error: 'invalid_grant', error_description: 'expired access/refresh token' },
    };
    const vendorError = new axios.AxiosError(
      'Request failed with status code 400',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      response,
    );

    const error = reconnectRequired('salesforce', vendorError);

    expect(error).toMatchObject({
      code: 'connection_refresh_required',
      status: 409,
      detail: { system: 'salesforce', actionUrl: '/' },
    });
    expect(error?.message).toContain('Reconnect Salesforce');
    expect(error?.message).not.toContain('expired access/refresh token');
  });

  it('does not mask unrelated connector failures', () => {
    const networkError = new axios.AxiosError('socket closed', 'ECONNRESET');
    expect(reconnectRequired('hubspot', networkError)).toBeUndefined();
  });
});
