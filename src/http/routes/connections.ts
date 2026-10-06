import { Router } from 'express';
import { connections } from '../../core/connectionStore.js';
import { settings } from '../../core/settingsStore.js';
import { requireRole, type AuthContext } from '../../security/access.js';
import type { SystemId } from '../../core/types.js';
import { isSystem } from '../context.js';
import { accountSummary, sessionKey } from '../helpers.js';
import type { RouteContext } from '../context.js';

/**
 * Connected-account lifecycle: app OAuth credentials, disconnect, and confirming or
 * cancelling a staged reconnect to a different account (see oauth.ts for the OAuth flow
 * itself, which stages the replacement).
 */
export function connectionRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app, accountRoutes } = ctx;

  router.post('/api/connections/:system/disconnect', requireRole('admin'), async (req, res) => {
    const system = req.params.system as SystemId;
    if (!isSystem(system)) return res.status(400).json({ error: 'bad_system' });
    const previous = await connections.get(system);
    await connections.delete(system);
    const tenantForRoutes = (res.locals.auth as AuthContext | undefined)?.tenantId;
    if (tenantForRoutes) await accountRoutes.unbind(system, tenantForRoutes);
    const invalidated = await app.migrationPlans.invalidateApprovals(
      app.config.listCanonicalObjects().map((object) => object.canonicalObject),
    );
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'connection.disconnected',
      resourceType: 'connection',
      resourceId: system,
      detail: { account: accountSummary(previous), approvalsInvalidated: invalidated },
    });
    ctx.resetLiveInit(); // force re-init on next live op
    res.json({ ok: true });
  });

  // ---------------- App credentials (entered from the browser) ----------------
  // Never returns secrets — only the client id and whether a secret is stored.
  router.get('/api/settings', async (_req, res) => {
    const [s, h] = await Promise.all([
      settings.get('salesforce'),
      settings.get('hubspot'),
    ]);
    res.json({
      salesforce: { clientId: s?.clientId ?? '', hasSecret: Boolean(s?.clientSecret) },
      hubspot: { clientId: h?.clientId ?? '', hasSecret: Boolean(h?.clientSecret) },
    });
  });

  router.post('/api/settings/:system', requireRole('admin'), async (req, res) => {
    const system = req.params.system as SystemId;
    if (system !== 'salesforce' && system !== 'hubspot') {
      return res.status(400).json({ error: 'bad system' });
    }
    const clientId = String(req.body?.clientId ?? '').trim();
    let clientSecret = String(req.body?.clientSecret ?? '');
    if (!clientId) return res.status(400).json({ error: 'clientId required' });
    // Blank secret means "keep the existing one" (so the UI can hide it after first save).
    if (!clientSecret) clientSecret = (await settings.get(system))?.clientSecret ?? '';
    if (!clientSecret) return res.status(400).json({ error: 'clientSecret required' });
    await settings.set(system, { clientId, clientSecret });
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'credentials.updated',
      resourceType: 'oauth_app',
      resourceId: system,
      detail: { clientIdChanged: true, secretChanged: Boolean(req.body?.clientSecret) },
    });
    ctx.resetLiveInit();
    res.json({ ok: true });
  });

  router.get('/api/connections/:system/pending/:id', requireRole('admin'), async (req, res) => {
    const auth = res.locals.auth as AuthContext;
    const system = req.params.system as SystemId;
    const pending = await app.oauthStates.pending(auth.tenantId ?? 'local', String(req.params.id), sessionKey(auth));
    if (!pending || pending.system !== system) return res.status(404).json({ error: 'pending_connection_not_found' });
    const current = await connections.get(system);
    res.json({ system, current: accountSummary(current), next: accountSummary(pending.connection) });
  });

  router.post('/api/connections/:system/pending/:id/:decision', requireRole('admin'), async (req, res) => {
    const auth = res.locals.auth as AuthContext;
    const system = req.params.system as SystemId;
    const decision = String(req.params.decision);
    if (decision !== 'confirm' && decision !== 'cancel') return res.status(404).json({ error: 'not_found' });
    const tenantKey = auth.tenantId ?? 'local';
    const pending = await app.oauthStates.pending(tenantKey, String(req.params.id), sessionKey(auth));
    if (!pending || pending.system !== system) return res.status(404).json({ error: 'pending_connection_not_found' });
    await app.oauthStates.clearPending(tenantKey, pending.id);
    const current = await connections.get(system);
    if (decision === 'cancel') {
      await app.operations?.recordAudit({
        actorId: auth.actorId,
        action: 'connection.replacement_cancelled',
        resourceType: 'connection',
        resourceId: system,
        detail: { kept: accountSummary(current), rejected: accountSummary(pending.connection) },
      });
      return res.json({ ok: true, replaced: false });
    }
    if (auth.tenantId) {
      if (pending.connection.accountId) {
        if ((await accountRoutes.bind(system, pending.connection.accountId, auth.tenantId)) === 'conflict') {
          return res.status(409).json({ error: 'account_in_use' });
        }
      } else {
        await accountRoutes.unbind(system, auth.tenantId);
      }
    }
    await connections.set(pending.connection);
    ctx.resetLiveInit();
    // Approvals were made against the previous account; none of them may run against this one.
    const invalidated = await app.migrationPlans.invalidateApprovals(
      app.config.listCanonicalObjects().map((object) => object.canonicalObject),
    );
    await app.operations?.recordAudit({
      actorId: auth.actorId,
      action: 'connection.replaced',
      resourceType: 'connection',
      resourceId: system,
      detail: { from: accountSummary(current), to: accountSummary(pending.connection), approvalsInvalidated: invalidated },
    });
    res.json({ ok: true, replaced: true, approvalsInvalidated: invalidated });
  });

  return router;
}
