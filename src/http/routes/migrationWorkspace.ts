import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { requireRole } from '../../security/access.js';
import { PublicError } from '../../core/publicError.js';
import type { CanonicalType, CRMObjectDescriptor, SystemId } from '../../core/types.js';
import { idempotencyKey, migrationPlanInput, migrationRecordLabel, schemaHashesFromChecks } from '../helpers.js';
import { isSystem, limitParam, type RouteContext } from '../context.js';

/**
 * The guided migration workspace: object catalog discovery, migration plan CRUD, schema
 * preflight (with an optional Copilot explanation), one-record/batch test previews and
 * their execution, the full preview, and the durable-execution kickoff.
 */
export function migrationWorkspaceRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app, isType, ensureLiveInit, migrationCopilot } = ctx;

  router.get('/api/object-catalog', async (req, res) => {
    const from = String(req.query.from ?? 'salesforce');
    if (!isSystem(from)) return res.status(400).json({ error: 'invalid_source_system' });
    await ensureLiveInit();
    const to: SystemId = from === 'salesforce' ? 'hubspot' : 'salesforce';
    const [sources, targets] = await Promise.all([
      app.connectors[from].listObjects(),
      app.connectors[to].listObjects(),
    ]);
    const normalized = (value: string): string =>
      value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
    const buildRow = async (
      source: CRMObjectDescriptor,
      target: CRMObjectDescriptor | undefined,
      canonicalType: CanonicalType | undefined,
    ) => {
      const registered = Boolean(canonicalType);
      const sourceRules = registered ? await app.mappingStore.get(from, canonicalType!) : [];
      const targetRules = registered ? await app.mappingStore.get(to, canonicalType!) : [];
      const mapped = new Set(sourceRules.map((rule) => rule.canonical));
      const mappedFields = targetRules.filter((rule) => mapped.has(rule.canonical)).length;
      return {
        source,
        target,
        supported: Boolean(target),
        registered,
        canonicalType,
        mappedFields,
        totalMappedFields: Math.max(sourceRules.length, targetRules.length),
        reason: target ? undefined : 'No matching object found in the other CRM',
      };
    };
    // A native object can legitimately back more than one canonical object at once (e.g.
    // Salesforce Account -> both "company" and a separately-registered "person_account"
    // routed to HubSpot contacts, see core/objectRegistry.ts). source.canonicalType (from
    // listObjects()) only ever names ONE of those -- picking whichever registration happens
    // to be first, arbitrarily -- so it's never used here; canonicalObjectsFor() returns every
    // registration for this native object, and each one becomes its own row, paired with its
    // OWN registered target (looked up by native id, not by the same ambiguous canonicalType
    // matching) so an operator can see and edit either pairing independently.
    const rows = await Promise.all(sources.flatMap((source) => {
      const registrations = app.config.canonicalObjectsFor(from, source.id);
      if (!registrations.length) {
        const target = targets.find((candidate) =>
          normalized(candidate.id) === normalized(source.id) ||
          normalized(candidate.label) === normalized(source.label));
        return [buildRow(source, target, undefined)];
      }
      return registrations.map((registration) => {
        const targetNativeId = to === 'salesforce' ? registration.salesforceObject : registration.hubspotObject;
        const target = targets.find((candidate) => candidate.id === targetNativeId);
        return buildRow(source, target, registration.canonicalObject);
      });
    }));
    res.json({ from, to, rows, targets, sourceCount: sources.length, targetCount: targets.length });
  });

  router.get('/api/object-catalog/:system/:objectId', async (req, res) => {
    const system = String(req.params.system);
    const objectId = String(req.params.objectId);
    if (!isSystem(system) || !objectId || objectId.length > 160) {
      return res.status(400).json({ error: 'invalid_object_reference' });
    }
    await ensureLiveInit();
    res.json(await app.connectors[system].describeObject(objectId));
  });

  router.get('/api/migration-plans', async (req, res) => {
    res.json({
      entries: await app.migrationPlans.list(limitParam(req.query.limit, 50, 200)),
    });
  });

  router.post('/api/migration-plans', requireRole('operator'), async (req, res) => {
    const input = migrationPlanInput(req.body, isType, res.locals.auth?.actorId);
    if (!input) return res.status(400).json({ error: 'invalid_migration_plan' });
    const plan = await app.migrationPlans.create(input);
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'migration_plan.created',
      resourceType: 'migration_plan',
      resourceId: plan.id,
      detail: { name: plan.name, source: plan.source, types: plan.types },
    });
    res.status(201).json(plan);
  });

  router.get('/api/migration-plans/:id', async (req, res) => {
    const plan = await app.migrationPlans.get(String(req.params.id));
    if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
    res.json(plan);
  });

  router.patch('/api/migration-plans/:id', requireRole('operator'), async (req, res) => {
    const input = migrationPlanInput(req.body, isType, res.locals.auth?.actorId);
    if (!input) return res.status(400).json({ error: 'invalid_migration_plan' });
    const plan = await app.migrationPlans.update(String(req.params.id), input);
    if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'migration_plan.updated',
      resourceType: 'migration_plan',
      resourceId: plan.id,
      detail: { revision: plan.revision, source: plan.source, types: plan.types },
    });
    res.json(plan);
  });

  router.delete('/api/migration-plans/:id', requireRole('operator'), async (req, res) => {
    const id = String(req.params.id);
    const existing = await app.migrationPlans.get(id);
    if (!existing) return res.status(404).json({ error: 'migration_plan_not_found' });
    const deleted = await app.migrationPlans.delete(id);
    if (!deleted) return res.status(404).json({ error: 'migration_plan_not_found' });
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'migration_plan.deleted',
      resourceType: 'migration_plan',
      resourceId: id,
      detail: { name: existing.name, source: existing.source, types: existing.types },
    });
    res.json({ ok: true });
  });

  router.post('/api/migration-plans/:id/preflight', requireRole('operator'), async (req, res) => {
    const plan = await app.migrationPlans.get(String(req.params.id));
    if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
    await ensureLiveInit();
    const checks = await Promise.all(plan.types.map((type) => app.preflight.run(plan.source, type)));
    const ok = checks.every((check) => check.ok);
    const schemaHashes = schemaHashesFromChecks(checks);
    if (ok) await app.migrationPlans.saveValidation(plan.id, plan.revision, schemaHashes);
    // A failed preflight is a completed validation result, not a failed HTTP
    // request. Returning it normally lets the workspace render every blocker
    // and warning instead of reducing the response to a generic "Conflict".
    res.json({ ok, revision: plan.revision, checks, schemaHashes });
  });

  router.post(
    '/api/migration-plans/:id/copilot/preflight',
    requireRole('operator'),
    async (req, res) => {
      const plan = await app.migrationPlans.get(String(req.params.id));
      if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
      await ensureLiveInit();
      const target: SystemId = plan.source === 'salesforce' ? 'hubspot' : 'salesforce';
      const checks = await Promise.all(
        plan.types.map((type) => app.preflight.run(plan.source, type)),
      );
      const mappings = await Promise.all(
        plan.types.flatMap((type) => [
          Promise.resolve(app.mappingStore.get(plan.source, type)).then((rules) => ({
            system: plan.source,
            type,
            rules,
          })),
          Promise.resolve(app.mappingStore.get(target, type)).then((rules) => ({
            system: target,
            type,
            rules,
          })),
        ]),
      );
      const analysis = await migrationCopilot.analyzePreflight(
        {
          source: plan.source,
          target,
          revision: plan.revision,
          checks,
          mappings,
        },
        crypto
          .createHash('sha256')
          .update(String(res.locals.auth?.actorId ?? 'anonymous'))
          .digest('hex'),
      );
      await app.operations?.recordAudit({
        actorId: res.locals.auth?.actorId,
        action: 'copilot.preflight_analyzed',
        resourceType: 'migration_plan',
        resourceId: plan.id,
        detail: {
          revision: plan.revision,
          model: analysis.model,
          findings: analysis.findings.length,
          readiness: analysis.readiness,
        },
      });
      res.json(analysis);
    },
  );

  router.get('/api/migration-plans/:id/test-records', async (req, res) => {
    const plan = await app.migrationPlans.get(String(req.params.id));
    if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
    const type = String(req.query.type ?? '');
    if (!isType(type) || !plan.types.includes(type)) {
      return res.status(400).json({ error: 'invalid_test_record_type' });
    }
    await ensureLiveInit();
    const listPage = await app.connectors[plan.source].list(type);
    res.json({
      type,
      source: plan.source,
      entries: listPage.records.slice(0, 50).map((record) => ({
        sourceId: record.meta.sourceId,
        label: migrationRecordLabel(record),
        modifiedAt: record.meta.modifiedAt,
      })),
      truncated: Boolean(listPage.nextCursor || listPage.records.length > 50),
    });
  });

  /**
   * Freezes a test preview of explicitly selected source records (one record, or the first
   * `count` records for a batch) -- the only thing a test execution may write. Preflight
   * covers every object in the plan, and the preview is bound to schema, mapping, conflict
   * policy and connected accounts exactly like a full preview.
   */
  async function prepareTestPreview(
    planId: string,
    type: string,
    sourceIds: string[],
    marker: string,
    actorId: string | undefined,
  ) {
    const plan = await app.migrationPlans.get(planId);
    if (!plan) throw new PublicError('migration_plan_not_found', 'Migration plan not found', 404);
    await ensureLiveInit();
    const report = await app.migrations.previewRecords({
      from: plan.source,
      type,
      sourceIds,
      scopeTypes: plan.types,
      createdBy: actorId,
      runOptions: { planId: plan.id, planRevision: plan.revision },
    });
    const schemaHashes = schemaHashesFromChecks(report.checks);
    if (
      !(await app.migrationPlans.saveValidation(plan.id, plan.revision, schemaHashes)) ||
      !(await app.migrationPlans.saveCanaryPreview(plan.id, plan.revision, type, marker, report.runId))
    ) {
      throw new PublicError('migration_plan_changed', 'The plan changed while the test was prepared', 409);
    }
    await app.operations?.recordAudit({
      actorId,
      action: 'migration_plan.test_prepared',
      resourceType: 'migration_plan',
      resourceId: plan.id,
      detail: {
        revision: plan.revision,
        previewRunId: report.runId,
        objectType: type,
        records: sourceIds.length,
        actions: report.perType[type]?.actions ?? {},
      },
    });
    return { plan, report };
  }

  router.post(
    '/api/migration-plans/:id/test-record/preview',
    requireRole('operator'),
    async (req, res) => {
      const plan = await app.migrationPlans.get(String(req.params.id));
      if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
      const type = String(req.body?.type ?? '');
      const sourceId = String(req.body?.sourceId ?? '').trim();
      if (!isType(type) || !plan.types.includes(type) || !sourceId || sourceId.length > 240) {
        return res.status(400).json({ error: 'invalid_test_record' });
      }
      const { report } = await prepareTestPreview(plan.id, type, [sourceId], sourceId, res.locals.auth?.actorId);
      res.json({ planId: plan.id, revision: plan.revision, ...report });
    },
  );

  /**
   * Batch test preview: the first `count` source records of one object, frozen for review.
   * Executing it writes exactly those reviewed records -- never an unreviewed batch.
   */
  router.post('/api/migration-plans/:id/test-batch/preview', requireRole('operator'), async (req, res) => {
    const plan = await app.migrationPlans.get(String(req.params.id));
    if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
    const type = String(req.body?.type ?? '');
    const count = Number(req.body?.count);
    if (!isType(type) || !plan.types.includes(type)) {
      return res.status(400).json({ error: 'invalid_test_record_type' });
    }
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      return res.status(400).json({ error: 'invalid_batch_count' });
    }
    await ensureLiveInit();
    const sourceIds: string[] = [];
    let cursor: string | undefined;
    do {
      const listPage = await app.connectors[plan.source].list(type, cursor);
      for (const record of listPage.records) {
        if (sourceIds.length >= count) break;
        sourceIds.push(record.meta.sourceId);
      }
      cursor = sourceIds.length >= count ? undefined : listPage.nextCursor;
    } while (cursor);
    if (!sourceIds.length) return res.status(409).json({ error: 'no_source_records' });
    const { report } = await prepareTestPreview(
      plan.id,
      type,
      sourceIds,
      `batch:${sourceIds.length}`,
      res.locals.auth?.actorId,
    );
    res.json({ planId: plan.id, revision: plan.revision, ...report });
  });

  /** Executes the plan's frozen test preview (single record or batch) and reads it back. */
  async function executeTest(req: Request, res: Response): Promise<void> {
    if (req.body?.confirm !== true) {
      res.status(400).json({ error: 'explicit_confirmation_required' });
      return;
    }
    const plan = await app.migrationPlans.get(String(req.params.id));
    if (!plan) {
      res.status(404).json({ error: 'migration_plan_not_found' });
      return;
    }
    const previewRunId = String(req.body?.previewRunId ?? '');
    if (
      !plan.canary ||
      !previewRunId ||
      plan.canary.previewRunId !== previewRunId ||
      plan.canary.previewRevision !== plan.revision
    ) {
      res.status(409).json({ error: 'fresh_test_record_preview_required' });
      return;
    }
    await ensureLiveInit();
    const outcome = await app.migrations.executeCanary(plan.id, previewRunId, {
      actorId: res.locals.auth?.actorId,
      idempotencyKey: idempotencyKey(req),
    });
    const verification = outcome.verification;
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'migration_plan.test_executed',
      resourceType: 'migration_plan',
      resourceId: plan.id,
      detail: {
        revision: plan.revision,
        previewRunId,
        executionId: outcome.execution.id,
        executionRunId: outcome.execution.executionRunId,
        status: outcome.execution.status,
        passed: verification?.passed ?? false,
        reasons: verification?.reasons ?? [],
        replayed: outcome.replayed,
      },
    });
    res.json({
      ...(outcome.report ?? {}),
      execution: outcome.execution,
      replayed: outcome.replayed,
      verification: verification
        ? { ...verification, verified: verification.passed }
        : { verified: false, reasons: ['this test already ran; prepare a new test preview'] },
    });
  }
  router.post('/api/migration-plans/:id/test-record/execute', requireRole('operator'), executeTest);
  router.post('/api/migration-plans/:id/test-batch/execute', requireRole('operator'), executeTest);

  router.post('/api/migration-plans/:id/preview', requireRole('operator'), async (req, res) => {
    const plan = await app.migrationPlans.get(String(req.params.id));
    if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
    await ensureLiveInit();
    const report = await app.migrations.preview({
      from: plan.source,
      types: plan.types,
      limitPerType: plan.limitPerType,
      createdBy: res.locals.auth?.actorId,
      runOptions: { planId: plan.id, planRevision: plan.revision },
    });
    const schemaHashes = schemaHashesFromChecks(report.checks);
    if (
      !(await app.migrationPlans.saveValidation(plan.id, plan.revision, schemaHashes)) ||
      !(await app.migrationPlans.savePreview(plan.id, plan.revision, report.runId))
    ) {
      return res.status(409).json({ error: 'migration_plan_changed' });
    }
    res.json({ planId: plan.id, revision: plan.revision, ...report });
  });

  router.post('/api/migration-plans/:id/execute', requireRole('operator'), async (req, res) => {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'explicit_confirmation_required' });
    }
    const planId = String(req.params.id);
    await ensureLiveInit();
    const outcome = await app.migrations.executePlan(planId, {
      actorId: res.locals.auth?.actorId,
      idempotencyKey: idempotencyKey(req),
    });
    if (!outcome.replayed) {
      await app.operations?.recordAudit({
        actorId: res.locals.auth?.actorId,
        action: 'migration_plan.executed',
        resourceType: 'migration_plan',
        resourceId: planId,
        detail: {
          revision: outcome.execution.planRevision,
          executionId: outcome.execution.id,
          previewRunId: outcome.execution.previewRunId,
          runId: outcome.execution.executionRunId,
          approval: outcome.execution.approval,
          records: outcome.execution.quotaCharged,
        },
      });
    }
    // Durable job (R08): the worker executes it; poll GET /api/executions/:id for progress.
    res.status(outcome.replayed ? 200 : 202).json({
      execution: outcome.execution,
      progress: outcome.counts,
      replayed: outcome.replayed,
    });
  });

  return router;
}
