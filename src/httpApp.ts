import express, { type Express, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { env } from './config/env.js';
import { logger } from './logger.js';
import type { App } from './app.js';
import { errorHandler } from './http/errors.js';
import { annotateLogContext, withLogContext } from './observability/context.js';
import { authFailures, httpDuration, httpRequests } from './observability/metrics.js';
import type { RouteContext } from './http/context.js';
import { governanceRoutes } from './http/routes/governance.js';
import { healthRoutes } from './http/routes/health.js';
import { statusRoutes } from './http/routes/status.js';
import { aiSettingsRoutes } from './http/routes/aiSettings.js';
import { notificationRoutes } from './http/routes/notifications.js';
import { migrationWorkspaceRoutes } from './http/routes/migrationWorkspace.js';
import { executionRoutes } from './http/routes/executions.js';
import { migrateRoutes } from './http/routes/migrate.js';
import { connectionRoutes } from './http/routes/connections.js';
import { oauthRoutes } from './http/routes/oauth.js';
import { sessionRoutes } from './http/routes/session.js';
import { pageRoutes } from './http/routes/pages.js';
import { authRoutes } from './http/routes/auth.js';
import { demoRoutes } from './http/routes/demo.js';
import { mappingRoutes } from './http/routes/mappings.js';
import { syncRoutes } from './http/routes/sync.js';
import { migrationHistoryRoutes } from './http/routes/migrationHistory.js';
import { apiKeyRoutes } from './http/routes/apiKeys.js';
import { webhookRoutes } from './http/routes/webhooks.js';
import type { CanonicalType } from './core/types.js';
import {
  authenticate,
  type ApiKeyVerifier,
  type AuthContext,
} from './security/access.js';
import {
  InMemoryIdentityStore,
  LocalPasswordProvider,
  SessionService,
} from './security/identity.js';
import { PostgresIdentityStore } from './db/postgresIdentityStore.js';
import { TenantApiKeyVerifier } from './db/operationsRepository.js';
import { runInTenant } from './core/tenantScope.js';
import { requestScopedApp, runWithApp, currentApp, type TenantApps } from './tenancy.js';
import { allowedApiOrigins } from './security/originPolicy.js';
import { MigrationCopilot } from './ai/migrationCopilot.js';
import { assertSafeRuntime, resolveRuntimePolicy, type RuntimePolicy } from './security/runtimeGuard.js';
import { InMemoryAccountRouteStore, type AccountRouteStore } from './webhooks/inbox.js';
import { PostgresAccountRouteStore } from './db/postgresWebhookStores.js';
import type { SalesforceSignatureMode } from './webhooks/salesforce.js';
import { UnsafeRuntimeError } from './security/runtimeGuard.js';
import type { SystemId } from './core/types.js';
import type { WebhookIngress } from './webhooks/ingress.js';

/**
 * HTTP surface (each route group lives in `src/http/routes/`; see that directory for the
 * full path list):
 *   GET  /                              - connections onboarding (entry point)
 *   GET  /demo                          - interactive demo playground (mock CRMs)
 *   GET  /auth/:system/start?env=...    - begin web OAuth (production | sandbox)
 *   GET  /auth/:system/callback         - OAuth redirect target; persists the connection
 *   GET  /api/status | /api/activity    - live connection state + activity
 *   POST /api/migrate                   - run a migration between the connected orgs
 *   POST /api/connections/:system/disconnect
 *   POST /api/demo/*                    - drive the demo playground
 *   POST /webhooks/:system              - inbound change events (raw, signed)
 */

export interface HttpAppOptions {
  /** Startup policy; defaults to the process environment. */
  runtime?: RuntimePolicy;
  /** Builds the isolated mock app behind /demo; defaults to createApp({ mock: true }). */
  createDemoApp?: () => Promise<App>;
  /**
   * R11 multi-tenant mode: resolves the App of each request's workspace. Without it the
   * given App serves only its own workspace and other workspaces' sessions are refused.
   */
  tenants?: TenantApps;
  /** Browser sessions; defaults to local-password sessions on the app's database. */
  sessions?: SessionService;
  /** Machine API keys; defaults to tenant-bound keys on the app's database. */
  apiKeys?: ApiKeyVerifier;
  /** Global CRM account -> workspace routes; defaults to the app's database. */
  accountRoutes?: AccountRouteStore;
  /** Bearer token for /metrics; defaults to METRICS_TOKEN. */
  metricsToken?: string;
  /** Webhook ingress overrides (tests). */
  webhooks?: {
    now?: () => number;
    salesforceMode?: SalesforceSignatureMode;
    maxBacklog?: number;
    allowUnsigned?: boolean;
    /** Secret lookup override; defaults to the workspace's stored app secret / env. */
    secret?: (system: SystemId, tenantId: string | undefined) => Promise<string | undefined>;
  };
}

export interface HttpApp {
  server: Express;
  runtime: RuntimePolicy;
  sessions: SessionService;
  webhooks: WebhookIngress;
  ensureLiveInit(): Promise<void>;
  /** Starts scheduled polling and alert digests (the worker side of this process). */
  startBackground(): void;
  stopBackground(): Promise<void>;
}

/**
 * Builds the Express application around an already-composed App without listening or
 * starting background work, so tests can drive it directly. src/server.ts is the entry
 * point that applies the runtime guard, listens and wires process signals.
 *
 * This function wires shared, request-scoped state into a `RouteContext` (src/http/context.ts)
 * and mounts one router per domain (src/http/routes/*.ts); it owns no route logic itself.
 */
export async function buildHttpApp(rootApp: App, options: HttpAppOptions = {}): Promise<HttpApp> {
  const runtime = options.runtime ?? resolveRuntimePolicy(env);
  assertSafeRuntime(runtime);
  // Route handlers use `app`: the App of the current request's workspace (R11).
  const app = requestScopedApp(rootApp);
  const identityStore = rootApp.db ? new PostgresIdentityStore(rootApp.db) : new InMemoryIdentityStore();
  const sessions = options.sessions ?? new SessionService(identityStore, new LocalPasswordProvider(identityStore));
  const apiKeys =
    options.apiKeys ?? (rootApp.db ? new TenantApiKeyVerifier(rootApp.db, rootApp.tenantId) : undefined);
  const secureCookies = runtime.publicBaseUrl.startsWith('https://');
  const accountRoutes =
    options.accountRoutes ?? (rootApp.db ? new PostgresAccountRouteStore(rootApp.db) : new InMemoryAccountRouteStore());
  const allowUnsigned = options.webhooks?.allowUnsigned ?? env.ALLOW_UNSIGNED_WEBHOOKS;
  if (allowUnsigned && runtime.production) {
    throw new UnsafeRuntimeError('ALLOW_UNSIGNED_WEBHOOKS is for local development only; refusing to start in production');
  }
  const isType = (value: string): boolean => app.config.isRegisteredCanonicalObject(value);
  const storedAiCredential = await app.aiSettings?.get();
  const migrationCopilot = new MigrationCopilot({
    apiKey: storedAiCredential?.apiKey ?? env.OPENAI_API_KEY,
    model: storedAiCredential?.model ?? env.OPENAI_MODEL,
  });
  // Connector initialization is per workspace App.
  const liveInited = new WeakSet<App>();
  const initFor = (target: App) => async (): Promise<void> => {
    if (liveInited.has(target)) return;
    await Promise.all(Object.values(target.connectors).map((c) => c.init()));
    liveInited.add(target);
  };
  async function ensureLiveInit(): Promise<void> {
    await initFor(currentApp() ?? rootApp)();
  }
  const resetLiveInit = (): void => {
    liveInited.delete(currentApp() ?? rootApp);
  };

  /**
   * A change to how an object is mapped (field rules, natural key, value translations) can
   * invalidate assumptions live sync is relying on. If that object is currently syncing --
   * real-time (webhook) or scheduled polling -- pause both so nothing syncs against the
   * edited configuration until an operator reviews it and re-enables sync from the Sync tab.
   */
  async function pauseSyncIfLive(
    type: CanonicalType,
    actorId: string | undefined,
    reason: string,
  ): Promise<boolean> {
    const config = app.syncConfig.get();
    const wasLive = config.objects[type]?.enabled || config.polling[type]?.enabled;
    if (!wasLive) return false;
    await app.syncConfig.update({
      ...config,
      objects: {
        ...config.objects,
        [type]: {
          ...(config.objects[type] ?? { direction: 'bidirectional' as const, enrolledForSync: true }),
          enabled: false,
        },
      },
      polling: {
        ...config.polling,
        [type]: { ...(config.polling[type] ?? { intervalMinutes: 30 }), enabled: false },
      },
    });
    app.activity.record({
      kind: 'info',
      message: `Sync paused for ${type}: ${reason} -- review and re-enable when ready`,
    });
    await app.operations?.recordAudit({
      actorId,
      action: 'sync.paused_by_mapping_change',
      resourceType: 'sync_settings',
      resourceId: type,
      detail: { reason },
    });
    return true;
  }

  const server = express();
  const apiOrigins = allowedApiOrigins(runtime.publicBaseUrl);
  server.disable('x-powered-by');
  server.use((req, res, next) => {
    // A caller-supplied correlation id is kept only if it is safe to log and echo.
    const supplied = req.headers['x-request-id'];
    const requestId =
      typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied) ? supplied : crypto.randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    // same-origin: browsers send our own origin on same-origin POSTs (no-referrer makes them send
    // "Origin: null", which the origin checks rightly refuse) and nothing to other sites.
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'content-security-policy',
      // R13: no inline scripts or handlers anywhere (page scripts are same-origin assets).
      // Inline styles remain allowed; scripts cannot be injected through them.
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    // Every JSON error carries the correlation id, so the UI can show it inline.
    const json = res.json.bind(res);
    res.json = (body: unknown) =>
      json(
        res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && !('requestId' in body)
          ? { ...(body as Record<string, unknown>), requestId }
          : body,
      );
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path
        ? `${req.baseUrl}${String(req.route.path)}`
        : req.path.startsWith('/assets/')
          ? '/assets/:file'
          : 'unmatched';
      httpRequests.inc({ method: req.method, route, status: res.statusCode });
      httpDuration.observe({ method: req.method, route }, Number(process.hrtime.bigint() - started) / 1e9);
      if (res.statusCode === 401 || res.statusCode === 403) {
        authFailures.inc({ reason: res.statusCode === 401 ? 'unauthenticated' : 'forbidden' });
      }
    });
    // Everything this request logs (and every CRM call it makes) carries its id.
    withLogContext({ requestId }, () => next());
  });
  server.use((req, res, next) => {
    if (req.path.startsWith('/webhooks/')) return next();
    return express.json({ limit: '1mb' })(req, res, next);
  });
  server.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (
      origin &&
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      !apiOrigins.has(origin)
    ) {
      return res.status(403).json({ error: 'origin_not_allowed' });
    }
    next();
  });
  const authn = authenticate({
    required: runtime.authRequired,
    sessions,
    apiKeys,
    localTenantId: rootApp.tenantId,
  });
  /** Binds the request to its workspace's App and tenant scope (R11). */
  const bindTenant = async (_req: Request, res: Response, next: (err?: unknown) => void): Promise<void> => {
    const auth = res.locals.auth as AuthContext;
    let target = rootApp;
    if (auth.tenantId && auth.tenantId !== rootApp.tenantId) {
      if (!options.tenants) {
        res.status(403).json({ error: 'workspace_not_served' });
        return;
      }
      target = await options.tenants.get(auth.tenantId);
    }
    annotateLogContext({ tenantId: target.tenantId ?? auth.tenantId });
    runWithApp(target, () => (target.scope ? runInTenant(target.scope, () => next()) : next()));
  };
  server.use('/api', authn, bindTenant);

  /** Runs fn against a workspace's App (root, or a registered tenant). */
  async function withTenantApp<T>(tenantId: string | undefined, fn: (target: App) => T | Promise<T>): Promise<T> {
    const target =
      !tenantId || tenantId === rootApp.tenantId || !options.tenants ? rootApp : await options.tenants.get(tenantId);
    return runWithApp(target, () => (target.scope ? runInTenant(target.scope, () => fn(target)) : fn(target)));
  }

  const routeContext: RouteContext = {
    app,
    rootApp,
    runtime,
    ensureLiveInit,
    resetLiveInit,
    isType,
    pauseSyncIfLive,
    withTenantApp,
    sessions,
    secureCookies,
    migrationCopilot,
    accountRoutes,
    options,
    apiOrigins,
    authn,
    bindTenant,
  };

  const { router: webhookRouter, webhookIngress } = webhookRoutes(routeContext);

  server.use(pageRoutes(routeContext));
  server.use(authRoutes(routeContext));
  server.use(healthRoutes(routeContext));
  server.use(statusRoutes(routeContext));
  server.use(aiSettingsRoutes(routeContext));
  server.use(notificationRoutes(routeContext));
  server.use(migrationWorkspaceRoutes(routeContext));
  server.use(executionRoutes(routeContext));
  server.use(migrateRoutes(routeContext));
  server.use(connectionRoutes(routeContext));
  server.use(oauthRoutes(routeContext));
  server.use(sessionRoutes(routeContext));
  if (runtime.demoRoutes) server.use(demoRoutes(routeContext));
  server.use(mappingRoutes(routeContext));
  server.use(syncRoutes(routeContext));
  server.use(governanceRoutes(routeContext));
  server.use(migrationHistoryRoutes(routeContext));
  server.use(apiKeyRoutes(routeContext));
  server.use(webhookRouter);

  server.use(errorHandler());

  return {
    server,
    runtime,
    sessions,
    webhooks: webhookIngress,
    ensureLiveInit,
    startBackground() {
      startWorkers(rootApp, initFor(rootApp));
    },
    async stopBackground() {
      await stopWorkers(rootApp);
    },
  };
}

/**
 * Starts the worker side of a process: live sync (claims gated on connector readiness),
 * scheduled polling, alert digests and the durable migration worker. Used by the combined
 * server (RUN_WORKERS=true) and by the dedicated worker entry point (src/worker.ts).
 */
export function startWorkers(app: App, ensureLiveInit: () => Promise<void>): void {
  const ready = async (): Promise<boolean> => {
    try {
      await ensureLiveInit();
      return true;
    } catch (err) {
      logger.warn({ err }, 'sync workers waiting: CRM connectors are not ready');
      return false;
    }
  };
  app.workersStarted = true;
  app.sync.start(ready);
  app.inboxProcessor.start(ready);
  app.poller.start(ensureLiveInit);
  app.alertDigester?.start();
  app.migrations.worker.start();
}

/** Stops claiming new work, lets in-flight jobs finish, and leaves the rest queued. */
export async function stopWorkers(app: App): Promise<void> {
  app.workersStarted = false;
  app.poller.stop();
  app.alertDigester?.stop();
  await Promise.all([app.sync.stop(), app.migrations.worker.stop(), app.inboxProcessor.stop()]);
}

/** Same CRM account? Exact ids when both are known; otherwise the recorded instance/portal. */
export { sameAccount } from './http/helpers.js';
