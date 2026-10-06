import { Router } from 'express';
import { createApp, type App } from '../../app.js';
import { MockConnector } from '../../connectors/mock/mockConnector.js';
import type { RouteContext } from '../context.js';

/**
 * The interactive demo playground (mock CRMs, `/demo`). A separate, isolated App with its
 * own ConfigContext and storage, created on first use; mounted only outside production.
 */
export function demoRoutes(ctx: RouteContext): Router {
  const router = Router();
  let demoApp: Promise<App> | undefined;
  const getDemo = (): Promise<App> =>
    (demoApp ??= (ctx.options.createDemoApp ?? (() => createApp({ mock: true })))());

  router.get('/api/demo/status', async (_req, res) => {
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

  router.get('/api/demo/activity', async (_req, res) => {
    const d = await getDemo();
    res.json({ entries: d.activity.recent(50) });
  });

  router.post('/api/demo/seed', async (_req, res) => {
    const d = await getDemo();
    const sf = d.connectors.salesforce as MockConnector;
    sf.seed('contact', { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@analytical.co', phone: '+1-111' });
    sf.seed('contact', { firstName: 'Alan', lastName: 'Turing', email: 'alan@enigma.uk', phone: '+44-222' });
    sf.seed('contact', { firstName: 'Grace', lastName: 'Hopper', email: 'grace@navy.mil', phone: '+1-333' });
    d.activity.record({ kind: 'info', message: 'Seeded 3 Salesforce contacts' });
    res.json({ ok: true });
  });

  router.post('/api/demo/migrate', async (_req, res) => {
    const d = await getDemo();
    // The mock playground previews and executes that exact frozen preview in one step.
    res.json(await d.migration.run({ from: 'salesforce', types: ['contact'], dryRun: false }));
  });

  router.post('/api/demo/edit', async (_req, res) => {
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

  return router;
}
