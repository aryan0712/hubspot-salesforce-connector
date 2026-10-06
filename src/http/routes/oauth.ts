import { Router } from 'express';
import { createPkce } from '../../core/pkce.js';
import { connections, type Environment } from '../../core/connectionStore.js';
import { logger } from '../../logger.js';
import { requireRole, type AuthContext } from '../../security/access.js';
import type { SystemId } from '../../core/types.js';
import * as sfAuth from '../../connectors/salesforce/auth.js';
import * as hsAuth from '../../connectors/hubspot/auth.js';
import { sameAccount, sessionKey } from '../helpers.js';
import type { RouteContext } from '../context.js';

const ENVS: Environment[] = ['production', 'sandbox'];
const AUTH = { salesforce: sfAuth, hubspot: hsAuth };

/**
 * OAuth (with PKCE), R11. Only an authenticated admin (browser session, or local
 * development) may connect a CRM. State is persisted, single-use, expires after 10
 * minutes, and is bound to the session, user, workspace, system, environment and redirect
 * URI. A reconnect to a DIFFERENT account is staged until the admin confirms the
 * replacement (see connections.ts for the confirm/cancel endpoints).
 */
export function oauthRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app, accountRoutes, authn, bindTenant } = ctx;
  const oauthGuard = [authn, bindTenant, requireRole('admin')] as const;

  router.get('/auth/:system/start', ...oauthGuard, async (req, res) => {
    const auth = res.locals.auth as AuthContext;
    const system = req.params.system as SystemId;
    const environment = (String(req.query.env ?? 'production') as Environment);
    const mod = AUTH[system as keyof typeof AUTH];
    if (!mod || !ENVS.includes(environment)) return res.redirect('/?error=bad_request');
    if (auth.via === 'api-key') return res.status(403).json({ error: 'browser_session_required' });
    if (!(await mod.isConfigured())) return res.redirect('/?error=not_configured');
    const { verifier, challenge } = createPkce();
    const state = await app.oauthStates.create({
      tenantId: auth.tenantId ?? 'local',
      sessionHash: sessionKey(auth),
      userId: auth.userId ?? auth.actorId,
      system,
      environment,
      redirectUri: mod.redirectUri(),
      codeVerifier: verifier,
    });
    res.redirect(await mod.authUrl(environment, state, challenge));
  });

  router.get('/auth/:system/callback', ...oauthGuard, async (req, res) => {
    const auth = res.locals.auth as AuthContext;
    const system = req.params.system as SystemId;
    const mod = AUTH[system as keyof typeof AUTH];
    if (!mod) return res.redirect('/?error=bad_request');
    // Wrong system, another session, reused or expired state: all refused the same way.
    const entry = await app.oauthStates.consume(
      auth.tenantId ?? 'local',
      String(req.query.state ?? ''),
      sessionKey(auth),
      system,
    );
    if (!entry || entry.redirectUri !== mod.redirectUri()) {
      logger.warn({ system, requestId: res.locals.requestId }, 'oauth callback with invalid state');
      return res.redirect('/?error=oauth_state_invalid');
    }
    try {
      const next = await mod.exchangeCode(entry.environment, String(req.query.code ?? ''), entry.codeVerifier);
      // One CRM account belongs to one workspace, so its webhooks route unambiguously.
      const owner = next.accountId ? await accountRoutes.tenantFor(system, next.accountId) : undefined;
      if (owner && owner !== auth.tenantId) {
        await app.operations?.recordAudit({
          actorId: auth.actorId,
          action: 'connection.refused_account_in_use',
          resourceType: 'connection',
          resourceId: system,
          detail: { accountId: next.accountId },
        });
        return res.redirect('/?error=account_in_use');
      }
      const previous = await connections.get(system);
      if (previous && !sameAccount(previous, next)) {
        await app.oauthStates.stagePending(entry.tenantId, entry.id, next);
        return res.redirect(`/?confirm=${system}&pending=${entry.id}`);
      }
      if (next.accountId && auth.tenantId && (await accountRoutes.bind(system, next.accountId, auth.tenantId)) === 'conflict') {
        return res.redirect('/?error=account_in_use');
      }
      await connections.set(next);
      ctx.resetLiveInit();
      await app.operations?.recordAudit({
        actorId: auth.actorId,
        action: previous ? 'connection.reauthorized' : 'connection.connected',
        resourceType: 'connection',
        resourceId: system,
        detail: { environment: next.environment, accountId: next.accountId, accountLabel: next.accountLabel },
      });
      res.redirect(`/?connected=${system}`);
    } catch (err) {
      logger.error({ err, system }, 'oauth callback failed');
      res.redirect(`/?error=oauth_failed`);
    }
  });

  return router;
}
