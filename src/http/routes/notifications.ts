import { Router } from 'express';
import { requireRole } from '../../security/access.js';
import { limitParam, type RouteContext } from '../context.js';

/** Sync-failure email alerting: settings, delivery history (R14), and a manual "check now". */
export function notificationRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { app } = ctx;

  router.get('/api/notifications/settings', requireRole('admin'), async (_req, res) => {
    res.json(
      (await app.notificationSettings?.status()) ?? { enabled: false, smtpConfigured: false },
    );
  });

  router.put('/api/notifications/settings', requireRole('admin'), async (req, res) => {
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

  /** R14: what was actually delivered, what failed (and when it retries), what is waiting for SMTP. */
  router.get('/api/notifications/deliveries', requireRole('admin'), async (req, res) => {
    if (!app.alertDigester) return res.json({ entries: [] });
    res.json({ entries: await app.alertDigester.recentDeliveries(limitParam(req.query.limit, 50, 200)) });
  });

  router.post('/api/notifications/check-now', requireRole('operator'), async (_req, res) => {
    if (!app.alertDigester) return res.status(503).json({ error: 'postgres_required' });
    res.json(await app.alertDigester.checkNow());
  });

  return router;
}
