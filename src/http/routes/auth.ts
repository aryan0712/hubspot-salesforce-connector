import express, { Router, type Request } from 'express';
import {
  clearSessionCookies,
  readCookie,
  SESSION_COOKIE,
  sessionCookies,
} from '../../security/access.js';
import { InvalidCredentialsError, LoginThrottledError, NoMembershipError } from '../../security/identity.js';
import { loginPage } from '../helpers.js';
import type { RouteContext } from '../context.js';

/** Browser sign-in with a server-side session (R11 sessions); machines use Bearer API keys on /api. */
export function authRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { sessions, secureCookies, apiOrigins, withTenantApp } = ctx;
  const sameOrigin = (req: Request): boolean => {
    const origin = req.headers.origin;
    return !origin || apiOrigins.has(origin);
  };

  router.get('/auth/login', (req, res) => {
    res.type('html').send(loginPage(typeof req.query.error === 'string' ? req.query.error : undefined));
  });

  router.post('/auth/login', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
    // Login CSRF: only this site's own form may sign a browser in.
    if (!sameOrigin(req)) return res.status(403).type('text').send('origin not allowed');
    try {
      const issued = await sessions.login({
        email: String(req.body?.email ?? ''),
        password: String(req.body?.password ?? ''),
        ip: req.ip ?? 'unknown',
        userAgent: req.headers['user-agent'],
      });
      res.setHeader('set-cookie', sessionCookies(issued, { secure: secureCookies, maxAgeSeconds: 12 * 60 * 60 }));
      await withTenantApp(issued.auth.tenantId, (target) =>
        target.operations?.recordAudit({
          actorId: `user:${issued.auth.userId}`,
          action: 'auth.signed_in',
          resourceType: 'session',
          detail: { ip: req.ip },
        }),
      ).catch(() => undefined);
      res.redirect(303, '/ops');
    } catch (err) {
      if (err instanceof LoginThrottledError) {
        res.setHeader('retry-after', String(err.retryAfterSeconds));
        return res.status(429).type('html').send(loginPage('throttled'));
      }
      if (err instanceof InvalidCredentialsError || err instanceof NoMembershipError) {
        return res.status(401).type('html').send(loginPage('invalid'));
      }
      throw err;
    }
  });

  router.post('/auth/logout', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).type('text').send('origin not allowed');
    await sessions.logout(readCookie(req.headers.cookie, SESSION_COOKIE) ?? '');
    res.setHeader('set-cookie', clearSessionCookies(secureCookies));
    res.redirect(303, '/auth/login');
  });

  return router;
}
