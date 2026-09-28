import { Router } from 'express';
import { env } from '../../config/env.js';
import { requireRole } from '../../security/access.js';
import { validateOpenAIKey } from '../../ai/migrationCopilot.js';
import { keyFingerprint } from '../../core/fingerprint.js';
import type { RouteContext } from '../context.js';

/** Admin-managed Migration Copilot (OpenAI) credential. Write-only key, one-way fingerprint. */
export function aiSettingsRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app, migrationCopilot } = ctx;

  router.get('/api/ai/settings', requireRole('admin'), async (_req, res) => {
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

  router.post('/api/ai/settings', requireRole('admin'), async (req, res) => {
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

  router.delete('/api/ai/settings', requireRole('admin'), async (_req, res) => {
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

  return router;
}
