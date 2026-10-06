import axios from 'axios';
import type { ErrorRequestHandler } from 'express';
import { logger } from '../logger.js';
import { migrationRefusals } from '../observability/metrics.js';
import { PublicError } from '../core/publicError.js';
import { friendlyErrorMessage } from '../core/vendorError.js';
import { ConditionalWriteRejectedError } from '../core/connector.js';
import { PlanStateError } from '../engine/migrationPlanStore.js';
import { ApprovalInvalidatedError, PreviewDriftError } from '../engine/migrationEngine.js';
import { ExecutionRefusedError, PreflightFailedError } from '../engine/migrationService.js';
import { IdentityConflictError } from '../engine/reconciler.js';

/**
 * Stable, actionable responses for every reason an approved-plan write is refused. None
 * of these are server faults: each means "nothing was written for this request".
 */
export function migrationErrorResponse(
  err: unknown,
): { status: number; body: Record<string, unknown> } | undefined {
  if (err instanceof PreflightFailedError) {
    return { status: 409, body: { error: 'preflight_failed', checks: err.checks } };
  }
  if (err instanceof ApprovalInvalidatedError) {
    return { status: 409, body: { error: 'approval_invalidated', reason: err.reason, detail: err.message } };
  }
  if (err instanceof PreviewDriftError) {
    return { status: 409, body: { error: 'preview_drift', detail: err.message } };
  }
  if (err instanceof IdentityConflictError) {
    return { status: 409, body: { error: 'identity_conflict', detail: err.message } };
  }
  if (err instanceof ConditionalWriteRejectedError) {
    return { status: 409, body: { error: 'record_changed', detail: err.message } };
  }
  if (err instanceof PlanStateError) {
    return { status: 409, body: { error: err.code, detail: err.message } };
  }
  if (err instanceof ExecutionRefusedError) {
    const status = err.code === 'plan_not_found' ? 404 : err.code === 'quota_exceeded' ? 429 : 409;
    const error =
      err.code === 'quota_exceeded'
        ? 'plan_limit_exceeded'
        : err.code === 'plan_state'
          ? 'execution_not_allowed'
          : err.code;
    return { status, body: { error, detail: err.message, ...err.detail } };
  }
  return undefined;
}

/**
 * The one place request failures become responses. Every error body carries the request's
 * correlation id; only genuinely unexpected failures are 5xx.
 */
export function errorHandler(): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    const requestId = res.locals.requestId;
    const send = (status: number, body: Record<string, unknown>) => {
      if (!res.headersSent) res.status(status).json({ ...body, requestId });
    };
    const domain = migrationErrorResponse(err);
    if (domain) {
      migrationRefusals.inc({ reason: String(domain.body.error) });
      logger.warn({ err, requestId, code: domain.body.error }, 'migration request refused');
      return send(domain.status, domain.body);
    }
    // Body larger than the route's limit (webhooks: 1 MB).
    if ((err as { type?: unknown })?.type === 'entity.too.large') return send(413, { error: 'oversized' });
    // Unparseable JSON body.
    if ((err as { type?: unknown })?.type === 'entity.parse.failed') {
      return send(400, { error: 'invalid_json', detail: 'The request body is not valid JSON.' });
    }
    // A malformed identifier (e.g. not a UUID) cannot name anything: not found, not a 500.
    if ((err as { code?: unknown })?.code === '22P02') return send(404, { error: 'not_found' });
    if (err instanceof PublicError) {
      logger.warn({ err, requestId, code: err.code }, 'request requires operator action');
      return send(err.status, { error: err.code, detail: err.message, ...err.detail });
    }
    if (axios.isAxiosError(err)) {
      logger.error(
        { err, requestId, vendorStatus: err.response?.status, vendorBody: err.response?.data },
        'CRM API request failed',
      );
      return send(502, { error: 'crm_api_error', detail: friendlyErrorMessage(err) });
    }
    logger.error({ err, requestId }, 'request failed');
    return send(500, { error: 'internal_error' });
  };
}
