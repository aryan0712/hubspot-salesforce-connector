import { Router } from 'express';
import { requireRole } from '../../security/access.js';
import type { CanonicalType, SystemId } from '../../core/types.js';
import { idempotencyKey } from '../helpers.js';
import { isSystem, type RouteContext } from '../context.js';

/**
 * Standalone migration API. Without `confirm` it only previews (the default). A confirmed
 * call must name a completed preview (`previewRunId`) and executes exactly that frozen
 * preview through the same approved-plan service as the workspace -- at most once.
 */
export function migrateRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app, isType, ensureLiveInit } = ctx;

  router.post('/api/migrate', requireRole('operator'), async (req, res) => {
    const [salesforceAccount, hubspotAccount] = await Promise.all([
      app.connectors.salesforce.accountIdentity(),
      app.connectors.hubspot.accountIdentity(),
    ]);
    if (!salesforceAccount || !hubspotAccount) {
      return res.status(400).json({ error: 'connect both CRMs first' });
    }
    await ensureLiveInit();
    if (req.body?.confirm === true) {
      const previewRunId = String(req.body?.previewRunId ?? '');
      if (!previewRunId) {
        return res.status(409).json({
          error: 'approved_preview_required',
          detail: 'Preview without confirm, review it, then confirm with its previewRunId.',
        });
      }
      const outcome = await app.migrations.executeDirect(previewRunId, {
        actorId: res.locals.auth?.actorId,
        idempotencyKey: idempotencyKey(req),
      });
      if (!outcome.replayed) {
        await app.operations?.recordAudit({
          actorId: res.locals.auth?.actorId,
          action: 'migration.executed',
          resourceType: 'migration_run',
          resourceId: previewRunId,
          detail: { executionId: outcome.execution.id, runId: outcome.execution.executionRunId },
        });
      }
      return res.status(outcome.replayed ? 200 : 202).json({
        execution: outcome.execution,
        progress: outcome.counts,
        replayed: outcome.replayed,
      });
    }
    const from = (req.body?.from as SystemId) ?? 'salesforce';
    const types = (req.body?.types as CanonicalType[]) ?? ['contact'];
    const limit = req.body?.limit === undefined ? undefined : Number(req.body.limit);
    if (
      !isSystem(from) ||
      !Array.isArray(types) ||
      !types.length ||
      !types.every(isType) ||
      (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100_000))
    ) {
      return res.status(400).json({ error: 'invalid_migration_scope' });
    }
    const report = await app.migrations.preview({
      from,
      types,
      limitPerType: limit,
      createdBy: res.locals.auth?.actorId,
    });
    res.json(report);
  });

  return router;
}
