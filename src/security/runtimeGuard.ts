/**
 * Startup policy for the HTTP server. Two rules fail closed:
 *
 *  - A production process (NODE_ENV=production) or a server whose public URL is not a
 *    loopback address must require authentication. Local development stays explicit: the
 *    only unauthenticated configuration is a non-production server addressed via localhost.
 *  - The mock-backed demo playground is never mounted in production.
 */
export interface RuntimeEnvironment {
  NODE_ENV: 'development' | 'test' | 'production';
  AUTH_REQUIRED: boolean;
  PUBLIC_BASE_URL: string;
  ENABLE_DEMO?: boolean;
  TENANCY_MODE?: 'single' | 'multi';
}

export interface RuntimePolicy {
  production: boolean;
  authRequired: boolean;
  demoRoutes: boolean;
  publicBaseUrl: string;
  /** R11: every request/job runs for the authenticated user's workspace. */
  multiTenant: boolean;
}

export class UnsafeRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeRuntimeError';
  }
}

export function resolveRuntimePolicy(env: RuntimeEnvironment): RuntimePolicy {
  const production = env.NODE_ENV === 'production';
  return {
    production,
    authRequired: env.AUTH_REQUIRED,
    // Demo routes default on for local development and are unavailable in production even
    // if ENABLE_DEMO is set, so a misconfigured deploy cannot expose them.
    demoRoutes: !production && (env.ENABLE_DEMO ?? true),
    publicBaseUrl: env.PUBLIC_BASE_URL,
    multiTenant: env.TENANCY_MODE === 'multi',
  };
}

export function assertSafeRuntime(policy: RuntimePolicy): void {
  if (policy.multiTenant && !policy.authRequired) {
    throw new UnsafeRuntimeError('TENANCY_MODE=multi requires AUTH_REQUIRED=true');
  }
  if (policy.authRequired) return;
  if (policy.production) {
    throw new UnsafeRuntimeError(
      'NODE_ENV=production requires AUTH_REQUIRED=true; refusing to start without authentication',
    );
  }
  if (!isLoopbackUrl(policy.publicBaseUrl)) {
    throw new UnsafeRuntimeError(
      `PUBLIC_BASE_URL ${policy.publicBaseUrl} is not a loopback address; set AUTH_REQUIRED=true before exposing the server`,
    );
  }
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}
