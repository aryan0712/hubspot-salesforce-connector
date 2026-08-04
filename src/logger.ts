import pino from 'pino';
import { env } from './config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
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
