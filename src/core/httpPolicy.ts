import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { RateLimiter } from './rateLimiter.js';
import { logger } from '../logger.js';

type RetryConfig = InternalAxiosRequestConfig & { crmRetryCount?: number };

export function installHttpPolicy(
  http: AxiosInstance,
  opts: { requestsPerSecond: number; maxRetries?: number; name: string },
): void {
  const limiter = new RateLimiter(opts.requestsPerSecond);
  http.interceptors.request.use(async (config) => {
    await limiter.acquire();
    return config;
  });
  http.interceptors.response.use(undefined, async (error: unknown) => {
    if (!axios.isAxiosError(error) || !error.config) throw error;
    const status = error.response?.status ?? 0;
    if (status !== 429 && status < 500) throw error;
    const config = error.config as RetryConfig;
    const attempt = config.crmRetryCount ?? 0;
    if (attempt >= (opts.maxRetries ?? 5)) throw error;
    config.crmRetryCount = attempt + 1;
    const retryAfter = Number(error.response?.headers?.['retry-after']);
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(60_000, retryAfter * 1000)
      : Math.min(30_000, 500 * 2 ** attempt + Math.floor(Math.random() * 250));
    logger.warn(
      { connector: opts.name, status, attempt: attempt + 1, delay },
      'CRM request throttled; retrying',
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
    return http.request(config);
  });
}
