import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConnectionStore } from './connectionStore.js';
import type { SettingsStore } from './settingsStore.js';

/**
 * R11: the tenant a piece of work runs for. Request handlers, workers and every connector
 * call of a tenant's app run inside its scope, so the OAuth connection and app-credential
 * stores used by the connector/auth modules are that tenant's -- never a process global.
 */
export interface TenantScope {
  tenantId: string;
  connections: ConnectionStore;
  settings: SettingsStore;
}

const storage = new AsyncLocalStorage<TenantScope>();
let strict = false;

export function runInTenant<T>(scope: TenantScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentTenantScope(): TenantScope | undefined {
  return storage.getStore();
}

/**
 * Multi-tenant processes fail closed: tenant-owned stores cannot be reached outside a
 * tenant scope (no silent fallback to a process-wide default).
 */
export function requireTenantScope(value: boolean): void {
  strict = value;
}

export function tenantScopeRequired(): boolean {
  return strict;
}

/**
 * Wraps every method of an object so it runs in the tenant's scope, whoever calls it (a
 * request, a timer, a worker). Used for connectors, whose auth modules read the scoped stores.
 */
export function bindToTenant<T extends object>(target: T, scope: TenantScope): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => runInTenant(scope, () => value.apply(object, args));
    },
  });
}
