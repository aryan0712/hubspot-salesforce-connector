import { AsyncLocalStorage } from 'node:async_hooks';
import type { App } from './app.js';

/**
 * R11 multi-tenant composition: one fully isolated App (configuration, stores, connectors,
 * workers) per workspace, built on first use and cached. Every request and job resolves
 * its workspace's App; nothing tenant-owned is shared between them.
 */
export class TenantApps {
  private apps = new Map<string, Promise<App>>();
  private ready = new Map<string, App>();

  constructor(private readonly build: (tenantId: string) => Promise<App>) {}

  get(tenantId: string): Promise<App> {
    let pending = this.apps.get(tenantId);
    if (!pending) {
      pending = this.build(tenantId).then(
        (app) => {
          this.ready.set(tenantId, app);
          return app;
        },
        (err) => {
          this.apps.delete(tenantId); // do not cache a failed build
          throw err;
        },
      );
      this.apps.set(tenantId, pending);
    }
    return pending;
  }

  /** Apps built so far (e.g. to stop their workers on shutdown). */
  loaded(): App[] {
    return [...this.ready.values()];
  }
}

const requestApp = new AsyncLocalStorage<App>();

/** Runs a request (or job) against a workspace's App. */
export function runWithApp<T>(app: App, fn: () => T): T {
  return requestApp.run(app, fn);
}

export function currentApp(): App | undefined {
  return requestApp.getStore();
}

/**
 * A stand-in for "this request's App": every property read resolves the App bound to the
 * current request, falling back to `root` (the process's own workspace) outside one.
 */
export function requestScopedApp(root: App): App {
  return new Proxy({} as App, {
    get: (_target, property) => Reflect.get(currentApp() ?? root, property),
    has: (_target, property) => Reflect.has(currentApp() ?? root, property),
  });
}
