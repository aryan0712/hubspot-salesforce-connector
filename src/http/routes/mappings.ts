import { Router } from 'express';
import { requireRole } from '../../security/access.js';
import type { CanonicalType, SystemId } from '../../core/types.js';
import { isAllowedNaturalKeyField } from '../../core/idMap.js';
import { isSystem, type RouteContext } from '../context.js';

/** Mapping Studio: field/value/object mappings, native-object re-pointing, and schema/preflight. */
export function mappingRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app, isType, ensureLiveInit, pauseSyncIfLive } = ctx;

  router.get('/api/mappings/:system/:type', (req, res) => {
    const system = req.params.system as SystemId;
    const type = req.params.type as CanonicalType;
    if (!isSystem(system) || !isType(type)) {
      return res.status(400).json({ error: 'bad_mapping_target' });
    }
    res.json({ system, type, rules: app.mappingStore.get(system, type) });
  });

  router.put('/api/mappings/:system/:type', requireRole('operator'), async (req, res) => {
    const system = req.params.system as SystemId;
    const type = req.params.type as CanonicalType;
    if (!isSystem(system) || !isType(type) || !Array.isArray(req.body?.rules)) {
      return res.status(400).json({ error: 'invalid_mapping' });
    }
    try {
      await app.mappingStore.set(system, type, req.body.rules);
      await app.operations?.recordAudit({
        actorId: res.locals.auth?.actorId,
        action: 'mapping.updated',
        resourceType: 'field_mapping',
        resourceId: `${system}:${type}`,
        // Field ownership (sourceOfTruth) and owner-id mappings are audited explicitly.
        detail: {
          ruleCount: req.body.rules.length,
          fieldOwners: (req.body.rules as { canonical?: string; sourceOfTruth?: string }[])
            .filter((rule) => rule.sourceOfTruth)
            .map((rule) => `${rule.canonical}:${rule.sourceOfTruth}`),
          ownerMapped: (req.body.rules as { canonical?: string }[]).some((rule) => rule.canonical === 'ownerId'),
        },
      });
      const syncPaused = await pauseSyncIfLive(
        type,
        res.locals.auth?.actorId,
        `field mapping changed (${system})`,
      );
      res.json({ ok: true, rules: app.mappingStore.get(system, type), syncPaused });
    } catch (err) {
      res.status(400).json({ error: 'invalid_mapping', detail: String(err) });
    }
  });

  router.get('/api/schema/:system/:type', async (req, res) => {
    const system = req.params.system as SystemId;
    const type = req.params.type as CanonicalType;
    if (!isSystem(system) || !isType(type)) {
      return res.status(400).json({ error: 'bad_schema_target' });
    }
    await ensureLiveInit();
    res.json({ system, type, fields: await app.connectors[system].describe(type) });
  });

  router.get('/api/value-mappings/:type/:field', (req, res) => {
    const type = req.params.type as CanonicalType;
    if (!isType(type)) return res.status(400).json({ error: 'bad_object_type' });
    res.json({
      entries: app.valueMappings?.list(type, String(req.params.field)) ?? [],
    });
  });

  // The object registry: which canonical objects exist and their native name per CRM.
  // Selecting a not-yet-registered row in the Step 2 catalog calls POST here first.
  router.get('/api/object-mappings', (_req, res) => {
    res.json({ entries: app.objectMappings?.list() ?? [] });
  });

  router.post('/api/object-mappings', requireRole('operator'), async (req, res) => {
    if (!app.objectMappings) return res.status(503).json({ error: 'postgres_required' });
    const label = String(req.body?.label ?? '').trim();
    const salesforceObject = String(req.body?.salesforceObject ?? '').trim();
    const hubspotObject = String(req.body?.hubspotObject ?? '').trim();
    if (!label || label.length > 120 || (!salesforceObject && !hubspotObject)) {
      return res.status(400).json({ error: 'invalid_object_mapping' });
    }
    const canonicalObject = app.config.slugifyCanonicalObject(label);
    const registration = await app.objectMappings.create({
      canonicalObject,
      label,
      salesforceObject: salesforceObject || undefined,
      hubspotObject: hubspotObject || undefined,
    });
    const config = app.syncConfig.get();
    if (!config.objects[canonicalObject]) {
      // Registering an object (used by Migration too) no longer implies Sync enrollment --
      // enrolledForSync only becomes true once the dedicated Sync setup wizard finishes for
      // this object (PATCH /api/sync/settings), which is also what sets direction/enabled.
      await app.syncConfig.update({
        ...config,
        objects: {
          ...config.objects,
          [canonicalObject]: { enabled: false, direction: 'bidirectional', enrolledForSync: false },
        },
        polling: {
          ...config.polling,
          [canonicalObject]: config.polling[canonicalObject] ?? { enabled: false, intervalMinutes: 30 },
        },
      });
    }
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'object_mapping.created',
      resourceType: 'object_mapping',
      resourceId: canonicalObject,
      detail: { label, salesforceObject, hubspotObject },
    });
    res.status(201).json(registration);
  });

  router.get('/api/object-mappings/:type', (req, res) => {
    const type = req.params.type as CanonicalType;
    if (!isType(type)) return res.status(400).json({ error: 'bad_object_type' });
    res.json({ type, naturalKeyFields: app.objectMappings?.getNaturalKeyFields(type) ?? [] });
  });

  router.put('/api/object-mappings/:type', requireRole('operator'), async (req, res) => {
    const type = req.params.type as CanonicalType;
    const fields = req.body?.naturalKeyFields as string[];
    if (!app.objectMappings) return res.status(503).json({ error: 'postgres_required' });
    if (
      !isType(type) ||
      !Array.isArray(fields) ||
      fields.length < 1 ||
      fields.length > 3 ||
      fields.some((field) => typeof field !== 'string' || !field.trim())
    ) {
      return res.status(400).json({ error: 'invalid_natural_key' });
    }
    const normalizedFields = [...new Set(fields.map((field) => field.trim()))];
    const [salesforceRules, hubspotRules] = await Promise.all([
      Promise.resolve(app.mappingStore.get('salesforce', type)),
      Promise.resolve(app.mappingStore.get('hubspot', type)),
    ]);
    const salesforceFields = new Set(salesforceRules.map((rule) => rule.canonical));
    const hubspotFields = new Set(hubspotRules.map((rule) => rule.canonical));
    const invalid = normalizedFields.find((field) =>
      !salesforceFields.has(field) ||
      !hubspotFields.has(field) ||
      !isAllowedNaturalKeyField(type, field));
    if (invalid) {
      return res.status(400).json({
        error: 'unsafe_natural_key',
        message: `${invalid} is not a stable field mapped in both CRMs`,
      });
    }
    await app.objectMappings.setNaturalKeyFields(type, normalizedFields);
    const syncPaused = await pauseSyncIfLive(type, res.locals.auth?.actorId, 'matching (natural key) changed');
    res.json({ ok: true, type, naturalKeyFields: app.objectMappings.getNaturalKeyFields(type), syncPaused });
  });

  // Re-points an already-enrolled sync object at a different native object on either side --
  // e.g. fixing "Account -> Contact" to "Account -> Company" -- without forcing the operator
  // to delete and recreate the whole registration (which would also throw away polling config
  // and run history). Field mappings and the natural key describe the OLD native object's
  // fields, so they're cleared rather than carried forward stale; the operator re-maps fields
  // right after via the normal Map Fields step.
  router.put('/api/object-mappings/:type/native-objects', requireRole('operator'), async (req, res) => {
    const type = req.params.type as CanonicalType;
    if (!app.objectMappings) return res.status(503).json({ error: 'postgres_required' });
    if (!isType(type)) {
      return res.status(400).json({ error: 'bad_object_type' });
    }
    const salesforceObject = String(req.body?.salesforceObject ?? '').trim();
    const hubspotObject = String(req.body?.hubspotObject ?? '').trim();
    if (!salesforceObject || !hubspotObject) {
      return res.status(400).json({ error: 'invalid_native_objects' });
    }
    const registration = await app.objectMappings.setNativeObjects(type, { salesforceObject, hubspotObject });
    await Promise.all([
      app.mappingStore.set('salesforce', type, []),
      app.mappingStore.set('hubspot', type, []),
    ]);
    const syncPaused = await pauseSyncIfLive(type, res.locals.auth?.actorId, 'object pairing changed');
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'object_mapping.native_objects_changed',
      resourceType: 'object_mapping',
      resourceId: type,
      detail: { salesforceObject, hubspotObject },
    });
    res.json({ ok: true, registration, syncPaused });
  });

  router.put('/api/value-mappings/:type/:field', requireRole('operator'), async (req, res) => {
    const type = req.params.type as CanonicalType;
    if (!app.valueMappings) return res.status(503).json({ error: 'postgres_required' });
    if (!isType(type) || !Array.isArray(req.body?.entries)) {
      return res.status(400).json({ error: 'invalid_value_mapping' });
    }
    await app.valueMappings.replace(type, String(req.params.field), req.body.entries);
    const syncPaused = await pauseSyncIfLive(
      type,
      res.locals.auth?.actorId,
      `value mapping changed (${req.params.field})`,
    );
    res.json({ ok: true, entries: app.valueMappings.list(type, String(req.params.field)), syncPaused });
  });

  router.post('/api/preflight', requireRole('operator'), async (req, res) => {
    const from = req.body?.from as SystemId;
    const types = req.body?.types as CanonicalType[];
    if (!isSystem(from) || !Array.isArray(types) || !types.every(isType)) {
      return res.status(400).json({ error: 'invalid_preflight_scope' });
    }
    await ensureLiveInit();
    const checks = await Promise.all(types.map((type) => app.preflight.run(from, type)));
    res.status(checks.every((check) => check.ok) ? 200 : 409).json({ checks });
  });

  return router;
}
