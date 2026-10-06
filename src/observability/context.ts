import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * R14 correlation: the request / workspace / job a piece of work belongs to. Every log line
 * written inside a context carries these fields (logger mixin), so one request id or job id
 * finds everything that happened for it -- including the CRM calls it made.
 */
export interface LogContext {
  requestId?: string;
  tenantId?: string;
  jobId?: string;
  executionId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const parent = storage.getStore();
  return storage.run({ ...parent, ...context }, fn);
}

/** Adds fields to the current context (e.g. the tenant once a request is authenticated). */
export function annotateLogContext(fields: LogContext): void {
  const current = storage.getStore();
  if (current) Object.assign(current, fields);
}

export function logContext(): LogContext | undefined {
  return storage.getStore();
}
