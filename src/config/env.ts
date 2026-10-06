import 'dotenv/config';
import { z } from 'zod';

const envBoolean = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['false', '0', 'no', 'off', ''].includes(value.toLowerCase())) return false;
  return value;
}, z.boolean());

/**
 * Central, validated configuration. Fail fast at boot if something critical is missing
 * for the mode you're running. We keep most secrets optional at the schema level so the
 * app can boot in "migration only" or "one connector" modes, and validate presence at
 * the point of use instead.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().url().optional(),
  /** TLS to the database with certificate verification (R14). */
  DATABASE_SSL: envBoolean.default(false),
  /** CA bundle (PEM text or file path) for a managed database's certificate. */
  DATABASE_SSL_CA: z.string().optional(),
  /** Local development only: TLS without certificate verification. Refused in production. */
  DATABASE_SSL_INSECURE: envBoolean.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
  DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  /**
   * Schema-owner connection used only to run migrations (R11). The runtime DATABASE_URL
   * role then gets data privileges only. Optional for local development.
   */
  DATABASE_MIGRATION_URL: z.string().url().optional(),
  DEFAULT_TENANT_SLUG: z.string().default('local'),
  APP_ENCRYPTION_KEY: z.string().optional(),
  APP_ENCRYPTION_KEY_FILE: z.string().default('data/.encryption-key'),
  /** Version of APP_ENCRYPTION_KEY (R14 rotation); raise it with each new key. */
  APP_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  /** Decrypt-only previous keys during a rotation: "<version>:<key>,<version>:<key>". */
  APP_ENCRYPTION_PREVIOUS_KEYS: z.string().optional(),
  AUTH_REQUIRED: envBoolean.default(false),
  /**
   * single: one workspace per process (DEFAULT_TENANT_SLUG). multi: every request and job
   * runs for the signed-in user's workspace (requires AUTH_REQUIRED=true).
   */
  TENANCY_MODE: z.enum(['single', 'multi']).default('single'),
  /** Bootstrap owner for a fresh workspace (sign-in with sessions); password >= 12 chars. */
  BOOTSTRAP_OWNER_EMAIL: z.string().email().optional(),
  BOOTSTRAP_OWNER_PASSWORD: z.string().min(12).optional(),
  /** Mock demo playground routes; always off in production regardless of this value. */
  ENABLE_DEMO: envBoolean.optional(),
  /** Run background workers in the web process (set false when running `npm run worker`). */
  RUN_WORKERS: envBoolean.default(true),
  SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  SYNC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(25).default(8),
  DELETE_POLICY: z.enum(['ignore', 'cascade', 'manual-review']).default('manual-review'),
  HUBSPOT_REQUESTS_PER_SECOND: z.coerce.number().positive().max(50).default(9),
  SALESFORCE_REQUESTS_PER_SECOND: z.coerce.number().positive().max(100).default(20),
  /** Local development only; refused in production. */
  ALLOW_UNSIGNED_WEBHOOKS: envBoolean.default(false),
  /**
   * compat: accept the Salesforce sender contract v2 (timestamp + nonce + org id) and the
   * legacy body-only signature (counted); v2: refuse legacy senders. See docs/WEBHOOKS.md.
   */
  SF_WEBHOOK_SIGNATURE: z.enum(['compat', 'v2']).default('compat'),
  /** Pending webhook inbox rows per workspace above which deliveries get 503 (retry). */
  WEBHOOK_MAX_BACKLOG: z.coerce.number().int().positive().default(100_000),
  /**
   * Bearer token for GET /metrics (Prometheus). Without it the endpoint is only served by
   * non-production processes.
   */
  METRICS_TOKEN: z.string().min(16).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default('gpt-5.6-sol'),

  SF_LOGIN_URL: z.string().url().default('https://login.salesforce.com'),
  SF_CLIENT_ID: z.string().optional(),
  SF_CLIENT_SECRET: z.string().optional(),
  SF_REDIRECT_URI: z.string().url().optional(),
  SF_REFRESH_TOKEN: z.string().optional(),
  SF_INSTANCE_URL: z.string().url().optional(),
  SF_WEBHOOK_SECRET: z.string().optional(),

  HUBSPOT_PRIVATE_APP_TOKEN: z.string().optional(),
  HUBSPOT_CLIENT_ID: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),
  HUBSPOT_REDIRECT_URI: z.string().url().optional(),
  HUBSPOT_REFRESH_TOKEN: z.string().optional(),
  HUBSPOT_APP_SECRET: z.string().optional(),

  CONFLICT_STRATEGY: z
    .enum(['source-of-truth', 'last-write-wins', 'field-merge'])
    .default('last-write-wins'),
  SOURCE_OF_TRUTH: z.enum(['salesforce', 'hubspot']).default('salesforce'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
