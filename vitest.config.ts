import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Keep logs quiet and avoid pino-pretty's worker thread during tests.
    env: { NODE_ENV: 'production', LOG_LEVEL: 'fatal' },
  },
});
