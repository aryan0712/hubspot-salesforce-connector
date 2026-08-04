import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureConnectionStore,
  type Connection,
} from '../src/core/connectionStore.js';
import { configureSettingsStore } from '../src/core/settingsStore.js';
import { getAccessToken } from '../src/connectors/salesforce/auth.js';

describe('Salesforce refresh-token rotation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists a rotated refresh token and coalesces concurrent refreshes', async () => {
    let saved: Connection = {
      system: 'salesforce',
      environment: 'production',
      refreshToken: 'old-refresh',
      accessToken: 'expired-access',
      instanceUrl: 'https://example.my.salesforce.com',
      expiresAt: Date.now() - 1,
      connectedAt: new Date().toISOString(),
    };
    configureConnectionStore({
      get: async () => ({ ...saved }),
      set: async (connection) => {
        saved = { ...connection };
      },
      update: async (_system, patch) => {
        saved = { ...saved, ...patch };
      },
      delete: async () => undefined,
      all: async () => [{ ...saved }],
    });
    configureSettingsStore({
      get: async () => ({ clientId: 'test-client', clientSecret: 'test-secret' }),
      set: async () => undefined,
      delete: async () => undefined,
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        instance_url: saved.instanceUrl,
      },
    });

    const [first, second] = await Promise.all([getAccessToken(), getAccessToken()]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(saved.accessToken).toBe('new-access');
    expect(saved.refreshToken).toBe('new-refresh');
  });
});
