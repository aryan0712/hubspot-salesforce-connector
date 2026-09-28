import type { Request } from 'express';
import type { z } from 'zod';
import { PublicError } from '../core/publicError.js';

/**
 * R13 request validation: parse a request body against a zod schema, or answer 400 with
 * the first problem (field path + message) the operator can act on.
 */
export function parseBody<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.join('.') || 'body';
  throw new PublicError('invalid_request', `${field}: ${issue?.message ?? 'invalid'}`, 400, { field });
}
