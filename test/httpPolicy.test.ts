import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CircuitOpenError,
  defaultRequestKind,
  installHttpPolicy,
  isPermanentVendorError,
  parseRetryAfter,
  retryAfterMsOf,
} from '../src/core/httpPolicy.js';
import { configureConnectionStore, type Connection } from '../src/core/connectionStore.js';
import { configureSettingsStore } from '../src/core/settingsStore.js';
import { refreshAfterRejection } from '../src/connectors/salesforce/auth.js';
import { isUncertainOutcome } from '../src/engine/writeIntents.js';

/**
 * R07 acceptance: bounded, deterministic request behavior. Every test drives a fake axios
 * adapter; no test touches a real CRM or the live connection store.
 */
type Reply = { status: number; headers?: Record<string, string>; data?: unknown } | 'timeout' | 'reset';

function fakeServer(replies: (config: InternalAxiosRequestConfig, call: number) => Reply) {
  const calls: { method: string; url: string; authorization?: string }[] = [];
  const adapter: AxiosAdapter = async (config) => {
    const call = calls.length;
    calls.push({
      method: (config.method ?? 'get').toUpperCase(),
      url: config.url ?? '',
      authorization: AxiosHeaders.from(config.headers).get('Authorization') as string | undefined,
    });
    const reply = replies(config, call);
    if (reply === 'timeout') throw new AxiosError('timeout of 30000ms exceeded', AxiosError.ECONNABORTED, config);
    if (reply === 'reset') throw new AxiosError('socket hang up', 'ECONNRESET', config);
    const response: AxiosResponse = {
      status: reply.status,
      statusText: String(reply.status),
      headers: reply.headers ?? {},
      data: reply.data ?? {},
      config,
    };
    if (reply.status >= 400) {
      throw new AxiosError(`Request failed with status code ${reply.status}`, 'ERR_BAD_RESPONSE', config, undefined, response);
    }
    return response;
  };
  return { adapter, calls };
}

function client(
  replies: Parameters<typeof fakeServer>[0],
  extra: Partial<Parameters<typeof installHttpPolicy>[1]> = {},
) {
  const server = fakeServer(replies);
  const sleeps: number[] = [];
  const http = axios.create({ adapter: server.adapter, headers: { Authorization: 'Bearer stale-token' } });
  const controls = installHttpPolicy(http, {
    name: 'test',
    requestsPerSecond: 10_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
    baseDelayMs: 100,
    ...extra,
  });
  return { http, calls: server.calls, sleeps, controls };
}

describe('R07 authentication retries', () => {
  it('repeated 401 stops after exactly one forced refresh, and the retry carries the new token', async () => {
    const refresh = vi.fn(async () => 'fresh-token');
    const { http, calls } = client(() => ({ status: 401 }), { refreshToken: refresh });
    await expect(http.get('/records')).rejects.toMatchObject({ response: { status: 401 } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('stale-token');
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer stale-token', 'Bearer fresh-token']);
  });

  it('later requests never reuse the rejected bearer token', async () => {
    const { http, calls } = client((config, call) => (call === 0 ? { status: 401 } : { status: 200 }), {
      refreshToken: async () => 'fresh-token',
    });
    await http.get('/a');
    await http.get('/b');
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer stale-token', 'Bearer fresh-token', 'Bearer fresh-token']);
  });
});

describe('R07 coalesced token refresh (fake connection store)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('simultaneous rejections share one refresh; a token already refreshed is reused', async () => {
    let saved: Connection = {
      system: 'salesforce',
      environment: 'production',
      refreshToken: 'refresh-1',
      accessToken: 'rejected-access',
      instanceUrl: 'https://example.my.salesforce.com',
      expiresAt: Date.now() + 3_600_000, // looks valid, yet the vendor rejected it
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
      data: { access_token: 'new-access', instance_url: saved.instanceUrl },
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => refreshAfterRejection('rejected-access')));
    expect(post).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((result) => result.accessToken))).toEqual(new Set(['new-access']));
    // A late rejection of the OLD token finds the new one and does not refresh again.
    await refreshAfterRejection('rejected-access');
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('R07 bounded transient retries', () => {
  it('honors a valid Retry-After on 429 and succeeds', async () => {
    const { http, calls, sleeps } = client((_config, call) =>
      call === 0 ? { status: 429, headers: { 'retry-after': '2' } } : { status: 200 },
    );
    await http.get('/records');
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it('retries 5xx on reads with jittered backoff, up to the attempt limit', async () => {
    const { http, calls, sleeps } = client(() => ({ status: 503 }), { maxRetries: 3 });
    await expect(http.get('/records')).rejects.toMatchObject({ response: { status: 503 } });
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('stops when the total retry budget would be exceeded', async () => {
    const { http, calls } = client(
      (_config, call) => (call < 5 ? { status: 429, headers: { 'retry-after': '120' } } : { status: 200 }),
      { retryBudgetMs: 60_000 },
    );
    const error = await http.get('/records').catch((err: unknown) => err);
    expect(calls).toHaveLength(1);
    expect(retryAfterMsOf(error)).toBe(120_000);
  });

  it('never retries a create after a 5xx, a timeout or a lost response', async () => {
    for (const reply of [{ status: 502 }, 'timeout', 'reset'] as Reply[]) {
      const { http, calls } = client(() => reply);
      const error = await http.post('/crm/v3/objects/contacts', { properties: {} }).catch((err: unknown) => err);
      expect(calls).toHaveLength(1);
      expect(isUncertainOutcome(error)).toBe(true);
    }
  });

  it('retries a create on 429, which the vendor explicitly did not process', async () => {
    const { http, calls } = client((_config, call) => (call === 0 ? { status: 429, headers: { 'retry-after': '1' } } : { status: 201 }));
    await http.post('/crm/v3/objects/contacts', { properties: {} });
    expect(calls).toHaveLength(2);
  });

  it('treats POST search as a retryable read and GET timeouts as retryable', async () => {
    const search = client((_config, call) => (call === 0 ? { status: 500 } : { status: 200 }));
    await search.http.post('/crm/v3/objects/contacts/search', {});
    expect(search.calls).toHaveLength(2);
    const read = client((_config, call) => (call === 0 ? 'timeout' : { status: 200 }));
    await read.http.get('/sobjects/Contact/003');
    expect(read.calls).toHaveLength(2);
    expect(defaultRequestKind({ method: 'patch', url: '/x' } as InternalAxiosRequestConfig)).toBe('idempotent-write');
  });

  it('does not retry definite 4xx answers', async () => {
    const { http, calls } = client(() => ({ status: 400 }));
    const error = await http.get('/records').catch((err: unknown) => err);
    expect(calls).toHaveLength(1);
    expect(isPermanentVendorError(error)).toBe(true);
  });
});

describe('R07 connector health', () => {
  it('opens the circuit after repeated failures and fails fast until the cooldown ends', async () => {
    const { http, calls, controls } = client(() => ({ status: 503 }), {
      maxRetries: 0,
      circuitThreshold: 3,
      circuitCooldownMs: 30_000,
    });
    for (let i = 0; i < 3; i += 1) await http.get('/records').catch(() => undefined);
    expect(controls.health()).toMatchObject({ state: 'open', consecutiveFailures: 3 });
    const error = await http.get('/records').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(retryAfterMsOf(error)).toBeGreaterThan(0);
    expect(calls).toHaveLength(3);
  });

  it('parses Retry-After seconds and HTTP dates, rejecting garbage', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
