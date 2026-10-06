import express, { type Request, type Response } from 'express';
import axios from 'axios';
import crypto from 'node:crypto';
import { createPkce } from './core/pkce.js';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { createApp, type App } from './app.js';
import { MockConnector } from './connectors/mock/mockConnector.js';
import { connectionsHtml } from './dashboard/connections.js';
import { dashboardHtml } from './dashboard/html.js';
import { operationsHtml } from './dashboard/operations.js';
import { connections, type Environment } from './core/connectionStore.js';
import { settings } from './core/settingsStore.js';
import type { CanonicalRecord, CanonicalType, CRMObjectDescriptor, SystemId } from './core/types.js';
import * as sfAuth from './connectors/salesforce/auth.js';
import * as hsAuth from './connectors/hubspot/auth.js';
import { authenticate, requireRole } from './security/access.js';
import { allowedApiOrigins } from './security/originPolicy.js';
import type { MigrationPlanInput } from './engine/migrationPlanStore.js';
import { PublicError } from './core/publicError.js';
import { MigrationCopilot, validateOpenAIKey } from './ai/migrationCopilot.js';
import { keyFingerprint } from './db/postgresAiSettingsStore.js';
import { isAllowedNaturalKeyField } from './core/idMap.js';
import { canonicalObjectsFor, isRegisteredCanonicalObject, slugifyCanonicalObject } from './core/objectRegistry.js';
import { friendlyErrorMessage } from './core/vendorError.js';
import {
  isValidCronExpression,
  MAX_POLLING_INTERVAL_MINUTES,
  MIN_POLLING_INTERVAL_MINUTES,
  nextCronOccurrences,
} from './core/syncConfig.js';
import { resolveCanonicalType } from './engine/typeResolver.js';
import type { QueryCondition } from './core/connector.js';

/**
 * HTTP surface:
 *   GET  /                              - connections onboarding (entry point)
 *   GET  /demo                          - interactive demo playground (mock CRMs)
 *   GET  /auth/:system/start?env=...    - begin web OAuth (production | sandbox)
 *   GET  /auth/:system/callback         - OAuth redirect target; persists the connection
 *   GET  /api/status | /api/activity    - live connection state + activity
 *   POST /api/migrate                   - run a migration between the connected orgs
 *   POST /api/connections/:system/disconnect
 *   POST /api/demo/*                    - drive the demo playground
 *   POST /webhooks/:system              - inbound change events (raw, signed)
 */
const ENVS: Environment[] = ['production', 'sandbox'];
const AUTH = { salesforce: sfAuth, hubspot: hsAuth };

