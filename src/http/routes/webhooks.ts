import { Router, type Request, type Response } from 'express';
import express from 'express';
import { env } from '../../config/env.js';
import { connections } from '../../core/connectionStore.js';
import { settings } from '../../core/settingsStore.js';
import { runInTenant } from '../../core/tenantScope.js';
import { requireRole, type AuthContext } from '../../security/access.js';
import type { App } from '../../app.js';
import type { SystemId } from '../../core/types.js';
import { webhookOutcomes } from '../../observability/metrics.js';
import { WebhookIngress, salesforceWebhookSecret, type WebhookWorkspace } from '../../webhooks/ingress.js';
import { MAX_WEBHOOK_BODY_BYTES } from '../../webhooks/types.js';
import type { RouteContext } from '../context.js';

/**
 * Inbound webhook ingress (R12): verify, validate, route by verified account, persist,
 * THEN acknowledge. Type resolution and CRM reads happen later on an initialized worker
 * (the inbox processor). Also builds the `WebhookIngress` instance the caller needs to
 * expose on the returned `HttpApp` (metrics, and for tests to drive directly).
 */
export function webhookRoutes(ctx: RouteContext): { router: Router; webhookIngress: WebhookIngress } {
  const router = Router();
  const { app, rootApp, runtime, options, accountRoutes } = ctx;
  const allowUnsigned = options.webhooks?.allowUnsigned ?? env.ALLOW_UNSIGNED_WEBHOOKS;

  const safely = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };
  const workspaceOf = (target: App): WebhookWorkspace => {
    const inScope = <T>(fn: () => Promise<T>): Promise<T> => (target.scope ? runInTenant(target.scope, fn) : fn());
    return {
      tenantId: target.tenantId,
      inbox: target.webhookInbox,
      secret: (system) =>
        options.webhooks?.secret
          ? options.webhooks.secret(system, target.tenantId)
          : inScope(async () =>
              system === 'hubspot'
                ? (await safely(() => settings.get('hubspot')))?.clientSecret ||
                  (runtime.multiTenant ? undefined : env.HUBSPOT_APP_SECRET)
                : salesforceWebhookSecret(env.SF_WEBHOOK_SECRET, target.tenantId, runtime.multiTenant),
            ),
      connectedAccount: (system) => inScope(async () => (await safely(() => connections.get(system)))?.accountId),
      alert: (message) => target.activity.record({ kind: 'error', message }),
      notify: () => target.inboxProcessor.kick(),
    };
  };
  const webhookIngress = new WebhookIngress({
    publicBaseUrl: runtime.publicBaseUrl,
    salesforceMode: options.webhooks?.salesforceMode ?? env.SF_WEBHOOK_SIGNATURE,
    allowUnsigned,
    maxBacklog: options.webhooks?.maxBacklog ?? env.WEBHOOK_MAX_BACKLOG,
    now: options.webhooks?.now,
    async resolveWorkspace(system, accountId) {
      if (!runtime.multiTenant) return workspaceOf(rootApp);
      if (!accountId) return undefined;
      const tenantId = await accountRoutes.tenantFor(system, accountId);
      if (!tenantId) return undefined;
      if (tenantId === rootApp.tenantId) return workspaceOf(rootApp);
      return options.tenants ? workspaceOf(await options.tenants.get(tenantId)) : undefined;
    },
  });
  const webhookRoute = (system: SystemId) => async (req: Request, res: Response) => {
    const result = await webhookIngress.handle(system, {
      method: req.method,
      originalUrl: req.originalUrl,
      headers: req.headers,
      body: Buffer.isBuffer(req.body) ? req.body : undefined,
    });
    webhookOutcomes.inc({ system, outcome: result.status === 200 ? 'accepted' : String(result.body.error ?? result.status) });
    res.status(result.status).json(result.body);
  };
  // Read the raw body whatever Content-Type the sender declared (signatures cover the bytes).
  const webhookBody = express.raw({ type: () => true, limit: MAX_WEBHOOK_BODY_BYTES });
  router.post('/webhooks/salesforce', webhookBody, webhookRoute('salesforce'));
  router.post('/webhooks/hubspot', webhookBody, webhookRoute('hubspot'));

  router.get('/api/webhooks/stats', async (_req, res) => {
    const auth = res.locals.auth as AuthContext;
    res.json({ ...webhookIngress.metrics.snapshot(auth.tenantId), pending: await app.webhookInbox.pendingCount() });
  });

  /** What an admin configures in the Salesforce sender (docs/WEBHOOKS.md). */
  router.get('/api/webhooks/salesforce/contract', requireRole('admin'), async (_req, res) => {
    const auth = res.locals.auth as AuthContext;
    const derived = runtime.multiTenant
      ? salesforceWebhookSecret(env.SF_WEBHOOK_SECRET, auth.tenantId, true)
      : undefined;
    if (derived) {
      await app.operations?.recordAudit({
        actorId: auth.actorId,
        action: 'webhook.secret_viewed',
        resourceType: 'webhook',
        resourceId: 'salesforce',
        detail: {},
      });
    }
    res.json({
      endpoint: `${runtime.publicBaseUrl.replace(/\/$/, '')}/webhooks/salesforce`,
      signature: 'v2',
      mode: options.webhooks?.salesforceMode ?? env.SF_WEBHOOK_SIGNATURE,
      secretConfigured: Boolean(env.SF_WEBHOOK_SECRET),
      // Multi-tenant: this workspace's own derived secret. Single-tenant: SF_WEBHOOK_SECRET.
      secret: derived,
    });
  });

  return { router, webhookIngress };
}
