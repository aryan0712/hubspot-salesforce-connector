import crypto from 'node:crypto';
import type { SystemId } from '../core/types.js';
import { logger } from '../logger.js';
import type { DeliveryNonce, WebhookInbox } from './inbox.js';
import { parseHubSpotPayload, verifyHubSpotRequest } from './hubspot.js';
import {
  parseSalesforcePayload,
  salesforceClaimedOrg,
  verifySalesforceRequest,
  type SalesforceSignatureMode,
} from './salesforce.js';
import {
  MAX_WEBHOOK_AGE_MS,
  MAX_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_SKEW_MS,
  WEBHOOK_STATUS,
  WebhookRejectedError,
  type NativeWebhookEvent,
  type WebhookRejection,
} from './types.js';

/** What ingress needs from the workspace a delivery is routed to. */
export interface WebhookWorkspace {
  tenantId?: string;
  inbox: WebhookInbox;
  /** HubSpot app secret / Salesforce webhook secret for this workspace. */
  secret(system: SystemId): Promise<string | undefined>;
  /** The exact connected account (portal id / org id), when known. */
  connectedAccount(system: SystemId): Promise<string | undefined>;
  /** Operator-visible signal for authenticity/routing failures. */
  alert?(message: string): void;
  /** Called after a delivery was persisted (wakes the inbox processor). */
  notify?(): void;
}

export interface WebhookIngressOptions {
  /** The trusted public base URL (HubSpot signs the URI it called). */
  publicBaseUrl: string;
  /**
   * The workspace for a delivery. Single-tenant processes return their own workspace;
   * multi-tenant processes route by the account named in the delivery (and return
   * undefined for accounts connected to no workspace).
   */
  resolveWorkspace(system: SystemId, accountId: string | undefined): Promise<WebhookWorkspace | undefined>;
  salesforceMode: SalesforceSignatureMode;
  /** Local development only (refused in production): accept deliveries without a secret. */
  allowUnsigned?: boolean;
  /** Pending inbox rows above which new deliveries are refused with 503 (vendor retries). */
  maxBacklog?: number;
  metrics?: WebhookMetrics;
  now?: () => number;
}

export interface WebhookRequest {
  method: string;
  /** Path + query as received (e.g. /webhooks/hubspot?x=1). */
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | undefined;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * R12 webhook ingress. Every outcome is deterministic:
 *  - 200: verified and persisted (new or duplicate) -- safe to acknowledge;
 *  - 400/413: malformed or oversized -- a retry cannot succeed;
 *  - 401: not authentic (signature, freshness, replayed nonce);
 *  - 403: authentic structure but not for any / this workspace's account;
 *  - 503: we could not accept it now (secret not configured, backlog, database) -- retry.
 * Nothing slow happens before acknowledgement: no CRM calls; type resolution is deferred to
 * initialized workers (WebhookInboxProcessor).
 */
export class WebhookIngress {
  private readonly now: () => number;
  readonly metrics: WebhookMetrics;

  constructor(private readonly opts: WebhookIngressOptions) {
    this.now = opts.now ?? Date.now;
    this.metrics = opts.metrics ?? new WebhookMetrics();
  }

  async handle(system: SystemId, request: WebhookRequest): Promise<WebhookResponse> {
    const started = this.now();
    let workspace: WebhookWorkspace | undefined;
    try {
      const body = request.body ?? Buffer.alloc(0);
      if (body.length > MAX_WEBHOOK_BODY_BYTES) throw new WebhookRejectedError('oversized');
      const text = body.toString('utf8');
      const result =
        system === 'hubspot'
          ? await this.hubspot(request, text, (found) => (workspace = found))
          : await this.salesforce(request, text, (found) => (workspace = found));
      this.metrics.record(workspace?.tenantId, 'accepted', result.accepted);
      this.metrics.record(workspace?.tenantId, 'duplicates', result.duplicates);
      this.metrics.latency(workspace?.tenantId, this.now() - started);
      return { status: 200, body: { received: result.received, accepted: result.accepted, duplicates: result.duplicates } };
    } catch (err) {
      const reason: WebhookRejection = err instanceof WebhookRejectedError ? err.reason : 'internal_error';
      this.metrics.record(workspace?.tenantId, reason, 1);
      const context = { system, reason, tenantId: workspace?.tenantId };
      if (reason === 'internal_error') logger.error({ ...context, err }, 'webhook could not be persisted');
      else logger.warn({ ...context, detail: err instanceof Error ? err.message : undefined }, 'webhook rejected');
      if (['bad_signature', 'replayed', 'account_mismatch', 'stale_timestamp'].includes(reason)) {
        workspace?.alert?.(`${system} webhook rejected: ${reason.replace(/_/g, ' ')}`);
      }
      return { status: WEBHOOK_STATUS[reason], body: { error: reason } };
    }
  }

  private async hubspot(request: WebhookRequest, text: string, found: (w: WebhookWorkspace) => void) {
    const { accountId, events } = parseHubSpotPayload(text, this.now());
    const workspace = await this.opts.resolveWorkspace('hubspot', accountId);
    if (!workspace) throw new WebhookRejectedError('unknown_account');
    found(workspace);
    const secret = await workspace.secret('hubspot');
    if (secret) {
      verifyHubSpotRequest({
        secret,
        method: request.method,
        uri: `${this.opts.publicBaseUrl.replace(/\/$/, '')}${request.originalUrl}`,
        body: text,
        signature: first(request.headers['x-hubspot-signature-v3']),
        timestamp: first(request.headers['x-hubspot-request-timestamp']),
        now: this.now(),
      });
    } else if (!this.opts.allowUnsigned) {
      throw new WebhookRejectedError('secret_unavailable');
    }
    await this.assertAccount(workspace, 'hubspot', accountId);
    return this.persist(workspace, events);
  }

