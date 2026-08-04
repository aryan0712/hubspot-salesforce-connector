import type { NextFunction, Request, Response } from 'express';
import type { PostgresApiKeyRepository, Role } from '../db/operationsRepository.js';

const LEVEL: Record<Role, number> = { viewer: 1, operator: 2, admin: 3, owner: 4 };

export interface AuthContext {
  actorId: string;
  role: Role;
}

export function authenticate(
  required: boolean,
  repository?: PostgresApiKeyRepository,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!required) {
      res.locals.auth = { actorId: 'local-owner', role: 'owner' } satisfies AuthContext;
      next();
      return;
    }
    const token =
      req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ??
      cookie(req.headers.cookie, 'crm_api_key');
    const verified = token && repository ? await repository.verify(token) : undefined;
    if (!verified) {
      res.status(401).json({ error: 'authentication_required' });
      return;
    }
    res.locals.auth = { actorId: `api-key:${verified.id}`, role: verified.role } satisfies AuthContext;
    next();
  };
}

function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

export function requireRole(minimum: Role) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const auth = res.locals.auth as AuthContext | undefined;
    if (!auth || LEVEL[auth.role] < LEVEL[minimum]) {
      res.status(403).json({ error: 'insufficient_role', required: minimum });
      return;
    }
    next();
  };
}
