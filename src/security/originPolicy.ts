const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Keep API mutations bound to the configured public origin while allowing the
 * common loopback aliases to be used interchangeably during local development.
 */
export function allowedApiOrigins(publicBaseUrl: string): Set<string> {
  const configured = new URL(publicBaseUrl);
  const allowed = new Set([configured.origin]);

  if (!LOOPBACK_HOSTNAMES.has(configured.hostname)) return allowed;

  const port = configured.port ? `:${configured.port}` : '';
  allowed.add(`${configured.protocol}//localhost${port}`);
  allowed.add(`${configured.protocol}//127.0.0.1${port}`);
  allowed.add(`${configured.protocol}//[::1]${port}`);
  return allowed;
}
