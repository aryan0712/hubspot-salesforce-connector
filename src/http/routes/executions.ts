import { Router, type Request, type Response } from 'express';
import { requireRole } from '../../security/access.js';
import { limitParam, type RouteContext } from '../context.js';

/** Durable migration executions (R08): list, drill into items, and pause/resume/cancel. */
export function executionRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app } = ctx;

  router.get('/api/executions', async (req, res) => {
    res.json({ entries: await app.executions.list(limitParam(req.query.limit, 50, 200)) });
  });

  router.get('/api/executions/:id', async (req, res) => {
    const execution = await app.migrations.execution(String(req.params.id));
    if (!execution) return res.status(404).json({ error: 'execution_not_found' });
    res.json(execution);
  });

  /** Record-level drill-in, keyset-paginated by position (?after=<position>&limit=&status=). */
  router.get('/api/executions/:id/items', async (req, res) => {
    const statuses = ['queued', 'running', 'succeeded', 'skipped', 'failed', 'uncertain', 'cancelled'];
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !statuses.includes(status)) return res.status(400).json({ error: 'bad_item_status' });
    const after = req.query.after === undefined ? undefined : Number(req.query.after);
    if (after !== undefined && !Number.isInteger(after)) return res.status(400).json({ error: 'bad_cursor' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const entries = await app.executions.items(String(req.params.id), {
      after,
      limit,
      status: status as never,
    });
    res.json({
      entries: entries.map((item) => ({
        position: item.position,
        type: item.type,
        sourceId: item.sourceId,
        status: item.status,
        action: item.plan.action,
        targetId: item.targetId ?? item.plan.targetId,
        wrote: item.wrote,
        attempts: item.attempts,
        error: item.error,
        updatedAt: item.updatedAt,
      })),
      nextCursor: entries.length === limit ? entries.at(-1)!.position : undefined,
    });
  });

  const control = (action: 'pause' | 'resume' | 'cancel') =>
    async (req: Request, res: Response): Promise<void> => {
      const id = String(req.params.id);
      const ok =
        action === 'pause'
          ? await app.migrations.pause(id, `paused by ${res.locals.auth?.actorId ?? 'operator'}`)
          : action === 'resume'
            ? await app.migrations.resume(id, { retryFailed: req.body?.retryFailed === true })
            : await app.migrations.cancel(id);
      if (!ok) {
        res.status(409).json({ error: 'execution_state', detail: `cannot ${action} this execution in its current state` });
        return;
      }
      await app.operations?.recordAudit({
        actorId: res.locals.auth?.actorId,
        action: `migration_execution.${action}`,
        resourceType: 'migration_execution',
        resourceId: id,
        detail: { retryFailed: req.body?.retryFailed === true },
      });
      res.json(await app.migrations.execution(id));
    };
  router.post('/api/executions/:id/pause', requireRole('operator'), control('pause'));
  router.post('/api/executions/:id/resume', requireRole('operator'), control('resume'));
  router.post('/api/executions/:id/cancel', requireRole('operator'), control('cancel'));

  return router;
}
