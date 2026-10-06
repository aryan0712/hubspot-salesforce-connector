import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Real-browser tests run separately: npm run test:browser (vitest.browser.config.ts).
    exclude: ['test/browser/**', 'node_modules/**'],
    setupFiles: ['test/setup.ts'],
    // One PostgreSQL cluster for the run; each test file creates its own database in it.
    globalSetup: ['test/globalPostgres.ts'],
    // Keep logs quiet and avoid pino-pretty's worker thread during tests.
    env: { NODE_ENV: 'production', LOG_LEVEL: 'fatal' },
  },
});