  private async salesforce(request: WebhookRequest, text: string, found: (w: WebhookWorkspace) => void) {
    const claimedOrg = salesforceClaimedOrg(request.headers);
    const workspace = await this.opts.resolveWorkspace('salesforce', claimedOrg);
    if (!workspace) throw new WebhookRejectedError('unknown_account');
    found(workspace);
    const secret = await workspace.secret('salesforce');
    let orgId: string | undefined;
    let nonce: DeliveryNonce | undefined;
    if (secret) {
      const verified = verifySalesforceRequest({
        secret,
        headers: request.headers,
        body: text,
        mode: this.opts.salesforceMode,
        now: this.now(),
      });
      orgId = verified.orgId;
      this.metrics.record(workspace.tenantId, verified.version === 'v2' ? 'signature_v2' : 'signature_legacy', 1);
      if (verified.nonce) {
        nonce = {
          system: 'salesforce',
          value: verified.nonce,
          expiresAt: new Date(verified.timestamp! + MAX_WEBHOOK_AGE_MS + MAX_WEBHOOK_SKEW_MS).toISOString(),
        };
      }
    } else if (!this.opts.allowUnsigned) {
      throw new WebhookRejectedError('secret_unavailable');
    }
    if (orgId) await this.assertAccount(workspace, 'salesforce', orgId);
    const events = parseSalesforcePayload(text, this.now()).map((event) => ({ ...event, accountId: orgId }));
    return this.persist(workspace, events, nonce);
  }

  /** The delivery must be for the account this workspace is connected to. */
  private async assertAccount(workspace: WebhookWorkspace, system: SystemId, accountId: string): Promise<void> {
    const connected = await workspace.connectedAccount(system);
    if (connected && !sameAccountId(connected, accountId)) throw new WebhookRejectedError('account_mismatch');
    if (!connected) this.metrics.record(workspace.tenantId, 'account_unverified', 1);
  }

  private async persist(workspace: WebhookWorkspace, events: NativeWebhookEvent[], nonce?: DeliveryNonce) {
    if (this.opts.maxBacklog !== undefined && (await workspace.inbox.pendingCount()) >= this.opts.maxBacklog) {
      throw new WebhookRejectedError('backlog_full');
    }
    const { accepted, duplicates, replayed } = await workspace.inbox.accept(events, nonce);
    if (replayed) throw new WebhookRejectedError('replayed');
    if (accepted) workspace.notify?.();
    return { received: events.length, accepted, duplicates };
  }
}

/** Salesforce ids compare on their 15-character case-sensitive prefix. */
function sameAccountId(a: string, b: string): boolean {
  return a === b || (a.length >= 15 && b.length >= 15 && a.slice(0, 15) === b.slice(0, 15));
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Per-workspace webhook telemetry (R12): acceptance, duplicates, each rejection reason,
 * signature versions and acknowledgement latency. Deliveries that could not be routed are
 * counted under "unrouted".
 */
export class WebhookMetrics {
  private counters = new Map<string, Map<string, number>>();
  private latencies = new Map<string, number[]>();

  record(tenantId: string | undefined, name: string, amount: number): void {
    if (!amount) return;
    const key = tenantId ?? 'unrouted';
    const counters = this.counters.get(key) ?? new Map<string, number>();
    counters.set(name, (counters.get(name) ?? 0) + amount);
    this.counters.set(key, counters);
  }

  latency(tenantId: string | undefined, ms: number): void {
    const key = tenantId ?? 'unrouted';
    const values = this.latencies.get(key) ?? [];
    values.push(ms);
    if (values.length > 1000) values.shift();
    this.latencies.set(key, values);
  }

  snapshot(tenantId: string | undefined): { counters: Record<string, number>; ackLatencyMs: { p50?: number; p95?: number; max?: number } } {
    const key = tenantId ?? 'unrouted';
    const values = [...(this.latencies.get(key) ?? [])].sort((a, b) => a - b);
    const pick = (q: number) => (values.length ? values[Math.min(values.length - 1, Math.floor(q * values.length))] : undefined);
    return {
      counters: Object.fromEntries(this.counters.get(key) ?? []),
      ackLatencyMs: { p50: pick(0.5), p95: pick(0.95), max: values.at(-1) },
    };
  }
}

/**
 * The Salesforce webhook secret of a workspace. Single-tenant processes use
 * SF_WEBHOOK_SECRET as-is (existing senders keep working); multi-tenant processes derive a
 * distinct secret per workspace from it, so one workspace's sender cannot sign for another.
 */
export function salesforceWebhookSecret(master: string | undefined, tenantId: string | undefined, multiTenant: boolean): string | undefined {
  if (!master) return undefined;
  if (!multiTenant || !tenantId) return master;
  return crypto.createHmac('sha256', master).update(`crm-sync:salesforce-webhook:${tenantId}`).digest('hex');
}
