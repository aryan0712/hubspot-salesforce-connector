import crypto from 'node:crypto';

/**
 * R13: pages are served without inline scripts so the Content-Security-Policy can be
 * `script-src 'self'`. Each page's script is moved out of its HTML into a versioned
 * same-origin asset (/assets/<page>.js?v=<hash>); the script tag stays where the inline one
 * was, so execution order relative to the markup is unchanged.
 */
export interface PageBundle {
  html: string;
  script: string;
  version: string;
}

const bundles = new Map<string, PageBundle>();

export function pageBundle(name: string, render: () => string): PageBundle {
  let bundle = bundles.get(name);
  if (!bundle) {
    const source = render();
    const scripts: string[] = [];
    let first = true;
    const version = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
    const html = source.replace(/<script>([\s\S]*?)<\/script>/g, (_match, body: string) => {
      scripts.push(body);
      if (!first) return '';
      first = false;
      return `<script src="/assets/${name}.js?v=${version}"></script>`;
    });
    bundle = { html, script: scripts.join('\n;\n'), version };
    bundles.set(name, bundle);
  }
  return bundle;
}

/** The asset for /assets/<name>.js, if a page with that name has been registered. */
export function pageScript(name: string): string | undefined {
  return bundles.get(name)?.script;
}
