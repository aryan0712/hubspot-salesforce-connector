import type { PostgresDatabase } from './postgres.js';
import { TenantRepository } from './tenantRepository.js';
import { logger } from '../logger.js';

/**
 * R14 data retention. Operational rows that are finished and no longer needed for recovery
 * are purged after a retention window; everything that is evidence or state is kept:
 *  - kept: audit entries, conflicts, tombstones, migration plans/runs/items, record links,
 *    unresolved write intents (pending/applied/uncertain/review), anything not finished;
 *  - purged after the window: completed/dismissed sync jobs, processed webhook inbox rows,
 *    sent/abandoned notification deliveries, committed/abandoned write intents;
 *  - purged when expired: replay nonces, OAuth states, sessions, login attempts.
 */
export interface RetentionPolicy {
  /** Finished operational rows (sync jobs, inbox, deliveries, finished intents). */
  operationalDays: number;
  /** Security bookkeeping (login attempts, ended sessions). */
  securityDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { operationalDays: 30, securityDays: 30 };

const TENANT_RULES: { table: string; where: string; window: keyof RetentionPolicy | 'expired' }[] = [
  { table: 'sync_events', where: `status IN ('completed', 'dismissed') AND updated_at < $2`, window: 'operationalDays' },
  { table: 'webhook_inbox', where: `status IN ('queued', 'discarded') AND received_at < $2`, window: 'operationalDays' },
  { table: 'notification_deliveries', where: `status IN ('sent', 'abandoned') AND created_at < $2`, window: 'operationalDays' },
  { table: 'write_intents', where: `status IN ('committed', 'abandoned') AND updated_at < $2`, window: 'operationalDays' },
  { table: 'webhook_nonces', where: `expires_at < now()`, window: 'expired' },
  {
    table: 'oauth_states',
    where: `expires_at < now() - interval '1 day' AND (pending_expires_at IS NULL OR pending_expires_at < now())`,
    window: 'expired',
  },
];

export async function applyRetention(
  db: PostgresDatabase,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now = new Date(),
): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  const cutoff = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();
  for (const tenant of await new TenantRepository(db).listAll()) {
    await db.tenant(tenant.id, async (client) => {
      for (const rule of TENANT_RULES) {
        const params: unknown[] = [tenant.id];
        if (rule.window !== 'expired') params.push(cutoff(policy[rule.window]));
        const result = await client.query(`DELETE FROM ${rule.table} WHERE tenant_id = $1 AND ${rule.where}`, params);
        deleted[rule.table] = (deleted[rule.table] ?? 0) + (result.rowCount ?? 0);
      }
    });
  }
  // Global identity bookkeeping.
  const attempts = await db.pool.query('DELETE FROM login_attempts WHERE attempted_at < $1', [cutoff(policy.securityDays)]);
  deleted.login_attempts = attempts.rowCount ?? 0;
  const sessions = await db.pool.query(
    `DELETE FROM user_sessions WHERE (revoked_at IS NOT NULL OR expires_at < now()) AND last_seen_at < $1`,
    [cutoff(policy.securityDays)],
  );
  deleted.user_sessions = sessions.rowCount ?? 0;
  return deleted;
}

/** Runs retention once a day in the worker side of a process. */
export function scheduleRetention(db: PostgresDatabase, policy: RetentionPolicy = DEFAULT_RETENTION): () => void {
  const run = () =>
    applyRetention(db, policy)
      .then((deleted) => logger.info({ deleted }, 'data retention applied'))
      .catch((err) => logger.error({ err }, 'data retention failed'));
  const first = setTimeout(run, 60_000);
  const daily = setInterval(run, 24 * 60 * 60_000);
  first.unref?.();
  daily.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
