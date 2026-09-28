import { Router } from 'express';
import { requireRole } from '../../security/access.js';
import type { RouteContext } from '../context.js';

/** Admin-managed machine API keys (create shows the key once; list never re-shows it). */
export function apiKeyRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app } = ctx;

  router.get('/api/admin/api-keys', requireRole('admin'), async (_req, res) => {
    res.json({ entries: await app.apiKeys?.list() ?? [] });
  });

  router.post('/api/admin/api-keys', requireRole('admin'), async (req, res) => {
    if (!app.apiKeys) return res.status(503).json({ error: 'postgres_required' });
    const name = String(req.body?.name ?? '').trim();
    const role = req.body?.role as 'admin' | 'operator' | 'viewer';
    if (!name || !['admin', 'operator', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'name_and_valid_role_required' });
    }
    const created = await app.apiKeys.create(name, role);
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'api_key.created',
      resourceType: 'api_key',
      resourceId: created.id,
      detail: { name, role, prefix: created.prefix },
    });
    res.status(201).json(created);
  });

  router.delete('/api/admin/api-keys/:id', requireRole('admin'), async (req, res) => {
    await app.apiKeys?.revoke(String(req.params.id));
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'api_key.revoked',
      resourceType: 'api_key',
      resourceId: String(req.params.id),
      detail: {},
    });
    res.json({ ok: true });
  });

  return router;
}
