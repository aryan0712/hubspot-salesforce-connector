import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Role } from '../db/operationsRepository.js';
import type { SessionService } from './identity.js';

export const ROLE_LEVEL: Record<Role, number> = { viewer: 1, operator: 2, admin: 3, owner: 4 };

export const SESSION_COOKIE = 'crm_session';
export const CSRF_COOKIE = 'crm_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface AuthContext {
  actorId: string;
  role: Role;
  /** The workspace this request acts for (R11); undefined only for the mock demo. */
  tenantId?: string;
  via: 'local' | 'session' | 'api-key';
  userId?: string;
  email?: string;
  sessionHash?: string;
}

/** Resolves a machine API key to its workspace and role. */
export interface ApiKeyVerifier {
  verify(key: string): Promise<{ id: string; role: Exclude<Role, 'owner'>; tenantId: string } | undefined>;
}

export interface AuthenticateOptions {
  required: boolean;
  sessions?: SessionService;
  apiKeys?: ApiKeyVerifier;
  /** The workspace used by unauthenticated local development. */
  localTenantId?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Request authentication (R11):
 *  - local development without AUTH_REQUIRED acts as the local owner (the runtime guard
 *    only allows that on a loopback, non-production server);
 *  - machines send `Authorization: Bearer <api key>` (never a cookie, so not CSRF-able);
 *  - browsers hold a server-side session cookie; every unsafe request must echo the
 *    session's CSRF token in the X-CSRF-Token header.
 */
export function authenticate(opts: AuthenticateOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const auth = await resolveAuth(req, opts);
      if (auth === 'csrf') {
        res.status(403).json({ error: 'csrf_token_invalid' });
        return;
      }
      if (!auth) {
        res.status(401).json({ error: 'authentication_required' });
        return;
      }
      res.locals.auth = auth;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function resolveAuth(
  req: Request,
  opts: AuthenticateOptions,
): Promise<AuthContext | 'csrf' | undefined> {
  if (!opts.required) {
    return { actorId: 'local-owner', role: 'owner', tenantId: opts.localTenantId, via: 'local' };
  }
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const verified = opts.apiKeys ? await opts.apiKeys.verify(bearer) : undefined;
    if (!verified) return undefined;
    return { actorId: `api-key:${verified.id}`, role: verified.role, tenantId: verified.tenantId, via: 'api-key' };
  }
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  const session = token && opts.sessions ? await opts.sessions.resolve(token) : undefined;
  if (!session) return undefined;
  if (!SAFE_METHODS.has(req.method)) {
    const header = req.headers[CSRF_HEADER];
    if (!opts.sessions!.verifyCsrf(session, typeof header === 'string' ? header : undefined)) return 'csrf';
  }
  return {
    actorId: `user:${session.userId}`,
    role: session.role,
    tenantId: session.tenantId,
    via: 'session',
    userId: session.userId,
    email: session.email,
    sessionHash: session.sessionHash,
  };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Route guard; the required role is exposed for the route-matrix test and docs. */
export type RoleGuard = RequestHandler & { requiredRole: Role };

export function requireRole(minimum: Role): RoleGuard {
  const guard = ((_req: Request, res: Response, next: NextFunction): void => {
    const auth = res.locals.auth as AuthContext | undefined;
    if (!auth || ROLE_LEVEL[auth.role] < ROLE_LEVEL[minimum]) {
      res.status(403).json({ error: 'insufficient_role', required: minimum });
      return;
    }
    next();
  }) as RoleGuard;
  guard.requiredRole = minimum;
  return guard;
}

export function sessionCookies(
  issued: { token: string; csrfToken: string },
  opts: { secure: boolean; maxAgeSeconds: number },
): string[] {
  const secure = opts.secure ? '; Secure' : '';
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(issued.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${opts.maxAgeSeconds}${secure}`,
    // Readable by the page so its scripts can echo it in X-CSRF-Token (double submit,
    // verified against the server-side session hash).
    `${CSRF_COOKIE}=${encodeURIComponent(issued.csrfToken)}; SameSite=Strict; Path=/; Max-Age=${opts.maxAgeSeconds}${secure}`,
  ];
}

export function clearSessionCookies(secure: boolean): string[] {
  const flag = secure ? '; Secure' : '';
  return [
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${flag}`,
    `${CSRF_COOKIE}=; SameSite=Strict; Path=/; Max-Age=0${flag}`,
  ];
}
