import type { Request } from 'express';
import { isSystem } from './context.js';
import type { Connection } from '../core/connectionStore.js';
import type { CanonicalRecord, CanonicalType } from '../core/types.js';
import type { MigrationPlanInput } from '../engine/migrationPlanStore.js';
import type { App } from '../app.js';
import { PublicError } from '../core/publicError.js';
import type { AuthContext } from '../security/access.js';

/**
 * Keys an OAuth flow (state, staged pending replacement) to the browser session that
 * started it, so a different session can never complete or confirm it. Local development
 * has no session; everything there shares the single 'local' key.
 */
export function sessionKey(auth: AuthContext): string {
  return auth.sessionHash ?? 'local';
}

/** Same CRM account? Exact ids when both are known; otherwise the recorded instance/portal. */
export function sameAccount(previous: Connection, next: Connection): boolean {
  if (previous.environment !== next.environment) return false;
  if (previous.accountId && next.accountId) return previous.accountId === next.accountId;
  const identity = (connection: Connection) => connection.instanceUrl ?? connection.accountLabel;
  return Boolean(identity(previous)) && identity(previous) === identity(next);
}

export function accountSummary(connection: Connection | undefined) {
  return connection
    ? {
        environment: connection.environment,
        accountId: connection.accountId,
        accountLabel: connection.accountLabel,
        instanceUrl: connection.instanceUrl,
        connectedAt: connection.connectedAt,
      }
    : null;
}

export function connInfo(c: Connection | undefined): {
  environment: string;
  accountLabel?: string;
  connectedAt: string;
} | null {
  if (!c) return null;
  return { environment: c.environment, accountLabel: c.accountLabel, connectedAt: c.connectedAt };
}

const SYNC_CONDITION_OPERATORS = ['eq', 'ne', 'gt', 'lt', 'contains', 'is_null', 'is_not_null'];
// Advanced/raw SOQL condition can't be parameterized through this REST-style query builder,
// so it's hardened with an allow-list instead: no statement separators, no comment syntax
// (either could smuggle a second statement past the WHERE fragment it's appended into), no
// DML/set-operator keywords (this fragment is only ever appended to a SELECT's WHERE clause).
const UNSAFE_RAW_CONDITION = /;|--|\/\*|\b(insert|update|delete|upsert|union|merge)\b/i;

export function isValidConditionsBySystem(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value as Record<string, unknown>).every(([system, rows]) => {
    if (!isSystem(system)) return false;
    if (!Array.isArray(rows)) return false;
    return rows.every((row) => {
      const condition = row as { field?: unknown; operator?: unknown; value?: unknown } | null;
      return (
        condition &&
        typeof condition.field === 'string' &&
        condition.field.trim().length > 0 &&
        condition.field.length <= 200 &&
        SYNC_CONDITION_OPERATORS.includes(String(condition.operator)) &&
        (condition.value === undefined ||
          ['string', 'number', 'boolean'].includes(typeof condition.value) ||
          condition.value === null)
      );
    });
  });
}

export function isValidRawConditionBySystem(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value as Record<string, unknown>).every(([system, raw]) => {
    // Only Salesforce's SOQL builder accepts a raw fragment -- HubSpot's Search API has no
    // free-text filter language to append one into.
    if (system !== 'salesforce') return false;
    return typeof raw === 'string' && raw.length <= 500 && !UNSAFE_RAW_CONDITION.test(raw);
  });
}

export function migrationPlanInput(
  body: unknown,
  isType: (value: string) => boolean,
  createdBy?: string,
): MigrationPlanInput | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = body as Record<string, unknown>;
  const name = String(value.name ?? '').trim();
  const source = String(value.source ?? '');
  const rawTypes = value.types;
  const limit = value.limitPerType === undefined || value.limitPerType === null
    ? undefined
    : Number(value.limitPerType);
  if (
    !name ||
    name.length > 120 ||
    !isSystem(source) ||
    !Array.isArray(rawTypes) ||
    rawTypes.length < 1 ||
    rawTypes.some((type) => typeof type !== 'string' || !isType(type)) ||
    (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100_000))
  ) {
    return undefined;
  }
  const types = [...new Set(rawTypes as CanonicalType[])];
  const config =
    value.config && typeof value.config === 'object' && !Array.isArray(value.config)
      ? value.config as MigrationPlanInput['config']
      : {};
  return {
    name,
    source,
    types,
    limitPerType: limit,
    config,
    createdBy,
  };
}

/** Client idempotency key for write requests (header preferred), bounded and trimmed. */
export function idempotencyKey(req: Request): string | undefined {
  const raw = req.get('idempotency-key') ?? req.body?.idempotencyKey;
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim();
  if (!key) return undefined;
  if (key.length > 200) throw new PublicError('invalid_idempotency_key', 'Idempotency-Key is too long', 400);
  return key;
}

export function schemaHashesFromChecks(
  checks: Awaited<ReturnType<App['preflight']['run']>>[],
): Record<string, string> {
  return Object.fromEntries(
    checks.flatMap((check) =>
      Object.entries(check.schemas).map(([system, schema]) => [
        `${system}:${check.type}`,
        schema?.hash ?? '',
      ]),
    ),
  );
}

export function migrationRecordLabel(record: CanonicalRecord): string {
  const text = (field: string): string => {
    const value = record.fields[field];
    return value === null || value === undefined ? '' : String(value).trim();
  };
  if (record.type === 'contact') {
    const name = [text('firstName'), text('lastName')].filter(Boolean).join(' ');
    return name || text('email') || record.meta.sourceId;
  }
  if (record.type === 'company') {
    return text('name') || text('domain') || record.meta.sourceId;
  }
  return text('name') || record.meta.sourceId;
}

export function loginPage(error?: string): string {
  const message =
    error === 'throttled'
      ? 'Too many failed attempts. Wait a few minutes and try again.'
      : error === 'invalid'
        ? 'Email or password is incorrect, or this account has no workspace.'
        : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title>
    <style>body{font:16px system-ui;background:#08101d;color:#edf4ff;display:grid;place-items:center;min-height:100vh;margin:0}
    form{width:min(420px,calc(100vw - 32px));background:#101b2d;padding:28px;border:1px solid #263752;border-radius:14px;box-sizing:border-box}
    label{display:block;margin-top:14px;font-size:14px;color:#b9c7dd}
    input,button{width:100%;box-sizing:border-box;padding:12px;margin-top:6px;border-radius:8px;border:1px solid #263752;font:inherit}
    input{background:#08101d;color:#fff}button{margin-top:20px;background:#53a6ff;font-weight:700;cursor:pointer}
    .error{background:#3a1620;border:1px solid #7a2b3b;padding:10px 12px;border-radius:8px}</style></head>
    <body><form method="post" action="/auth/login"><h1>CRM Sync</h1>
    ${message ? `<p class="error" role="alert">${message}</p>` : ''}
    <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
    <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button></form></body></html>`;
}
