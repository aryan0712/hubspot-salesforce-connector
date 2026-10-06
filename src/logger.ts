import pino from 'pino';
import { env } from './config/env.js';
import { logContext } from './observability/context.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // R14: request / workspace / job correlation on every line written inside a context.
  mixin() {
    return { ...logContext() };
  },
  redact: {
    paths: [
      'accessToken',
      'refreshToken',
      'clientSecret',
      '*.accessToken',
      '*.refreshToken',
      '*.clientSecret',
      'authorization',
      '*.authorization',
      'password',
      '*.password',
      'smtpPassword',
      '*.smtpPassword',
      'apiKey',
      '*.apiKey',
      'headers.cookie',
      '*.headers.cookie',
    ],
    censor: '[Redacted]',
  },
  serializers: {
    err(error: unknown) {
      if (!(error instanceof Error)) return { message: String(error) };
      const details = error as Error & { code?: string; status?: number };
      return {
        type: error.name,
        message: error.message,
        stack: error.stack,
        code: details.code,
        status: details.status,
      };
    },
  },
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
});

export type Logger = typeof logger;