async function main(): Promise<void> {
  // The real app uses live connectors; they're initialized lazily once orgs are connected.
  const app: App = await createApp({ mock: false, initConnectors: false });
  const storedAiCredential = await app.aiSettings?.get();
  const migrationCopilot = new MigrationCopilot({
    apiKey: storedAiCredential?.apiKey ?? env.OPENAI_API_KEY,
    model: storedAiCredential?.model ?? env.OPENAI_MODEL,
  });
  let liveInited = false;
  async function ensureLiveInit(): Promise<void> {
    if (!liveInited) {
      await Promise.all(Object.values(app.connectors).map((c) => c.init()));
      liveInited = true;
    }
  }

  /**
   * A change to how an object is mapped (field rules, natural key, value translations) can
   * invalidate assumptions live sync is relying on. If that object is currently syncing --
   * real-time (webhook) or scheduled polling -- pause both so nothing syncs against the
   * edited configuration until an operator reviews it and re-enables sync from the Sync tab.
   */
  async function pauseSyncIfLive(
    type: CanonicalType,
    actorId: string | undefined,
    reason: string,
  ): Promise<boolean> {
    const config = app.syncConfig.get();
    const wasLive = config.objects[type]?.enabled || config.polling[type]?.enabled;
    if (!wasLive) return false;
    await app.syncConfig.update({
      ...config,
      objects: {
        ...config.objects,
        [type]: {
          ...(config.objects[type] ?? { direction: 'bidirectional' as const, enrolledForSync: true }),
          enabled: false,
        },
      },
      polling: {
        ...config.polling,
        [type]: { ...(config.polling[type] ?? { intervalMinutes: 30 }), enabled: false },
      },
    });
    app.activity.record({
      kind: 'info',
      message: `Sync paused for ${type}: ${reason} -- review and re-enable when ready`,
    });
    await app.operations?.recordAudit({
      actorId,
      action: 'sync.paused_by_mapping_change',
      resourceType: 'sync_settings',
      resourceId: type,
      detail: { reason },
    });
    return true;
  }

  // The demo playground is a separate, mock-backed app, created on first use.
  let demoApp: App | undefined;
  const getDemo = async (): Promise<App> => (demoApp ??= await createApp({ mock: true }));

  const server = express();
  const apiOrigins = allowedApiOrigins(env.PUBLIC_BASE_URL);
  server.disable('x-powered-by');
  server.use((req, res, next) => {
    const requestId = String(req.headers['x-request-id'] ?? crypto.randomUUID());
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
    next();
  });
  server.use((req, res, next) => {
    if (req.path.startsWith('/webhooks/')) return next();
    return express.json({ limit: '1mb' })(req, res, next);
  });
  server.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (
      origin &&
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      !apiOrigins.has(origin)
    ) {
      return res.status(403).json({ error: 'origin_not_allowed' });
    }
    next();
  });
  server.use('/api', authenticate(env.AUTH_REQUIRED, app.apiKeys));

  // ---------------- Pages ----------------
  server.get('/', (_req, res) => res.type('html').send(connectionsHtml()));
  server.get('/demo', (_req, res) => res.type('html').send(dashboardHtml()));
  server.get('/ops', (_req, res) => res.type('html').send(operationsHtml()));
  server.get('/auth/api-key', (_req, res) => {
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title>
      <style>body{font:16px system-ui;background:#08101d;color:#edf4ff;display:grid;place-items:center;height:100vh;margin:0}
      form{width:min(420px,90vw);background:#101b2d;padding:28px;border:1px solid #263752;border-radius:14px}
      input,button{width:100%;box-sizing:border-box;padding:12px;margin-top:10px;border-radius:8px;border:1px solid #263752}
      input{background:#08101d;color:#fff}button{background:#53a6ff;font-weight:700}</style></head>
      <body><form method="post"><h1>CRM Sync</h1><p>Enter an API key for this workspace.</p>
      <input name="key" type="password" autocomplete="current-password" required>
      <button>Sign in</button></form></body></html>`);
  });
  server.post(
    '/auth/api-key',
    express.urlencoded({ extended: false, limit: '10kb' }),
    async (req, res) => {
      const key = String(req.body?.key ?? '');
      const verified = app.apiKeys ? await app.apiKeys.verify(key) : undefined;
      if (!verified) return res.status(401).type('text').send('Invalid API key');
      res.setHeader(
        'set-cookie',
        `crm_api_key=${encodeURIComponent(key)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${env.PUBLIC_BASE_URL.startsWith('https://') ? '; Secure' : ''}`,
      );
      res.redirect('/ops');
    },
  );
  server.post('/auth/logout', (_req, res) => {
    res.setHeader('set-cookie', 'crm_api_key=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.redirect('/auth/api-key');
  });
  server.get('/health', async (_req, res) => {
    try {
      const database = app.db ? await app.db.health() : { ok: true, databaseTime: 'mock' };
      res.json({ ok: true, database, ts: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
  });

  // ---------------- Live status ----------------
  server.get('/api/status', async (_req, res) => {
    const [sf, hs, sfConfigured, hsConfigured, queue] = await Promise.all([
      connections.get('salesforce'),
      connections.get('hubspot'),
      sfAuth.isConfigured(),
      hsAuth.isConfigured(),
      app.sync.stats(),
    ]);
    res.json({
      mode: 'live',
      configured: { salesforce: sfConfigured, hubspot: hsConfigured },
      connections: { salesforce: connInfo(sf), hubspot: connInfo(hs) },
      ready: Boolean(sf && hs),
      copilot: { configured: migrationCopilot.configured, model: migrationCopilot.model },
      // Surfaced so the UI can state the active policy instead of hardcoding a label
      // that silently goes stale when these are reconfigured.
      policy: {
        conflictStrategy: env.CONFLICT_STRATEGY,
        sourceOfTruth: env.SOURCE_OF_TRUTH,
      },
      stats: app.activity.snapshot(),
      queue,
    });
  });
  server.get('/api/activity', (_req, res) => res.json({ entries: app.activity.recent(50) }));

  // ---------------- AI provider settings ----------------
  // The key is write-only. Responses expose configuration status and a one-way
  // fingerprint so admins can identify which credential is active.
  server.get('/api/ai/settings', requireRole('admin'), async (_req, res) => {
    const stored = await app.aiSettings?.status(env.OPENAI_MODEL);
    if (stored?.configured) {
      return res.json({ ...stored, source: 'workspace' });
    }
    res.json({
      configured: Boolean(env.OPENAI_API_KEY),
      source: env.OPENAI_API_KEY ? 'environment' : 'none',
      fingerprint: env.OPENAI_API_KEY ? keyFingerprint(env.OPENAI_API_KEY) : undefined,
      model: env.OPENAI_MODEL,
    });
  });

  server.post('/api/ai/settings', requireRole('admin'), async (req, res) => {
    if (!app.aiSettings) return res.status(503).json({ error: 'postgres_required' });
    const apiKey = String(req.body?.apiKey ?? '').trim();
    if (apiKey.length < 20 || apiKey.length > 512) {
      return res.status(400).json({
        error: 'invalid_openai_api_key',
        detail: 'Enter a complete OpenAI API key.',
      });
    }
    await validateOpenAIKey(apiKey, env.OPENAI_MODEL);
    const status = await app.aiSettings.set(
      apiKey,
      env.OPENAI_MODEL,
      res.locals.auth?.actorId,
    );
    migrationCopilot.configure({ apiKey, model: status.model });
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'ai_credentials.updated',
      resourceType: 'ai_provider',
      resourceId: 'openai',
      detail: { fingerprint: status.fingerprint, model: status.model },
    });
    res.json({ ...status, source: 'workspace' });
  });

  server.delete('/api/ai/settings', requireRole('admin'), async (_req, res) => {
    if (!app.aiSettings) return res.status(503).json({ error: 'postgres_required' });
    await app.aiSettings.delete();
    migrationCopilot.configure({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
    });
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'ai_credentials.removed',
      resourceType: 'ai_provider',
      resourceId: 'openai',
      detail: { environmentFallback: Boolean(env.OPENAI_API_KEY) },
    });
    res.json({
      ok: true,
      configured: Boolean(env.OPENAI_API_KEY),
      source: env.OPENAI_API_KEY ? 'environment' : 'none',
      fingerprint: env.OPENAI_API_KEY ? keyFingerprint(env.OPENAI_API_KEY) : undefined,
      model: env.OPENAI_MODEL,
    });
  });

  // ---------------- Sync failure alerting ----------------
  server.get('/api/notifications/settings', requireRole('admin'), async (_req, res) => {
    res.json(
      (await app.notificationSettings?.status()) ?? { enabled: false, smtpConfigured: false },
    );
  });
  server.put('/api/notifications/settings', requireRole('admin'), async (req, res) => {
    if (!app.notificationSettings) return res.status(503).json({ error: 'postgres_required' });
    const enabled = Boolean(req.body?.enabled);
    const alertEmail = String(req.body?.alertEmail ?? '').trim();
    const smtpHost = String(req.body?.smtpHost ?? '').trim();
    const smtpPort = Number(req.body?.smtpPort);
    const smtpUser = String(req.body?.smtpUser ?? '').trim();
    const smtpFrom = String(req.body?.smtpFrom ?? '').trim();
    // A blank password means "keep the existing one" (mirrors the AI credential form never
    // re-displaying a saved secret) -- only a non-empty string overwrites it.
    const smtpPasswordInput = req.body?.smtpPassword;
    const smtpPassword =
      typeof smtpPasswordInput === 'string' && smtpPasswordInput.length > 0
        ? smtpPasswordInput
        : undefined;
    if (enabled && (!alertEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail))) {
      return res.status(400).json({ error: 'invalid_alert_email' });
    }
    if (smtpHost && (!Number.isFinite(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
      return res.status(400).json({ error: 'invalid_smtp_port' });
    }
    const status = await app.notificationSettings.set(
      {
        enabled,
        alertEmail: alertEmail || undefined,
        smtpHost: smtpHost || undefined,
        smtpPort: smtpHost ? smtpPort : undefined,
        smtpUser: smtpUser || undefined,
        smtpPassword,
        smtpFrom: smtpFrom || undefined,
      },
      res.locals.auth?.actorId,
    );
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'notification_settings.updated',
      resourceType: 'notification_settings',
      detail: { enabled, alertEmail: Boolean(alertEmail), smtpConfigured: status.smtpConfigured },
    });
    res.json(status);
  });
  server.post('/api/notifications/check-now', requireRole('operator'), async (_req, res) => {
    if (!app.alertDigester) return res.status(503).json({ error: 'postgres_required' });
    res.json(await app.alertDigester.checkNow());
  });

  // ---------------- Migration workspace ----------------
  server.get('/api/object-catalog', async (req, res) => {
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
      const registrations = canonicalObjectsFor(from, source.id);
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

  server.get('/api/object-catalog/:system/:objectId', async (req, res) => {
    const system = String(req.params.system);
    const objectId = String(req.params.objectId);
    if (!isSystem(system) || !objectId || objectId.length > 160) {
      return res.status(400).json({ error: 'invalid_object_reference' });
    }
    await ensureLiveInit();
    res.json(await app.connectors[system].describeObject(objectId));
  });

  server.get('/api/migration-plans', async (req, res) => {
    res.json({
      entries: await app.migrationPlans.list(Math.min(Number(req.query.limit) || 50, 200)),
    });
  });

  server.post('/api/migration-plans', requireRole('operator'), async (req, res) => {
    const input = migrationPlanInput(req.body, res.locals.auth?.actorId);
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

  server.get('/api/migration-plans/:id', async (req, res) => {
    const plan = await app.migrationPlans.get(String(req.params.id));
    if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
    res.json(plan);
  });

  server.patch('/api/migration-plans/:id', requireRole('operator'), async (req, res) => {
    const input = migrationPlanInput(req.body, res.locals.auth?.actorId);
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

  server.post('/api/migration-plans/:id/preflight', requireRole('operator'), async (req, res) => {
    const plan = await app.migrationPlans.get(String(req.params.id));
    if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
    await ensureLiveInit();
    const checks = await Promise.all(plan.types.map((type) => app.preflight.run(plan.source, type)));
    const ok = checks.every((check) => check.ok);
    const schemaHashes = Object.fromEntries(
      checks.flatMap((check) =>
        Object.entries(check.schemas).map(([system, schema]) => [
          `${system}:${check.type}`,
          schema?.hash ?? '',
        ])),
    );
    if (ok) await app.migrationPlans.saveValidation(plan.id, plan.revision, schemaHashes);
    // A failed preflight is a completed validation result, not a failed HTTP
    // request. Returning it normally lets the workspace render every blocker
    // and warning instead of reducing the response to a generic "Conflict".
    res.json({ ok, revision: plan.revision, checks, schemaHashes });
  });

  server.post(
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

  server.get('/api/migration-plans/:id/test-records', async (req, res) => {
    const plan = await app.migrationPlans.get(String(req.params.id));
    if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
    const type = String(req.query.type ?? '');
    if (!isType(type) || !plan.types.includes(type)) {
      return res.status(400).json({ error: 'invalid_test_record_type' });
    }
    await ensureLiveInit();
    const page = await app.connectors[plan.source].list(type);
    res.json({
      type,
      source: plan.source,
      entries: page.records.slice(0, 50).map((record) => ({
        sourceId: record.meta.sourceId,
        label: migrationRecordLabel(record),
        modifiedAt: record.meta.modifiedAt,
      })),
      truncated: Boolean(page.nextCursor || page.records.length > 50),
    });
  });

  server.post(
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
      await ensureLiveInit();
      const checks = await Promise.all(
        plan.types.map((selectedType) => app.preflight.run(plan.source, selectedType)),
      );
      if (checks.some((check) => !check.ok)) {
        return res.status(409).json({ error: 'preflight_failed', checks });
      }
      const schemaHashes = schemaHashesFromChecks(checks);
      if (!(await app.migrationPlans.saveValidation(plan.id, plan.revision, schemaHashes))) {
        return res.status(409).json({ error: 'migration_plan_changed' });
      }
      const report = await app.migration.previewRecord({
        from: plan.source,
        type,
        sourceId,
        runOptions: { planId: plan.id, planRevision: plan.revision },
      });
      if (
        !(await app.migrationPlans.saveCanaryPreview(
          plan.id,
          plan.revision,
          type,
          sourceId,
          report.runId,
        ))
      ) {
        return res.status(409).json({ error: 'migration_plan_changed' });
      }
      await app.operations?.recordAudit({
        actorId: res.locals.auth?.actorId,
        action: 'migration_plan.test_record_prepared',
        resourceType: 'migration_plan',
        resourceId: plan.id,
        detail: {
          revision: plan.revision,
          previewRunId: report.runId,
          objectType: type,
          sourceId,
          action: report.plans[0]?.action,
        },
      });
      res.json({ planId: plan.id, revision: plan.revision, checks, ...report });
    },
  );

  server.post(
    '/api/migration-plans/:id/test-record/execute',
    requireRole('operator'),
    async (req, res) => {
      if (req.body?.confirm !== true) {
        return res.status(400).json({ error: 'explicit_confirmation_required' });
      }
      const plan = await app.migrationPlans.get(String(req.params.id));
      if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
      const canary = plan.canary;
      if (
        !canary ||
        canary.previewRevision !== plan.revision ||
        req.body?.previewRunId !== canary.previewRunId
      ) {
        return res.status(409).json({ error: 'fresh_test_record_preview_required' });
      }
      if (canary.verifiedAt) {
        return res.status(409).json({ error: 'test_record_already_verified' });
      }
      await ensureLiveInit();
      const checks = await Promise.all(
        plan.types.map((type) => app.preflight.run(plan.source, type)),
      );
      if (checks.some((check) => !check.ok)) {
        return res.status(409).json({ error: 'preflight_failed', checks });
      }
      if (!hashesEqual(schemaHashesFromChecks(checks), plan.schemaHashes)) {
        return res.status(409).json({ error: 'schema_changed_since_test_preview', checks });
      }
      const frozen = await app.migration.store.plans(canary.previewRunId, 2);
      if (
        frozen.length !== 1 ||
        frozen[0]?.type !== canary.type ||
        frozen[0]?.sourceId !== canary.sourceId
      ) {
        return res.status(409).json({ error: 'invalid_test_record_preview' });
      }
      if (frozen[0].action === 'ambiguous') {
        return res.status(409).json({ error: 'ambiguous_test_record', plan: frozen[0] });
      }
      const quota = await app.operations?.quota('records_migrated', 1);
      if (quota && !quota.allowed) {
        return res.status(429).json({ error: 'plan_limit_exceeded', quota });
      }
      const report = await app.migration.executePreview(canary.previewRunId);
      const target: SystemId = plan.source === 'salesforce' ? 'hubspot' : 'salesforce';
      const link = await app.idMap.bySource(plan.source, canary.sourceId);
      const targetId = link?.ids[target];
      const targetRecord = targetId
        ? await app.connectors[target].read(canary.type, targetId)
        : null;
      const verified = Boolean(targetId && targetRecord);
      if (verified) {
        await app.migrationPlans.finishCanary(plan.id, plan.revision, report.runId);
      }
      await app.operations?.recordAudit({
        actorId: res.locals.auth?.actorId,
        action: 'migration_plan.test_record_executed',
        resourceType: 'migration_plan',
        resourceId: plan.id,
        detail: {
          revision: plan.revision,
          previewRunId: canary.previewRunId,
          executionRunId: report.runId,
          objectType: canary.type,
          sourceId: canary.sourceId,
          targetSystem: target,
          targetId,
          verified,
        },
      });
      res.json({
        ...report,
        verification: {
          verified,
          target,
          targetId,
          checkedAt: new Date().toISOString(),
        },
      });
    },
  );

  /**
   * Runs a real (non-preview) migration for a small, operator-chosen number of records —
   * an alternative to the exactly-one-record canary above. Reuses MigrationEngine.run(), the
   * same execution path the full migration uses, just scoped down. A successful batch marks
   * the plan's canary verified (same field the single-record test sets), which is what
   * unlocks "Run full migration" below — either path satisfies that gate.
   */
  server.post('/api/migration-plans/:id/test-batch/execute', requireRole('operator'), async (req, res) => {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'explicit_confirmation_required' });
    }
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
    const check = await app.preflight.run(plan.source, type);
    if (!check.ok) {
      return res.status(409).json({ error: 'preflight_failed', checks: [check] });
    }
    const quota = await app.operations?.quota('records_migrated', count);
    if (quota && !quota.allowed) {
      return res.status(429).json({ error: 'plan_limit_exceeded', quota });
    }
    const report = await app.migration.run({
      from: plan.source,
      types: [type],
      limitPerType: count,
      dryRun: false,
    });
    await app.migrationPlans.saveCanaryPreview(plan.id, plan.revision, type, `batch:${report.runId}`, report.runId);
    await app.migrationPlans.finishCanary(plan.id, plan.revision, report.runId);
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'migration_plan.batch_executed',
      resourceType: 'migration_plan',
      resourceId: plan.id,
      detail: { revision: plan.revision, runId: report.runId, type, count },
    });
    res.json(report);
  });

  server.post('/api/migration-plans/:id/preview', requireRole('operator'), async (req, res) => {
    const plan = await app.migrationPlans.get(String(req.params.id));
    if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
    await ensureLiveInit();
    const checks = await Promise.all(plan.types.map((type) => app.preflight.run(plan.source, type)));
    if (checks.some((check) => !check.ok)) {
      return res.status(409).json({ error: 'preflight_failed', checks });
    }
    const schemaHashes = schemaHashesFromChecks(checks);
    await app.migrationPlans.saveValidation(plan.id, plan.revision, schemaHashes);
    const report = await app.migration.run({
      from: plan.source,
      types: plan.types,
      limitPerType: plan.limitPerType,
      dryRun: true,
    });
    await app.migrationPlans.savePreview(plan.id, plan.revision, report.runId);
    res.json({ planId: plan.id, revision: plan.revision, checks, ...report });
  });

  server.post('/api/migration-plans/:id/execute', requireRole('operator'), async (req, res) => {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'explicit_confirmation_required' });
    }
    const plan = await app.migrationPlans.get(String(req.params.id));
    if (!plan) return res.status(404).json({ error: 'migration_plan_not_found' });
    if (!plan.canary?.verifiedAt || plan.canary.previewRevision !== plan.revision) {
      return res.status(409).json({ error: 'verified_test_record_required' });
    }
    if (!plan.previewRunId || plan.previewRevision !== plan.revision) {
      return res.status(409).json({ error: 'fresh_preview_required' });
    }
    await ensureLiveInit();
    const checks = await Promise.all(plan.types.map((type) => app.preflight.run(plan.source, type)));
    if (checks.some((check) => !check.ok)) {
      return res.status(409).json({ error: 'preflight_failed', checks });
    }
    const currentHashes = schemaHashesFromChecks(checks);
    if (!hashesEqual(currentHashes, plan.schemaHashes)) {
      return res.status(409).json({ error: 'schema_changed_since_preview', checks });
    }
    const frozen = await app.migration.store.plans(plan.previewRunId, 100_000);
    const quota = await app.operations?.quota('records_migrated', frozen.length);
    if (quota && !quota.allowed) {
      return res.status(429).json({ error: 'plan_limit_exceeded', quota });
    }
    if (!(await app.migrationPlans.startExecution(plan.id, plan.revision))) {
      return res.status(409).json({ error: 'migration_plan_changed' });
    }
    try {
      const report = await app.migration.executePreview(plan.previewRunId);
      await app.migrationPlans.finishExecution(plan.id, report.runId, true);
      await app.operations?.recordAudit({
        actorId: res.locals.auth?.actorId,
        action: 'migration_plan.executed',
        resourceType: 'migration_plan',
        resourceId: plan.id,
        detail: { revision: plan.revision, runId: report.runId, records: frozen.length },
      });
      res.json(report);
    } catch (err) {
      await app.migrationPlans.finishExecution(plan.id, undefined, false);
      throw err;
    }
  });

  server.post('/api/migrate', requireRole('operator'), async (req, res) => {
    if (!(await connections.get('salesforce')) || !(await connections.get('hubspot'))) {
      return res.status(400).json({ error: 'connect both CRMs first' });
    }
    try {
      await ensureLiveInit();
      const from = (req.body?.from as SystemId) ?? 'salesforce';
      const types = (req.body?.types as CanonicalType[]) ?? ['contact'];
      if (!isSystem(from) || !types.every(isType)) {
        return res.status(400).json({ error: 'invalid_migration_scope' });
      }
      if (req.body?.confirm === true) {
        const requested = (req.body?.limit ? Number(req.body.limit) : 0) * types.length;
        const quota = await app.operations?.quota('records_migrated', requested);
        if (quota?.limit !== undefined && !req.body?.limit) {
          return res.status(400).json({
            error: 'explicit_limit_required_for_metered_plan',
            quota,
          });
        }
        if (quota && !quota.allowed) {
          return res.status(429).json({ error: 'plan_limit_exceeded', quota });
        }
        const checks = await Promise.all(types.map((type) => app.preflight.run(from, type)));
        if (checks.some((check) => !check.ok)) {
          return res.status(409).json({ error: 'preflight_failed', checks });
        }
      }
      const report = await app.migration.run({
        from,
        types,
        limitPerType: req.body?.limit ? Number(req.body.limit) : undefined,
        // Safe by default: a real write requires an explicit JSON confirmation.
        dryRun: req.body?.confirm !== true,
      });
      res.json(report);
    } catch (err) {
      logger.error({ err }, 'migration failed');
      res.status(500).json({ error: 'migration_failed', detail: String(err) });
    }
  });

  server.post('/api/connections/:system/disconnect', requireRole('admin'), async (req, res) => {
    const system = req.params.system as SystemId;
    if (!isSystem(system)) return res.status(400).json({ error: 'bad_system' });
    await connections.delete(system);
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'connection.disconnected',
      resourceType: 'connection',
      resourceId: system,
      detail: {},
    });
    liveInited = false; // force re-init on next live op
    res.json({ ok: true });
  });

  // ---------------- App credentials (entered from the browser) ----------------
  // Never returns secrets — only the client id and whether a secret is stored.
  server.get('/api/settings', async (_req, res) => {
    const [s, h] = await Promise.all([
      settings.get('salesforce'),
      settings.get('hubspot'),
    ]);
    res.json({
      salesforce: { clientId: s?.clientId ?? '', hasSecret: Boolean(s?.clientSecret) },
      hubspot: { clientId: h?.clientId ?? '', hasSecret: Boolean(h?.clientSecret) },
    });
  });

  server.post('/api/settings/:system', requireRole('admin'), async (req, res) => {
    const system = req.params.system as SystemId;
    if (system !== 'salesforce' && system !== 'hubspot') {
      return res.status(400).json({ error: 'bad system' });
    }
    const clientId = String(req.body?.clientId ?? '').trim();
    let clientSecret = String(req.body?.clientSecret ?? '');
    if (!clientId) return res.status(400).json({ error: 'clientId required' });
    // Blank secret means "keep the existing one" (so the UI can hide it after first save).
    if (!clientSecret) clientSecret = (await settings.get(system))?.clientSecret ?? '';
    if (!clientSecret) return res.status(400).json({ error: 'clientSecret required' });
    await settings.set(system, { clientId, clientSecret });
    await app.operations?.recordAudit({
      actorId: res.locals.auth?.actorId,
      action: 'credentials.updated',
      resourceType: 'oauth_app',
      resourceId: system,
      detail: { clientIdChanged: true, secretChanged: Boolean(req.body?.clientSecret) },
    });
    liveInited = false;
    res.json({ ok: true });
  });

  // ---------------- OAuth (with PKCE) ----------------
  // Maps an opaque `state` to the chosen environment + PKCE verifier for the callback.
  // Random state also protects against CSRF. Entries expire after 10 minutes.
  const oauthStates = new Map<string, { environment: Environment; codeVerifier: string }>();

  server.get('/auth/:system/start', async (req, res) => {
    const system = req.params.system as SystemId;
    const environment = (String(req.query.env) as Environment) || 'production';
    const mod = AUTH[system as keyof typeof AUTH];
    if (!mod || !ENVS.includes(environment)) return res.redirect('/?error=bad_request');
    if (!(await mod.isConfigured())) return res.redirect('/?error=not_configured');
    const state = crypto.randomBytes(16).toString('hex');
    const { verifier, challenge } = createPkce();
    oauthStates.set(state, { environment, codeVerifier: verifier });
    setTimeout(() => oauthStates.delete(state), 10 * 60_000).unref();
    res.redirect(await mod.authUrl(environment, state, challenge));
  });

  server.get('/auth/:system/callback', async (req, res) => {
    const system = req.params.system as SystemId;
    const mod = AUTH[system as keyof typeof AUTH];
    const state = String(req.query.state ?? '');
    const entry = oauthStates.get(state);
    try {
      if (!mod || !entry) throw new Error('invalid or expired OAuth state');
      oauthStates.delete(state);
      await mod.exchangeCode(entry.environment, String(req.query.code), entry.codeVerifier);
      liveInited = false;
      res.redirect(`/?connected=${system}`);
    } catch (err) {
      logger.error({ err, system }, 'oauth callback failed');
      res.redirect(`/?error=oauth_failed`);
    }
  });

  // ---------------- Demo playground (mock) ----------------
  server.get('/api/demo/status', async (_req, res) => {
    const d = await getDemo();
    res.json({
      mode: 'demo',
      connectors: {
        salesforce: { connected: true, count: (d.connectors.salesforce as MockConnector).size() },
        hubspot: { connected: true, count: (d.connectors.hubspot as MockConnector).size() },
      },
      stats: d.activity.snapshot(),
    });
  });
  server.get('/api/demo/activity', async (_req, res) => {
    const d = await getDemo();
    res.json({ entries: d.activity.recent(50) });
  });
  server.post('/api/demo/seed', async (_req, res) => {
    const d = await getDemo();
    const sf = d.connectors.salesforce as MockConnector;
    sf.seed('contact', { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@analytical.co', phone: '+1-111' });
    sf.seed('contact', { firstName: 'Alan', lastName: 'Turing', email: 'alan@enigma.uk', phone: '+44-222' });
    sf.seed('contact', { firstName: 'Grace', lastName: 'Hopper', email: 'grace@navy.mil', phone: '+1-333' });
    d.activity.record({ kind: 'info', message: 'Seeded 3 Salesforce contacts' });
    res.json({ ok: true });
  });
  server.post('/api/demo/migrate', async (_req, res) => {
    const d = await getDemo();
    res.json(await d.migration.run({ from: 'salesforce', types: ['contact'] }));
  });
  server.post('/api/demo/edit', async (_req, res) => {
    const d = await getDemo();
    const hs = d.connectors.hubspot as MockConnector;
    const recs = (await hs.list('contact')).records;
    if (recs.length === 0) return res.status(400).json({ error: 'seed & migrate first' });
    const target = recs[0]!;
    const phone = '+1-' + Math.floor(1000 + Math.random() * 9000);
    await hs.upsert(
      { canonicalId: '', type: 'contact', fields: { phone }, meta: { source: 'hubspot', sourceId: target.meta.sourceId, modifiedAt: new Date().toISOString() } },
      target.meta.sourceId,
    );
    const edited = await hs.read('contact', target.meta.sourceId);
    if (edited) await d.reconciler.reconcile(edited);
    res.json({ edited: { email: target.fields.email, phone } });
  });

  // ---------------- Mapping Studio + sync operations ----------------
  server.get('/api/mappings/:system/:type', (req, res) => {
    const system = req.params.system as SystemId;
    const type = req.params.type as CanonicalType;
    if (!isSystem(system) || !isType(type)) {
      return res.status(400).json({ error: 'bad_mapping_target' });
    }
    res.json({ system, type, rules: app.mappingStore.get(system, type) });
  });
  server.put('/api/mappings/:system/:type', requireRole('operator'), async (req, res) => {
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
        detail: { ruleCount: req.body.rules.length },
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
  server.get('/api/schema/:system/:type', async (req, res) => {
    const system = req.params.system as SystemId;
    const type = req.params.type as CanonicalType;
    if (!isSystem(system) || !isType(type)) {
      return res.status(400).json({ error: 'bad_schema_target' });
    }
    await ensureLiveInit();
    res.json({ system, type, fields: await app.connectors[system].describe(type) });
  });
  server.get('/api/value-mappings/:type/:field', (req, res) => {
    const type = req.params.type as CanonicalType;
    if (!isType(type)) return res.status(400).json({ error: 'bad_object_type' });
    res.json({
      entries: app.valueMappings?.list(type, String(req.params.field)) ?? [],
    });
  });

  // The object registry: which canonical objects exist and their native name per CRM.
  // Selecting a not-yet-registered row in the Step 2 catalog calls POST here first.
  server.get('/api/object-mappings', (_req, res) => {
    res.json({ entries: app.objectMappings?.list() ?? [] });
  });
  server.post('/api/object-mappings', requireRole('operator'), async (req, res) => {
    if (!app.objectMappings) return res.status(503).json({ error: 'postgres_required' });
    const label = String(req.body?.label ?? '').trim();
    const salesforceObject = String(req.body?.salesforceObject ?? '').trim();
    const hubspotObject = String(req.body?.hubspotObject ?? '').trim();
    if (!label || label.length > 120 || (!salesforceObject && !hubspotObject)) {
      return res.status(400).json({ error: 'invalid_object_mapping' });
    }
    const canonicalObject = slugifyCanonicalObject(label);
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
  server.get('/api/object-mappings/:type', (req, res) => {
    const type = req.params.type as CanonicalType;
    if (!isType(type)) return res.status(400).json({ error: 'bad_object_type' });
    res.json({ type, naturalKeyFields: app.objectMappings?.getNaturalKeyFields(type) ?? [] });
  });
  server.put('/api/object-mappings/:type', requireRole('operator'), async (req, res) => {
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
  server.put('/api/object-mappings/:type/native-objects', requireRole('operator'), async (req, res) => {
    const type = req.params.type as CanonicalType;
    if (!app.objectMappings) return res.status(503).json({ error: 'postgres_required' });
    if (!isType(type) || !isRegisteredCanonicalObject(type)) {
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
  server.put('/api/value-mappings/:type/:field', requireRole('operator'), async (req, res) => {
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
  server.post('/api/preflight', requireRole('operator'), async (req, res) => {
    const from = req.body?.from as SystemId;
    const types = req.body?.types as CanonicalType[];
    if (!isSystem(from) || !Array.isArray(types) || !types.every(isType)) {
      return res.status(400).json({ error: 'invalid_preflight_scope' });
    }
    await ensureLiveInit();
    const checks = await Promise.all(types.map((type) => app.preflight.run(from, type)));
    res.status(checks.every((check) => check.ok) ? 200 : 409).json({ checks });
  });
  server.get('/api/sync/jobs', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    const statuses = ['queued', 'processing', 'retry', 'completed', 'dead_letter', 'manual_review', 'dismissed'];
    if (rawStatus && !statuses.includes(rawStatus)) {
      return res.status(400).json({ error: 'bad_job_status' });
    }
    const status = rawStatus as never;
    res.json({ entries: await app.sync.list(limit, status) });
  });
  server.get('/api/sync/stats', async (_req, res) => res.json(await app.sync.stats()));
  server.get('/api/sync/settings', async (_req, res) => {
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
  server.patch('/api/sync/settings', requireRole('admin'), async (req, res) => {
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
          } | null;
          return (
            isType(type) &&
            object &&
            typeof object.enabled === 'boolean' &&
            directions.includes(String(object.direction)) &&
            (object.enrolledForSync === undefined || typeof object.enrolledForSync === 'boolean') &&
            isValidConditionsBySystem(object.conditions) &&
            isValidRawConditionBySystem(object.rawCondition)
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
      for (const [type, value] of Object.entries(objectsInput as Record<string, typeof current.objects[string]>)) {
        objects[type] = { ...current.objects[type], ...value };
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
  server.post('/api/sync/poll-now', requireRole('operator'), async (req, res) => {
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
  server.post('/api/sync/test', requireRole('operator'), async (req, res) => {
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
      const page = await app.connectors[system].list(type, undefined, undefined, condition);
      if (!page.records.length) {
        return res.json({ ok: true, matched: 0 });
      }
      const plan = await app.reconciler.preview(page.records[0]!);
      res.json({ ok: true, matched: page.records.length, plan });
    } catch (err) {
      const label = system === 'salesforce' ? 'Salesforce' : 'HubSpot';
      res.json({ ok: false, message: friendlyErrorMessage(err, label) });
    }
  });
  /** Live feedback for the cron-schedule field: validates the expression and shows what it
   * actually means before saving, using the exact same calculation SyncPoller uses to decide
   * when an object is next due -- so the preview can never disagree with the real schedule. */
  server.get('/api/sync/cron-preview', (req, res) => {
    const expr = String(req.query.expr ?? '');
    if (!expr || !isValidCronExpression(expr)) {
      return res.status(400).json({ error: 'invalid_cron_expression' });
    }
    res.json({ occurrences: nextCronOccurrences(expr, new Date(), 3).map((d) => d.toISOString()) });
  });
  server.post('/api/sync/jobs/:id/replay', requireRole('operator'), async (req, res) => {
    await app.sync.replay(String(req.params.id));
    res.json({ ok: true });
  });
  server.post('/api/sync/jobs/:id/approve-delete', requireRole('admin'), async (req, res) => {
    await app.sync.approveDelete(String(req.params.id), res.locals.auth?.actorId);
    res.json({ ok: true });
  });
  server.post('/api/sync/jobs/:id/dismiss', requireRole('operator'), async (req, res) => {
    const id = String(req.params.id);
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
  server.get('/api/migrations', async (req, res) => {
    res.json({ entries: await app.migration.store.list(Math.min(Number(req.query.limit) || 50, 200)) });
  });
  server.get('/api/migrations/:id/items', async (req, res) => {
    res.json({
      entries: await app.migration.store.plans(
        String(req.params.id),
        Math.min(Number(req.query.limit) || 500, 2000),
      ),
    });
  });
  server.get('/api/audit', async (req, res) => {
    res.json({
      entries: await app.operations?.listAudit(Math.min(Number(req.query.limit) || 100, 500)) ?? [],
    });
  });
  server.get('/api/usage', async (_req, res) => {
    res.json({ usage: await app.operations?.usage() ?? {} });
  });
  server.get('/api/workspace-overview', async (_req, res) => {
    res.json(
      (await app.operations?.workspaceOverview()) ?? {
        plan: 'local',
        status: 'active',
        limits: {},
        team: [],
      },
    );
  });
  server.get('/api/admin/api-keys', requireRole('admin'), async (_req, res) => {
    res.json({ entries: await app.apiKeys?.list() ?? [] });
  });
  server.post('/api/admin/api-keys', requireRole('admin'), async (req, res) => {
    if (!app.apiKeys) return res.status(503).json({ error: 'postgres_required' });
    const name = String(req.body?.name ?? '').trim();
    const role = req.body?.role as 'admin' | 'operator' | 'viewer';
    if (!name || !['admin', 'operator', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'name_and_valid_role_required' });
    }
    res.status(201).json(await app.apiKeys.create(name, role));
  });
  server.delete('/api/admin/api-keys/:id', requireRole('admin'), async (req, res) => {
    await app.apiKeys?.revoke(String(req.params.id));
    res.json({ ok: true });
  });

  // ---------------- Webhooks ----------------
  server.post('/webhooks/salesforce', express.raw({ type: '*/*', limit: '2mb' }), (req, res) =>
    handleWebhook('salesforce', req, res, app, ensureLiveInit),
  );
  server.post('/webhooks/hubspot', express.raw({ type: '*/*', limit: '2mb' }), (req, res) =>
    handleWebhook('hubspot', req, res, app, ensureLiveInit),
  );

  server.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
    const requestId = res.locals.requestId;
    if (err instanceof PublicError) {
      logger.warn({ err, requestId, code: err.code }, 'request requires operator action');
      if (!res.headersSent) {
        res.status(err.status).json({
          error: err.code,
          detail: err.message,
          ...err.detail,
          requestId,
        });
      }
      return;
    }
    if (axios.isAxiosError(err)) {
      const vendorMessage = friendlyErrorMessage(err);
      logger.error(
        { err, requestId, vendorStatus: err.response?.status, vendorBody: err.response?.data },
        'CRM API request failed',
      );
      if (!res.headersSent) {
        res.status(502).json({ error: 'crm_api_error', detail: vendorMessage, requestId });
      }
      return;
    }
    logger.error({ err, requestId }, 'request failed');
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal_error', requestId });
    }
  });

  app.poller.start(ensureLiveInit);
  app.alertDigester?.start();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      app.poller.stop();
      app.alertDigester?.stop();
      process.exit(0);
    });
  }

  server.listen(env.PORT, () => {
    logger.info(`crm-sync listening on http://localhost:${env.PORT}/`);
    logger.info('Open it to connect Salesforce + HubSpot (or /demo for the playground)');
  });
}

function connInfo(c: Awaited<ReturnType<typeof connections.get>>): {
  environment: string;
  accountLabel?: string;
  connectedAt: string;
} | null {
  if (!c) return null;
  return { environment: c.environment, accountLabel: c.accountLabel, connectedAt: c.connectedAt };
}

/**
 * Salesforce error responses are `[{ message, errorCode }, ...]`; HubSpot's are
 * `{ message, category }`. Pull the human-readable message out of either shape so a live
 * CRM API failure surfaces its actual cause instead of a generic internal_error.
 */
function isSystem(value: string): value is SystemId {
  return value === 'salesforce' || value === 'hubspot';
}

function isType(value: string): boolean {
  return isRegisteredCanonicalObject(value);
}

const SYNC_CONDITION_OPERATORS = ['eq', 'ne', 'gt', 'lt', 'contains', 'is_null', 'is_not_null'];
// Advanced/raw SOQL condition can't be parameterized through this REST-style query builder,
// so it's hardened with an allow-list instead: no statement separators, no comment syntax
// (either could smuggle a second statement past the WHERE fragment it's appended into), no
// DML/set-operator keywords (this fragment is only ever appended to a SELECT's WHERE clause).
const UNSAFE_RAW_CONDITION = /;|--|\/\*|\b(insert|update|delete|upsert|union|merge)\b/i;

function isValidConditionsBySystem(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value as Record<string, unknown>).every(([system, rows]) => {
    if (!isSystem(system)) return false;
    if (!Array.isArray(rows)) return false;
    return rows.every((row) => {
      const condition = row as { field?: unknown; operator?: unknown; value?: unknown } | null;
      return (
        condition &&
        typeof condition.field === 'string' &&
        condition.field.trim().length > 0 &&
        condition.field.length <= 200 &&
        SYNC_CONDITION_OPERATORS.includes(String(condition.operator)) &&
        (condition.value === undefined ||
          ['string', 'number', 'boolean'].includes(typeof condition.value) ||
          condition.value === null)
      );
    });
  });
}

function isValidRawConditionBySystem(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value as Record<string, unknown>).every(([system, raw]) => {
    // Only Salesforce's SOQL builder accepts a raw fragment -- HubSpot's Search API has no
    // free-text filter language to append one into.
    if (system !== 'salesforce') return false;
    return typeof raw === 'string' && raw.length <= 500 && !UNSAFE_RAW_CONDITION.test(raw);
  });
}

function migrationPlanInput(
  body: unknown,
  createdBy?: string,
): MigrationPlanInput | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = body as Record<string, unknown>;
  const name = String(value.name ?? '').trim();
  const source = String(value.source ?? '');
  const rawTypes = value.types;
  const limit = value.limitPerType === undefined || value.limitPerType === null
    ? undefined
    : Number(value.limitPerType);
  if (
    !name ||
    name.length > 120 ||
    !isSystem(source) ||
    !Array.isArray(rawTypes) ||
    rawTypes.length < 1 ||
    rawTypes.some((type) => typeof type !== 'string' || !isType(type)) ||
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100_000))
  ) {
    return undefined;
  }
  const types = [...new Set(rawTypes as CanonicalType[])];
  const config =
    value.config && typeof value.config === 'object' && !Array.isArray(value.config)
      ? value.config as MigrationPlanInput['config']
      : {};
  return {
    name,
    source,
    types,
    limitPerType: limit,
    config,
    createdBy,
  };
}

function hashesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.every((key) => a[key] === b[key]);
}

function schemaHashesFromChecks(
  checks: Awaited<ReturnType<App['preflight']['run']>>[],
): Record<string, string> {
  return Object.fromEntries(
    checks.flatMap((check) =>
      Object.entries(check.schemas).map(([system, schema]) => [
        `${system}:${check.type}`,
        schema?.hash ?? '',
      ]),
    ),
  );
}

function migrationRecordLabel(record: CanonicalRecord): string {
  const text = (field: string): string => {
    const value = record.fields[field];
    return value === null || value === undefined ? '' : String(value).trim();
  };
  if (record.type === 'contact') {
    const name = [text('firstName'), text('lastName')].filter(Boolean).join(' ');
    return name || text('email') || record.meta.sourceId;
  }
  if (record.type === 'company') {
    return text('name') || text('domain') || record.meta.sourceId;
  }
  return text('name') || record.meta.sourceId;
}

async function handleWebhook(
  system: 'salesforce' | 'hubspot',
  req: Request,
  res: Response,
  app: App,
  ensureLiveInit: () => Promise<void>,
): Promise<void> {
  try {
    const connector = app.connectors[system];
    const events = await connector.parseWebhook(req.headers, req.body as Buffer, (nativeObjectId, sourceId) =>
      resolveCanonicalType(system, nativeObjectId, sourceId, connector, app.syncConfig.get()),
    );
    const ids = await app.sync.enqueue(events);
    res.status(200).json({ received: events.length, accepted: ids.length });
    void ensureLiveInit().catch((err) => {
      logger.error({ err, system }, 'connector initialization after webhook failed');
    });
  } catch (err) {
    logger.error({ err, system }, 'webhook rejected');
    if (!res.headersSent) res.status(401).json({ error: 'invalid_webhook' });
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'server crashed');
  process.exit(1);
});
