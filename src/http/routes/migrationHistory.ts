import { Router } from 'express';
import { requireRole } from '../../security/access.js';
import { decodeCursor, page } from '../../core/pagination.js';
import { limitParam, type RouteContext } from '../context.js';

/** Legacy migration run history, the audit log, usage counters, and the workspace summary. */
export function migrationHistoryRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app } = ctx;

  router.get('/api/migrations', async (req, res) => {
    res.json({ entries: await app.migration.store.list(limitParam(req.query.limit, 50, 200)) });
  });

  router.get('/api/migrations/:id/items', async (req, res) => {
    res.json({
      entries: await app.migration.store.plans(String(req.params.id), limitParam(req.query.limit, 500, 2000)),
    });
  });

  router.get('/api/audit', requireRole('admin'), async (req, res) => {
    const limit = limitParam(req.query.limit, 100, 500);
    res.json(page((await app.operations?.listAudit(limit, decodeCursor(req.query.cursor))) ?? [], limit));
  });

  router.get('/api/usage', async (_req, res) => {
    res.json({ usage: await app.operations?.usage() ?? {} });
  });

  router.get('/api/workspace-overview', async (_req, res) => {
    res.json(
      (await app.operations?.workspaceOverview()) ?? {
        // No database: the in-memory demo workspace.
        name: app.mock ? 'Demo workspace' : 'Local workspace',
        slug: app.mock ? 'demo' : 'local',
        plan: app.mock ? 'demo' : 'local',
        status: app.mock ? 'demo' : 'active',
        limits: {},
        team: [],
      },
    );
  });

  return router;
}
