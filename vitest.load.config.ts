import { defineConfig } from 'vitest/config';

/**
 * Opt-in load measurements (R12 webhook acknowledgement bursts), run on their own so they
 * measure the ingress, not the rest of the suite:  npm run test:load:webhooks
 */
export default defineConfig({
  test: {
    include: ['test/webhookIngress.test.ts'],
    setupFiles: ['test/setup.ts'],
    globalSetup: ['test/globalPostgres.ts'],
    env: { NODE_ENV: 'production', LOG_LEVEL: 'fatal', RUN_LOAD_TESTS: '1' },
  },
});
