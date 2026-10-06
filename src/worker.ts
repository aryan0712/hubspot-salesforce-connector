import { env } from './config/env.js';
import { logger } from './logger.js';
import { createApp, type App } from './app.js';
import { startWorkers, stopWorkers } from './httpApp.js';
import { installGracefulShutdown } from './lifecycle.js';
import { requireTenantScope } from './core/tenantScope.js';
import { TenantRepository } from './db/tenantRepository.js';
import { scheduleRetention } from './db/retention.js';

/**
 * Dedicated worker process (R09): live sync, scheduled polling, alert digests and durable
 * migration execution, without the HTTP surface. Several can run side by side -- claims use
 * leases (FOR UPDATE SKIP LOCKED + lease tokens) and record identities are serialized with
 * advisory locks, so replicas never double-process work and recover each other's expired
 * leases without restarts.
 *
 * TENANCY_MODE=multi (R11): one isolated App per active workspace, each running its own
 * workers inside its tenant scope; new workspaces are picked up every minute.
 *
 *   npm run worker
 */
async function main(): Promise<void> {
  const multi = env.TENANCY_MODE === 'multi';
  if (multi) requireTenantScope(true);
  const root = await createApp({ mock: false, initConnectors: false, scoped: multi });
  const running = new Map<string, App>();
  const start = (app: App, key: string) => {
    let inited = false;
    startWorkers(app, async () => {
      if (inited) return;
      await Promise.all(Object.values(app.connectors).map((connector) => connector.init()));
      inited = true;
    });
    running.set(key, app);
  };
  start(root, root.tenantId ?? 'default');

  let discovery: NodeJS.Timeout | undefined;
  if (multi && root.database) {
    const tenants = new TenantRepository(root.database.db);
    const discover = async () => {
      for (const tenant of await tenants.listActive()) {
        if (running.has(tenant.id)) continue;
        const app = await createApp({
          mock: false,
          initConnectors: false,
          scoped: true,
          database: { ...root.database!, tenantId: tenant.id },
        });
        start(app, tenant.id);
        logger.info({ tenant: tenant.slug }, 'workers started for workspace');
      }
    };
    await discover();
    discovery = setInterval(() => void discover().catch((err) => logger.error({ err }, 'workspace discovery failed')), 60_000);
  }
  // R14: purge finished operational rows daily (evidence and live state are kept).
  const stopRetention = root.db ? scheduleRetention(root.db) : undefined;
  logger.info({ workspaces: running.size, multi }, 'crm-sync worker started');
  installGracefulShutdown([
    async () => {
      if (discovery) clearInterval(discovery);
      stopRetention?.();
      await Promise.all([...running.values()].map((app) => stopWorkers(app)));
    },
    () => root.db?.close() ?? Promise.resolve(),
  ]);
}

main().catch((err) => {
  logger.fatal({ err }, 'worker crashed');
  process.exit(1);
});
