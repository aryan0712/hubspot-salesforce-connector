import type { CRMConnector } from '../core/connector.js';
import type { SystemId } from '../core/types.js';
import type { PostgresDatabase } from '../db/postgres.js';
import type { SyncEventStore } from '../engine/syncEventStore.js';
import type { ExecutionStore } from '../engine/executionStore.js';
import type { WebhookInbox } from '../webhooks/inbox.js';

/** An operational condition an operator should act on (R14). */
export interface OperationalAlert {
  id: string;
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
}

export interface AlertSources {
  db?: PostgresDatabase;
  syncStore: SyncEventStore;
  executions: ExecutionStore;
  webhookInbox: WebhookInbox;
  connectors: Record<SystemId, CRMConnector>;
  maxWebhookBacklog: number;
  /** A change waiting longer than this means sync is stale. */
  staleAfterMs?: number;
  now?: () => number;
}

type Health = { state: string; lastError?: string; openedUntil?: string } | undefined;

/**
 * Evaluates a workspace's operational alerts: database health, stale sync, dead letters and
 * changes waiting for review, CRM availability and credentials, migrations that paused,
 * failed or partially completed (including drift and invalidated approvals), and webhook
 * backlog. Used by /api/alerts, the metrics endpoint and the alert email digest.
 */
export async function evaluateAlerts(sources: AlertSources): Promise<OperationalAlert[]> {
  const alerts: OperationalAlert[] = [];
  const now = sources.now?.() ?? Date.now();
  if (sources.db) {
    try {
      await sources.db.health();
    } catch (err) {
      alerts.push({
        id: 'database_unreachable',
        severity: 'critical',
        title: 'Database unreachable',
        detail: err instanceof Error ? err.message : String(err),
      });
      return alerts; // everything else depends on it
    }
  }

  const [stats, oldest] = await Promise.all([sources.syncStore.stats(), sources.syncStore.oldestPending()]);
  const staleAfter = sources.staleAfterMs ?? 15 * 60_000;
  if (oldest && now - Date.parse(oldest) > staleAfter) {
    alerts.push({
      id: 'sync_stale',
      severity: 'warning',
      title: 'Sync is falling behind',
      detail: `The oldest waiting change arrived ${Math.round((now - Date.parse(oldest)) / 60_000)} minutes ago (${stats.queued} queued, ${stats.retry} retrying).`,
    });
  }
  if (stats.deadLetter) {
    alerts.push({
      id: 'sync_dead_letters',
      severity: 'warning',
      title: 'Changes failed to sync',
      detail: `${stats.deadLetter} change(s) exhausted their retries and need an operator.`,
    });
  }
  if (stats.manualReview) {
    alerts.push({
      id: 'sync_manual_review',
      severity: 'warning',
      title: 'Changes waiting for review',
      detail: `${stats.manualReview} change(s) (deletes, ambiguous matches, conflicts) wait for a decision.`,
    });
  }

  for (const system of ['salesforce', 'hubspot'] as const) {
    const health = (sources.connectors[system] as { health?: () => Health }).health?.();
    if (!health || health.state === 'closed') continue;
    const credentials = /reconnect|invalid_grant|expired|revoked|401|unauthori[sz]ed/i.test(health.lastError ?? '');
    alerts.push({
      id: credentials ? `crm_reconnect_required_${system}` : `crm_unavailable_${system}`,
      severity: health.state === 'open' ? 'critical' : 'warning',
      title: credentials
        ? `${system === 'salesforce' ? 'Salesforce' : 'HubSpot'} must be reconnected`
        : `${system === 'salesforce' ? 'Salesforce' : 'HubSpot'} requests are failing`,
      detail: health.lastError ?? `circuit ${health.state}`,
    });
  }

  const dayAgo = now - 24 * 60 * 60_000;
  const troubled = (await sources.executions.list(100)).filter(
    (execution) =>
      ['paused', 'failed', 'partial'].includes(execution.status) &&
      Date.parse(execution.finishedAt ?? execution.createdAt) >= dayAgo,
  );
  if (troubled.length) {
    const drift = troubled.filter((execution) => /drift|approval|changed/i.test(execution.pauseReason ?? ''));
    alerts.push({
      id: 'migrations_need_attention',
      severity: troubled.some((execution) => execution.status === 'failed') ? 'critical' : 'warning',
      title: 'Migrations need attention',
      detail:
        `${troubled.length} migration run(s) paused, failed or partially completed in the last 24 hours` +
        (drift.length ? `; ${drift.length} stopped because source data or the approval changed (drift).` : '.'),
    });
  }

  const pending = await sources.webhookInbox.pendingCount();
  if (pending > sources.maxWebhookBacklog / 2) {
    alerts.push({
      id: 'webhook_backlog',
      severity: pending >= sources.maxWebhookBacklog ? 'critical' : 'warning',
      title: 'Webhook backlog is growing',
      detail: `${pending} delivered change(s) are waiting to be processed (limit ${sources.maxWebhookBacklog}).`,
    });
  }
  return alerts;
}
