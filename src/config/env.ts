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
  DATABASE_SSL: envBoolean.default(false),
  DEFAULT_TENANT_SLUG: z.string().default('local'),
  APP_ENCRYPTION_KEY: z.string().optional(),
  APP_ENCRYPTION_KEY_FILE: z.string().default('data/.encryption-key'),
  AUTH_REQUIRED: envBoolean.default(false),
  SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  SYNC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(25).default(8),
  DELETE_POLICY: z.enum(['ignore', 'cascade', 'manual-review']).default('manual-review'),
  HUBSPOT_REQUESTS_PER_SECOND: z.coerce.number().positive().max(50).default(9),
  SALESFORCE_REQUESTS_PER_SECOND: z.coerce.number().positive().max(100).default(20),
  ALLOW_UNSIGNED_WEBHOOKS: envBoolean.default(false),
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
