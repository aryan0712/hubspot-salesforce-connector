import { Router } from 'express';
import {
  readCookie,
  requireRole,
  SESSION_COOKIE,
  sessionCookies,
  type AuthContext,
} from '../../security/access.js';
import { InvalidCredentialsError, NoMembershipError } from '../../security/identity.js';
import { passwordProblem } from '../../security/passwords.js';
import type { Role } from '../../db/operationsRepository.js';
import type { RouteContext } from '../context.js';

/** The signed-in user's session/workspaces (R11), workspace switching, and member management. */
export function sessionRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app, sessions, secureCookies } = ctx;

  router.get('/api/session', async (_req, res) => {
    const auth = res.locals.auth as AuthContext;
    res.json({
      actorId: auth.actorId,
      email: auth.email,
      role: auth.role,
      via: auth.via,
      tenantId: auth.tenantId,
      workspaces: auth.userId ? await sessions.workspaces(auth.userId) : [],
    });
  });

  router.post('/api/session/workspace', async (req, res) => {
    const auth = res.locals.auth as AuthContext;
    if (auth.via !== 'session') return res.status(400).json({ error: 'browser_session_required' });
    const tenantId = String(req.body?.tenantId ?? '');
    try {
      const issued = await sessions.switchTenant(readCookie(req.headers.cookie, SESSION_COOKIE) ?? '', tenantId);
      res.setHeader('set-cookie', sessionCookies(issued, { secure: secureCookies, maxAgeSeconds: 12 * 60 * 60 }));
      res.json({ tenantId: issued.auth.tenantId, role: issued.auth.role });
    } catch (err) {
      if (err instanceof NoMembershipError || err instanceof InvalidCredentialsError) {
        return res.status(403).json({ error: 'not_a_member' });
      }
      throw err;
    }
  });

  router.get('/api/members', requireRole('admin'), async (_req, res) => {
    const auth = res.locals.auth as AuthContext;
    if (!auth.tenantId) return res.json({ entries: [] });
    res.json({ entries: await sessions.store.listMembers(auth.tenantId) });
  });

  router.post('/api/members', requireRole('owner'), async (req, res) => {
    const auth = res.locals.auth as AuthContext;
    if (!auth.tenantId) return res.status(503).json({ error: 'workspace_required' });
    const email = String(req.body?.email ?? '').trim();
    const role = String(req.body?.role ?? '') as Role;
    const password = req.body?.password ? String(req.body.password) : undefined;
    if (!/^[^@\s]+@[^@\s]+$/.test(email) || !['owner', 'admin', 'operator', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'email_and_valid_role_required' });
    }
    const problem = password ? passwordProblem(password) : undefined;
    if (problem) return res.status(400).json({ error: 'weak_password', detail: problem });
    const member = await sessions.addMember({ tenantId: auth.tenantId, email, role, password });
    await app.operations?.recordAudit({
      actorId: auth.actorId,
      action: 'member.upserted',
      resourceType: 'member',
      resourceId: member.userId,
      detail: { email: member.email, role },
    });
    res.status(201).json(member);
  });

  router.delete('/api/members/:userId', requireRole('owner'), async (req, res) => {
    const auth = res.locals.auth as AuthContext;
    if (!auth.tenantId) return res.status(503).json({ error: 'workspace_required' });
    const userId = String(req.params.userId);
    const members = await sessions.store.listMembers(auth.tenantId);
    const target = members.find((member) => member.userId === userId);
    if (!target) return res.status(404).json({ error: 'member_not_found' });
    if (target.role === 'owner' && members.filter((member) => member.role === 'owner').length === 1) {
      return res.status(409).json({ error: 'last_owner' });
    }
    await sessions.removeMember(auth.tenantId, userId);
    await app.operations?.recordAudit({
      actorId: auth.actorId,
      action: 'member.removed',
      resourceType: 'member',
      resourceId: userId,
      detail: { email: target.email, role: target.role },
    });
    res.json({ ok: true });
  });

  return router;
}
