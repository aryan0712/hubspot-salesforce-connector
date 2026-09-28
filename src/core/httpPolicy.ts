import axios, {
  AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';
import { RateLimiter } from './rateLimiter.js';
import { logger } from '../logger.js';

/**
 * R07 -- bounded connector requests.
 *
 * Every vendor request goes through this policy:
 *  - a per-tenant rate limiter and a request timeout (cancellable on shutdown);
 *  - on 401: the rejected token is invalidated, one coalesced refresh runs, the request's
 *    OWN Authorization header is replaced, and it is retried exactly once;
 *  - retries are decided by request kind. Reads (GET, and POST search/query) and idempotent
 *    writes (PUT/PATCH/DELETE) are retried on 429, 5xx, timeouts and network errors.
 *    Creates (other POSTs) are retried only on 429 -- the vendor explicitly refused them --
 *    never on 5xx/timeout/lost response, whose outcome is unknown (R06 recovers those);
 *  - a valid Retry-After is honored (capped by the remaining budget), otherwise exponential
 *    backoff with full jitter; attempts AND total elapsed time are bounded;
 *  - repeated transient failures open a circuit so a failing vendor is not hammered, and the
 *    error carries retryAfterMs so the job layer schedules its own retry no sooner.
 */
export type RequestKind = 'read' | 'idempotent-write' | 'unsafe-create';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ConnectorHealth {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt?: string;
  lastError?: string;
  openedUntil?: string;
}

export interface HttpPolicyOptions {
  name: string;
  requestsPerSecond: number;
  /** Share one limiter across app instances for the same tenant + system. */
  limiterKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Total time a single request may spend retrying. */
  retryBudgetMs?: number;
  baseDelayMs?: number;
  /** Called with the rejected bearer token; must return a fresh one (coalesced). */
  refreshToken?: (rejectedToken: string) => Promise<string>;
  classify?: (config: InternalAxiosRequestConfig) => RequestKind;
  circuitThreshold?: number;
  circuitCooldownMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface HttpPolicyControls {
  health(): ConnectorHealth;
  /** Cancels every in-flight request (graceful shutdown). */
  abortAll(reason?: string): void;
}

/** Fails fast while a vendor is unhealthy; retry after `retryAfterMs`. */
export class CircuitOpenError extends Error {
  constructor(name: string, readonly retryAfterMs: number) {
    super(`${name} is temporarily unavailable after repeated failures; retrying in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}

type PolicyConfig = InternalAxiosRequestConfig & {
  crmAuthRetried?: boolean;
  crmRetryCount?: number;
  crmStartedAt?: number;
};

const limiters = new Map<string, RateLimiter>();

/** One limiter per key (tenant + system), so separate app instances share a vendor budget. */
export function sharedRateLimiter(key: string, requestsPerSecond: number): RateLimiter {
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new RateLimiter(requestsPerSecond);
    limiters.set(key, limiter);
  }
  return limiter;
}

export function defaultRequestKind(config: InternalAxiosRequestConfig): RequestKind {
  const method = (config.method ?? 'get').toLowerCase();
  if (method === 'get' || method === 'head' || method === 'options') return 'read';
  if (method === 'put' || method === 'patch' || method === 'delete') return 'idempotent-write';
  // POST is a create unless it is a query-style endpoint (HubSpot search, batch read).
  const url = config.url ?? '';
  if (/\/search(\?|$)|\/batch\/read(\?|$)|\/query(\?|$)/.test(url)) return 'read';
  return 'unsafe-create';
}

/** Parses Retry-After (delta-seconds or HTTP-date); undefined when absent or invalid. */
export function parseRetryAfter(value: unknown, now = Date.now()): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - now);
}

export function installHttpPolicy(http: AxiosInstance, opts: HttpPolicyOptions): HttpPolicyControls {
  const limiter = opts.limiterKey
    ? sharedRateLimiter(opts.limiterKey, opts.requestsPerSecond)
    : new RateLimiter(opts.requestsPerSecond);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const classify = opts.classify ?? defaultRequestKind;
  const maxRetries = opts.maxRetries ?? 4;
  const budget = opts.retryBudgetMs ?? 60_000;
  const threshold = opts.circuitThreshold ?? 5;
  const cooldown = opts.circuitCooldownMs ?? 30_000;
  let controller = new AbortController();
  const health: ConnectorHealth = { name: opts.name, state: 'closed', consecutiveFailures: 0 };
  let openedUntil = 0;

  const recordSuccess = (): void => {
    health.consecutiveFailures = 0;
    health.state = 'closed';
    openedUntil = 0;
    delete health.openedUntil;
  };
  const recordFailure = (message: string): void => {
    health.consecutiveFailures += 1;
    health.lastFailureAt = new Date().toISOString();
    health.lastError = message.slice(0, 300);
    if (health.consecutiveFailures >= threshold) {
      openedUntil = Date.now() + cooldown;
      health.state = 'open';
      health.openedUntil = new Date(openedUntil).toISOString();
    }
  };

  http.defaults.timeout = opts.timeoutMs ?? 30_000;

  http.interceptors.request.use(async (config: PolicyConfig) => {
    if (openedUntil) {
      const remaining = openedUntil - Date.now();
      if (remaining > 0) throw new CircuitOpenError(opts.name, remaining);
      health.state = 'half-open';
    }
    config.crmStartedAt ??= Date.now();
    config.signal ??= controller.signal;
    await limiter.acquire();
    return config;
  });

  http.interceptors.response.use(
    (response) => {
      recordSuccess();
      return response;
    },
    async (error: unknown) => {
      if (!axios.isAxiosError(error) || !error.config) throw error;
      const config = error.config as PolicyConfig;
      const status = error.response?.status ?? 0;

      // --- authentication: exactly one forced refresh per request, never with a stale header.
      if (status === 401 && opts.refreshToken) {
        if (config.crmAuthRetried) throw error;
        const rejected = bearerOf(config.headers?.Authorization);
        const fresh = await opts.refreshToken(rejected);
        config.crmAuthRetried = true;
        // Replace the header on THIS request (it was merged before sending) and on the
        // instance defaults, so later requests never go out with the rejected token.
        config.headers.Authorization = `Bearer ${fresh}`;
        (http.defaults.headers as unknown as Record<string, unknown>).Authorization = `Bearer ${fresh}`;
        return http.request(config);
      }

      const kind = classify(config);
      const transient =
        status === 429 ||
        status >= 500 ||
        !error.response; // timeout, reset, DNS
      if (!transient) throw error; // 4xx: a definite, non-retryable answer
      if (error.code === AxiosError.ERR_CANCELED) throw error;
      recordFailure(error.message);

      const retryable = status === 429 || kind !== 'unsafe-create';
      const attempt = config.crmRetryCount ?? 0;
      const retryAfter = status === 429 || status === 503 ? parseRetryAfter(error.response?.headers?.['retry-after']) : undefined;
      const backoff = Math.floor(random() * Math.min(30_000, (opts.baseDelayMs ?? 500) * 2 ** attempt));
      const delay = retryAfter ?? backoff;
      const elapsed = Date.now() - (config.crmStartedAt ?? Date.now());
      if (!retryable || attempt >= maxRetries || elapsed + delay > budget || openedUntil > Date.now() + delay) {
        // Tell the job layer when it may try again at the earliest.
        (error as AxiosError & { retryAfterMs?: number }).retryAfterMs = retryAfter ?? Math.max(delay, 1000);
        throw error;
      }
      config.crmRetryCount = attempt + 1;
      logger.warn(
        { connector: opts.name, status: status || error.code, kind, attempt: attempt + 1, delay },
        'CRM request failed transiently; retrying',
      );
      await sleep(delay);
      return http.request(config);
    },
  );

  return {
    health: () => ({ ...health }),
    abortAll(reason = 'connector shutting down') {
      controller.abort(reason);
      controller = new AbortController();
    },
  };
}

function bearerOf(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return text.replace(/^Bearer\s+/i, '');
}

/**
 * Vendor answers that retrying will never fix: bad credentials after a refresh, missing
 * permission, validation or schema errors. Sync routes these to operator review with an
 * actionable message instead of burning retries.
 */
export function isPermanentVendorError(err: unknown): boolean {
  if (!axios.isAxiosError(err) || !err.response) return false;
  return [400, 401, 403, 404, 405, 409, 410, 422].includes(err.response.status);
}

/** The earliest time the job layer should retry after this error, if the vendor said so. */
export function retryAfterMsOf(err: unknown): number | undefined {
  const value = (err as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
