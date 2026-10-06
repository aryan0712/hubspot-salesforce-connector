import { env } from './config/env.js';
import { logger } from './logger.js';
import { createApp, type App } from './app.js';
import { buildHttpApp, startWorkers, stopWorkers } from './httpApp.js';
import { assertSafeRuntime, resolveRuntimePolicy } from './security/runtimeGuard.js';
import { installGracefulShutdown } from './lifecycle.js';
import { requireTenantScope } from './core/tenantScope.js';
import { TenantApps } from './tenancy.js';
import type { SessionService } from './security/identity.js';
import { scheduleRetention } from './db/retention.js';

/**
 * Web process entry point: validates the runtime policy before touching the database,
 * composes the live App, builds the HTTP surface (src/httpApp.ts) and listens. With
 * RUN_WORKERS=true (the local default) it also runs the background workers; deployments
 * can set RUN_WORKERS=false and run `npm run worker` (src/worker.ts) separately.
 *
 * TENANCY_MODE=multi (R11) composes one isolated App per workspace on first use; requests
 * run for the signed-in user's workspace and tenant stores are never process-global.
 */
async function main(): Promise<void> {
  const runtime = resolveRuntimePolicy(env);
  assertSafeRuntime(runtime);
  if (runtime.multiTenant) requireTenantScope(true);
  // The real app uses live connectors; they're initialized lazily once orgs are connected.
  const app = await createApp({ mock: false, initConnectors: false, scoped: runtime.multiTenant });
  const workerApps = new Set<App>();
  const tenants = runtime.multiTenant && app.database
    ? new TenantApps(async (tenantId) => {
        const tenantApp = await createApp({
          mock: false,
          initConnectors: false,
          scoped: true,
          database: { ...app.database!, tenantId },
        });
        if (env.RUN_WORKERS) startTenantWorkers(tenantApp, workerApps);
        return tenantApp;
      })
    : undefined;
  const http = await buildHttpApp(app, { runtime, tenants });
  await bootstrapOwner(http.sessions, app.tenantId);
  let stopRetention: (() => void) | undefined;
  if (env.RUN_WORKERS) {
    http.startBackground();
    workerApps.add(app);
    // R14: purge finished operational rows daily (evidence and live state are kept).
    if (app.db) stopRetention = scheduleRetention(app.db);
  }
  const listener = http.server.listen(env.PORT, () => {
    logger.info(`crm-sync listening on http://localhost:${env.PORT}/`);
    logger.info(
      runtime.demoRoutes
        ? 'Open it to connect Salesforce + HubSpot (or /demo for the playground)'
        : 'Open it to connect Salesforce + HubSpot',
    );
  });
  installGracefulShutdown([
    // 1. stop accepting requests, 2. stop claiming work and finish in-flight jobs,
    // 3. close the database.
    () => new Promise<void>((resolve) => listener.close(() => resolve())),
    () => {
      stopRetention?.();
      return Promise.all([...workerApps].map((workerApp) => stopWorkers(workerApp))).then(() => undefined);
    },
    () => app.db?.close() ?? Promise.resolve(),
  ]);
}

function startTenantWorkers(app: App, running: Set<App>): void {
  let inited = false;
  startWorkers(app, async () => {
    if (inited) return;
    await Promise.all(Object.values(app.connectors).map((connector) => connector.init()));
    inited = true;
  });
  running.add(app);
}

/** Creates the first owner of an empty workspace from BOOTSTRAP_OWNER_* (never overwrites). */
async function bootstrapOwner(sessions: SessionService, tenantId: string | undefined): Promise<void> {
  if (!tenantId || !env.BOOTSTRAP_OWNER_EMAIL || !env.BOOTSTRAP_OWNER_PASSWORD) return;
  if ((await sessions.store.listMembers(tenantId)).length) return;
  await sessions.addMember({
    tenantId,
    email: env.BOOTSTRAP_OWNER_EMAIL,
    role: 'owner',
    password: env.BOOTSTRAP_OWNER_PASSWORD,
  });
  logger.info({ email: env.BOOTSTRAP_OWNER_EMAIL }, 'bootstrap owner created for the workspace');
}

main().catch((err) => {
  logger.fatal({ err }, 'server crashed');
  process.exit(1);
});
