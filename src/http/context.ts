import type { RequestHandler } from 'express';
import type { App } from '../app.js';
import type { CanonicalType, SystemId } from '../core/types.js';
import type { RuntimePolicy } from '../security/runtimeGuard.js';
import type { SessionService } from '../security/identity.js';
import type { MigrationCopilot } from '../ai/migrationCopilot.js';
import type { AccountRouteStore } from '../webhooks/inbox.js';
import type { HttpAppOptions } from '../httpApp.js';

/**
 * What a route module needs (R13). Routes depend on this context and on engine/store
 * contracts only -- never on connector implementations or the database directly -- so the
 * dependency direction stays routes -> services/engines -> connector/store contracts.
 */
export interface RouteContext {
  /** The App of the current request's workspace (request-scoped, R11). */
  app: App;
  /** The App passed to buildHttpApp -- the process's own workspace (single-tenant). */
  rootApp: App;
  runtime: RuntimePolicy;
  /** Initializes this workspace's live connectors on first use. */
  ensureLiveInit(): Promise<void>;
  /** Forces the next ensureLiveInit() to re-initialize (after a credential/connection change). */
  resetLiveInit(): void;
  /** Whether a canonical object type is currently registered. */
  isType(value: string): boolean;
  /**
   * Pauses live sync (webhook + polling) for an object whose mapping/matching configuration
   * just changed, so nothing syncs against stale assumptions until an operator reviews it.
   */
  pauseSyncIfLive(type: CanonicalType, actorId: string | undefined, reason: string): Promise<boolean>;
  /** Runs fn against a workspace's App (root, or a registered tenant), in its tenant scope. */
  withTenantApp<T>(tenantId: string | undefined, fn: (target: App) => T | Promise<T>): Promise<T>;
  sessions: SessionService;
  /** Whether cookies should be marked Secure (the public base URL is HTTPS). */
  secureCookies: boolean;
  migrationCopilot: MigrationCopilot;
  accountRoutes: AccountRouteStore;
  options: HttpAppOptions;
  /** Origins allowed to make unsafe (non-GET/HEAD) requests to /api. */
  apiOrigins: Set<string>;
  /**
   * Session/API-key authentication and tenant binding, for routes outside the `/api`
   * prefix (that middleware pair is otherwise applied once, to the whole `/api` router).
   */
  authn: RequestHandler;
  bindTenant: RequestHandler;
}

export function isSystem(value: string): value is SystemId {
  return value === 'salesforce' || value === 'hubspot';
}

/** A bounded `limit` query parameter. */
export function limitParam(value: unknown, fallback = 100, max = 500): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}
