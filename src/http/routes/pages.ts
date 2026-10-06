import { Router } from 'express';
import { connectionsHtml } from '../../dashboard/connections.js';
import { dashboardHtml } from '../../dashboard/html.js';
import { operationsHtml } from '../../dashboard/operations.js';
import { pageBundle, pageScript } from '../../dashboard/assets.js';
import type { RouteContext } from '../context.js';

/** The three HTML pages, their bundled scripts, and a couple of static endpoints. */
export function pageRoutes(ctx: RouteContext): Router {
  const router = Router();
  const { runtime } = ctx;

  // Register page bundles up front so their script assets resolve even before the page
  // itself was requested (the demo only where demo routes are enabled).
  pageBundle('connections', connectionsHtml);
  pageBundle('ops', operationsHtml);
  if (runtime.demoRoutes) pageBundle('demo', dashboardHtml);

  router.get('/', (_req, res) => res.type('html').send(pageBundle('connections', connectionsHtml).html));
  if (runtime.demoRoutes) {
    router.get('/demo', (_req, res) => res.type('html').send(pageBundle('demo', dashboardHtml).html));
  }
  router.get('/ops', (_req, res) => res.type('html').send(pageBundle('ops', operationsHtml).html));
  router.get('/favicon.ico', (_req, res) => res.status(204).end());
  router.get('/assets/:file', (req, res) => {
    const name = String(req.params.file).match(/^([a-z]+)\.js$/)?.[1];
    const script = name ? pageScript(name) : undefined;
    if (!script) return res.status(404).type('text').send('not found');
    // Versioned URL (?v=<content hash>): cache long, the HTML always names the current one.
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.type('application/javascript').send(script);
  });

  return router;
}
