import { defineConfig } from 'vitest/config';

/**
 * R13 browser tests: a real Chrome/Edge (via playwright-core, using the browser already
 * installed on the machine) against the HTTP app backed by mock CRMs.  npm run test:browser
 */
export default defineConfig({
  test: {
    include: ['test/browser/**/*.browser.test.ts'],
    setupFiles: ['test/setup.ts'],
    env: { NODE_ENV: 'production', LOG_LEVEL: 'fatal' },
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
