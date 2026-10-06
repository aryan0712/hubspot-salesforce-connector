import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../security/access.js';
import { limitParam, type RouteContext } from '../context.js';
import { parseBody } from '../validation.js';

const resolveConflictBody = z.object({ winner: z.enum(['salesforce', 'hubspot']) });
const pendingStatus = z.enum(['pending', 'resolved', 'unsupported', 'failed']).optional();

/** R10 governance: conflicts, tombstones (approved deletes) and pending relationships. */
export function governanceRoutes({ app, ensureLiveInit }: RouteContext): Router {
  const router = Router();

  router.get('/api/conflicts', async (req, res) => {
    res.json({ entries: await app.governance.listConflicts(limitParam(req.query.limit)) });
  });

  /**
   * Deliberate manual resolution: the operator picks the side whose recorded values win;
   * they are restored in that system and written to the other through the normal
   * reconcile path (locks, write intents, echo hashes). The conflict is marked manual.
   */
  router.post('/api/conflicts/:id/resolve', requireRole('operator'), async (req, res) => {
    const { winner } = parseBody(resolveConflictBody, req);
    const conflict = await app.governance.getConflict(String(req.params.id));
    if (!conflict?.linkId) return res.status(404).json({ error: 'conflict_not_found' });
    await ensureLiveInit();
    try {
      await app.reconciler.resolveConflictManually(conflict, winner);
    } catch (err) {
      return res.status(409).json({
        error: 'conflict_not_resolvable',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    await app.governance.resolveConflict(conflict.id, res.locals.auth?.actorId, winner);
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'conflict.resolved_manually',
      resourceType: 'conflict',
      resourceId: conflict.id,
      detail: { winner, type: conflict.type, linkId: conflict.linkId },
    });
    res.json(await app.governance.getConflict(conflict.id));
  });

  router.get('/api/tombstones', async (req, res) => {
    res.json({ entries: await app.governance.listTombstones(limitParam(req.query.limit)) });
  });

  router.post('/api/tombstones/:linkId/restore', requireRole('admin'), async (req, res) => {
    const linkId = String(req.params.linkId);
    if (!(await app.reconciler.restoreDeleted(linkId, res.locals.auth?.actorId))) {
      return res.status(404).json({ error: 'no_active_tombstone' });
    }
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'deletion.restored',
      resourceType: 'record_link',
      resourceId: linkId,
      detail: {},
    });
    res.json({ ok: true });
  });

  router.get('/api/associations/pending', async (req, res) => {
    const status = pendingStatus.safeParse(typeof req.query.status === 'string' ? req.query.status : undefined);
    if (!status.success) return res.status(400).json({ error: 'bad_status' });
    res.json({ entries: await app.associations.listPending(limitParam(req.query.limit), status.data) });
  });

  return router;
}
