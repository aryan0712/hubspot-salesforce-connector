import { Router } from 'express';
import { env } from '../../config/env.js';
import { connections } from '../../core/connectionStore.js';
import { settings } from '../../core/settingsStore.js';
import { requireRole } from '../../security/access.js';
import type { CanonicalType, SystemId } from '../../core/types.js';
import type { QueryCondition } from '../../core/connector.js';
import { friendlyErrorMessage } from '../../core/vendorError.js';
import {
  isValidCronExpression,
  MAX_POLLING_INTERVAL_MINUTES,
  MIN_POLLING_INTERVAL_MINUTES,
  nextCronOccurrences,
} from '../../core/syncConfig.js';
import { decodeCursor, page } from '../../core/pagination.js';
import { isValidConditionsBySystem, isValidRawConditionBySystem } from '../helpers.js';
import { isSystem, type RouteContext } from '../context.js';

/** Live sync: job queue, settings, on-demand polling/testing, and job actions. */
export function syncRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app, isType, ensureLiveInit } = ctx;

  router.get('/api/sync/jobs', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    const statuses = ['queued', 'processing', 'retry', 'completed', 'dead_letter', 'manual_review', 'dismissed'];
    if (rawStatus && !statuses.includes(rawStatus)) {
      return res.status(400).json({ error: 'bad_job_status' });
    }
    const status = rawStatus as never;
    // R13: keyset pagination -- pass back `nextCursor` as ?cursor= for the next page.
    res.json(page(await app.sync.list(limit, status, decodeCursor(req.query.cursor)), limit));
  });

  router.get('/api/sync/stats', async (_req, res) => res.json(await app.sync.stats()));

  router.get('/api/sync/settings', async (_req, res) => {
    const hubspotSettings = await settings.get('hubspot');
    res.json({
      ...app.syncConfig.get(),
      pollingStatus: app.poller.lastRuns(),
      pollHistory: app.poller.histories(),
      webhooks: {
        salesforce: {
          connected: Boolean(await connections.get('salesforce')),
          signingConfigured: Boolean(env.SF_WEBHOOK_SECRET || env.ALLOW_UNSIGNED_WEBHOOKS),
        },
        hubspot: {
          connected: Boolean(await connections.get('hubspot')),
          signingConfigured: Boolean(
            hubspotSettings?.clientSecret ||
              env.HUBSPOT_APP_SECRET ||
              env.ALLOW_UNSIGNED_WEBHOOKS,
          ),
        },
      },
    });
  });

  router.patch('/api/sync/settings', requireRole('admin'), async (req, res) => {
    const conflictStrategy = String(req.body?.conflictStrategy ?? '');
    const sourceOfTruth = String(req.body?.sourceOfTruth ?? '');
    const objectsInput = req.body?.objects;
    const pollingInput = req.body?.polling;
    const directions = [
      'bidirectional',
      'salesforce_to_hubspot',
      'hubspot_to_salesforce',
    ];
    // Every canonical object is registered dynamically (core/objectRegistry.ts) -- there is
    // no fixed object list to validate against, so any key here must be a currently
    // registered type, whatever it is.
    const objectsValid =
      objectsInput === undefined ||
      (typeof objectsInput === 'object' &&
        objectsInput !== null &&
        Object.entries(objectsInput as Record<string, unknown>).every(([type, value]) => {
          const object = value as {
            enabled?: unknown;
            direction?: unknown;
            enrolledForSync?: unknown;
            conditions?: unknown;
            rawCondition?: unknown;
            conflictStrategy?: unknown;
            sourceOfTruth?: unknown;
          } | null;
          return (
            isType(type) &&
            object &&
            typeof object.enabled === 'boolean' &&
            directions.includes(String(object.direction)) &&
            (object.enrolledForSync === undefined || typeof object.enrolledForSync === 'boolean') &&
            isValidConditionsBySystem(object.conditions) &&
            isValidRawConditionBySystem(object.rawCondition) &&
            (object.conflictStrategy === undefined ||
              object.conflictStrategy === null ||
              object.conflictStrategy === '' ||
              ['source-of-truth', 'last-write-wins', 'field-merge'].includes(String(object.conflictStrategy))) &&
            (object.sourceOfTruth === undefined ||
              object.sourceOfTruth === null ||
              object.sourceOfTruth === '' ||
              isSystem(String(object.sourceOfTruth)))
          );
        }));
    const pollingValid =
      pollingInput === undefined ||
      (typeof pollingInput === 'object' &&
        pollingInput !== null &&
        Object.entries(pollingInput as Record<string, unknown>).every(([type, value]) => {
          const polling = value as {
            enabled?: unknown;
            intervalMinutes?: unknown;
            lookbackDays?: unknown;
            cron?: unknown;
          } | null;
          return (
            isType(type) &&
            polling &&
            typeof polling.enabled === 'boolean' &&
            Number.isFinite(Number(polling.intervalMinutes)) &&
            Number(polling.intervalMinutes) >= MIN_POLLING_INTERVAL_MINUTES &&
            Number(polling.intervalMinutes) <= MAX_POLLING_INTERVAL_MINUTES &&
            (polling.lookbackDays === undefined ||
              (Number.isFinite(Number(polling.lookbackDays)) &&
                Number(polling.lookbackDays) >= 1 &&
                Number(polling.lookbackDays) <= 365)) &&
            // Empty string / null clears cron (switches the object back to simple-interval
            // mode) -- only a non-empty value has to actually parse as a cron expression.
            (polling.cron === undefined ||
              polling.cron === null ||
              polling.cron === '' ||
              (typeof polling.cron === 'string' && isValidCronExpression(polling.cron)))
          );
        }));
    if (
      !['source-of-truth', 'last-write-wins', 'field-merge'].includes(conflictStrategy) ||
      !isSystem(sourceOfTruth) ||
      !objectsValid ||
      !pollingValid
    ) {
      return res.status(400).json({ error: 'invalid_sync_settings' });
    }
    const current = app.syncConfig.get();
    const objects = { ...current.objects };
    if (objectsInput) {
      for (const [type, value] of Object.entries(objectsInput as Record<string, Partial<typeof current.objects[string]>>)) {
        const merged = { ...current.objects[type], ...value };
        if (value.conflictStrategy !== undefined) {
          if (value.conflictStrategy && ['source-of-truth', 'last-write-wins', 'field-merge'].includes(String(value.conflictStrategy))) {
            merged.conflictStrategy = value.conflictStrategy as typeof current.conflictStrategy;
          } else {
            delete merged.conflictStrategy;
          }
        }
        if (value.sourceOfTruth !== undefined) {
          if (value.sourceOfTruth && isSystem(String(value.sourceOfTruth))) {
            merged.sourceOfTruth = value.sourceOfTruth as typeof current.sourceOfTruth;
          } else {
            delete merged.sourceOfTruth;
          }
        }
        objects[type] = merged as typeof current.objects[string];
      }
    }
    const polling = { ...current.polling };
    if (pollingInput) {
      for (const [type, value] of Object.entries(
        pollingInput as Record<
          string,
          { enabled: boolean; intervalMinutes: number; lookbackDays?: number; cron?: string | null }
        >,
      )) {
        const merged: typeof polling[string] = {
          ...current.polling[type],
          enabled: Boolean(value.enabled),
          intervalMinutes: Math.round(Number(value.intervalMinutes)),
          ...(value.lookbackDays !== undefined ? { lookbackDays: Math.round(Number(value.lookbackDays)) } : {}),
        };
        if (value.cron) merged.cron = value.cron;
        else if (value.cron === '' || value.cron === null) delete merged.cron;
        polling[type] = merged;
      }
    }
    const config = await app.syncConfig.update({
      conflictStrategy: conflictStrategy as never,
      sourceOfTruth,
      objects,
      polling,
    });
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'sync.settings.updated',
      resourceType: 'sync_settings',
      detail: {
        conflictStrategy: config.conflictStrategy,
        sourceOfTruth: config.sourceOfTruth,
        enabledObjects: Object.entries(config.objects)
          .filter(([, value]) => value.enabled)
          .map(([type]) => type),
      },
    });
    res.json(config);
  });

  router.post('/api/sync/poll-now', requireRole('operator'), async (req, res) => {
    const type = req.body?.type ? String(req.body.type) : undefined;
    if (type && !isType(type)) return res.status(400).json({ error: 'bad_object_type' });
    await ensureLiveInit();
    const types = type
      ? [type]
      : Object.entries(app.syncConfig.get().objects)
          .filter(([, value]) => value.enabled)
          .map(([t]) => t);
    const summaries = await Promise.all(types.map((t) => app.poller.runOnce(t)));
    res.json(
      summaries.reduce(
        (total, s) => ({
          at: s.at,
          changed: total.changed + s.changed,
          deleted: total.deleted + s.deleted,
          errors: total.errors + s.errors,
        }),
        { at: new Date().toISOString(), changed: 0, deleted: 0, errors: 0 },
      ),
    );
  });

  /**
   * Runs a sync object's condition against the live CRM right now, without waiting for a
   * scheduled poll -- exactly the check that would have caught last session's broken raw-SOQL
   * condition immediately instead of it failing silently on every scheduled run. Used two ways
   * from the wizard: "Check syntax" (only reads ok/message/matched, works before any field is
   * mapped) and "Test this setup" (also reads `plan` once fields exist, for a full dry-run
   * preview -- no write ever happens either way, this only reuses Reconciler.preview()).
   */
  router.post('/api/sync/test', requireRole('operator'), async (req, res) => {
    const system = String(req.body?.system ?? '');
    const type = String(req.body?.type ?? '');
    if (!isSystem(system) || !isType(type)) {
      return res.status(400).json({ error: 'bad_test_target' });
    }
    if (!isValidConditionsBySystem(req.body?.conditions) || !isValidRawConditionBySystem(req.body?.rawCondition)) {
      return res.status(400).json({ error: 'invalid_condition' });
    }
    await ensureLiveInit();
    const condition: QueryCondition = {
      conditions: req.body?.conditions?.[system],
      rawCondition: req.body?.rawCondition?.[system],
    };
    try {
      const listPage = await app.connectors[system as SystemId].list(type as CanonicalType, undefined, undefined, condition);
      if (!listPage.records.length) {
        return res.json({ ok: true, matched: 0 });
      }
      const plan = await app.reconciler.preview(listPage.records[0]!);
      res.json({ ok: true, matched: listPage.records.length, plan });
    } catch (err) {
      const label = system === 'salesforce' ? 'Salesforce' : 'HubSpot';
      res.json({ ok: false, message: friendlyErrorMessage(err, label) });
    }
  });

  /** Live feedback for the cron-schedule field: validates the expression and shows what it
   * actually means before saving, using the exact same calculation SyncPoller uses to decide
   * when an object is next due -- so the preview can never disagree with the real schedule. */
  router.get('/api/sync/cron-preview', (req, res) => {
    const expr = String(req.query.expr ?? '');
    if (!expr || !isValidCronExpression(expr)) {
      return res.status(400).json({ error: 'invalid_cron_expression' });
    }
    res.json({ occurrences: nextCronOccurrences(expr, new Date(), 3).map((d) => d.toISOString()) });
  });

  router.post('/api/sync/jobs/:id/replay', requireRole('operator'), async (req, res) => {
    const id = String(req.params.id);
    // Only jobs of this workspace are visible; anything else is simply not found.
    if (!(await app.sync.store.get(id))) return res.status(404).json({ error: 'sync_job_not_found' });
    await app.sync.replay(id);
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'sync.job.replayed',
      resourceType: 'sync_event',
      resourceId: id,
      detail: {},
    });
    res.json({ ok: true });
  });

  router.post('/api/sync/jobs/:id/approve-delete', requireRole('admin'), async (req, res) => {
    const id = String(req.params.id);
    if (!(await app.sync.store.get(id))) return res.status(404).json({ error: 'sync_job_not_found' });
    await app.sync.approveDelete(id, res.locals.auth?.actorId);
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'sync.delete_approved',
      resourceType: 'sync_event',
      resourceId: id,
      detail: {},
    });
    res.json({ ok: true });
  });

  router.post('/api/sync/jobs/:id/dismiss', requireRole('operator'), async (req, res) => {
    const id = String(req.params.id);
    if (!(await app.sync.store.get(id))) return res.status(404).json({ error: 'sync_job_not_found' });
    await app.sync.dismiss(id);
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'sync.job.dismissed',
      resourceType: 'sync_event',
      resourceId: id,
      detail: {},
    });
    res.json({ ok: true });
  });

  return router;
}
