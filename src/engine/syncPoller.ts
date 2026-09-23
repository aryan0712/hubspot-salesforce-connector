import type { CRMConnector, QueryCondition } from '../core/connector.js';
import type { ReplayCursorStore } from '../connectors/salesforce/cdcWorker.js';
import type { ChangeEvent, CanonicalType, SystemId } from '../core/types.js';
import {
  MAX_POLLING_INTERVAL_MINUTES,
  MIN_POLLING_INTERVAL_MINUTES,
  nextCronOccurrences,
  syncAllows,
  type SyncConfig,
  type SyncConfigStore,
} from '../core/syncConfig.js';
import { canonicalObjectsFor, requireNativeObjectName } from '../core/objectRegistry.js';
import type { IdMapStore } from '../core/idMap.js';
import type { ActivityLog } from '../observability/activity.js';
import type { SyncEngine } from './syncEngine.js';
import { logger } from '../logger.js';
import { friendlyErrorMessage } from '../core/vendorError.js';

const POLL_STREAM_PREFIX = 'poll:';
// Bounded first-run lookback so an initial poll can't trigger an unbounded backfill, unless
// the object's own polling config sets a longer lookbackDays.
const DEFAULT_LOOKBACK_DAYS = 1;
// How often the scheduler checks which objects are due -- independent of any object's own
// interval, which can be as short as MIN_POLLING_INTERVAL_MINUTES (1 minute).
const BASE_TICK_MS = 30_000;

export interface SyncPollerSummary {
  at: string;
  changed: number;
  deleted: number;
  errors: number;
  /**
   * Human-readable cause for each failed system this cycle -- a poll failure happens before
   * any sync job/event ever exists, so unlike a per-record sync error it has no dead-letter
   * row to inspect in Activity; this is the only place it's ever recorded. Kept short (one
   * entry per system) rather than accumulating history -- see the Activity log for that.
   */
  errorMessages: string[];
}

/**
 * Complements webhook-driven sync with a scheduled "what changed since last time" sweep,
 * for setups where webhooks aren't configured or reachable (make.com-style scheduled trigger).
 * Reuses SyncEngine.enqueue() for the actual sync work -- this class only discovers changes.
 *
 * Every registered object gets its own schedule ("scenario"): its own enabled flag and
 * interval, tracked independently, rather than one global interval for everything. Nothing
 * here is specific to any particular object -- it all runs off whatever's currently
 * registered (core/objectRegistry.ts) and configured (core/syncConfig.ts).
 */
export class SyncPoller {
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private ensureReady?: () => Promise<void>;
  private readonly runningTypes = new Set<CanonicalType>();
  private readonly nextDueAt = new Map<CanonicalType, number>();
  private readonly lastRunByType = new Map<CanonicalType, SyncPollerSummary>();
  // Bounded run history per object, newest first -- lastRunByType only ever answers "what
  // happened most recently," which can't tell "did this fail yesterday too, or is this new."
  private readonly historyByType = new Map<CanonicalType, SyncPollerSummary[]>();
  private static readonly HISTORY_LIMIT = 20;

  constructor(
    private readonly connectors: Record<SystemId, CRMConnector>,
    private readonly syncConfig: SyncConfigStore,
    private readonly cursors: ReplayCursorStore,
    private readonly sync: SyncEngine,
    private readonly activity?: ActivityLog,
    private readonly idMap?: IdMapStore,
  ) {}

  lastRun(type: CanonicalType): SyncPollerSummary | undefined {
    return this.lastRunByType.get(type);
  }

  /** Every object's most recent poll result, keyed by canonical type. */
  lastRuns(): Record<CanonicalType, SyncPollerSummary> {
    return Object.fromEntries(this.lastRunByType);
  }

  /** Up to the last 20 runs for one object, newest first. */
  history(type: CanonicalType): SyncPollerSummary[] {
    return this.historyByType.get(type) ?? [];
  }

  /** Every object's run history, keyed by canonical type. */
  histories(): Record<CanonicalType, SyncPollerSummary[]> {
    return Object.fromEntries(this.historyByType);
  }

  /** @param ensureReady  optional readiness hook (e.g. lazy live connector init), run before each cycle. */
  start(ensureReady?: () => Promise<void>): void {
    this.ensureReady = ensureReady;
    this.stopped = false;
    this.scheduleTick(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.ensureReady?.();
      const config = this.syncConfig.get();
      const now = Date.now();
      for (const type of Object.keys(config.objects)) {
        const pollingConfig = config.polling[type];
        if (!config.objects[type]?.enabled || !pollingConfig?.enabled) continue;
        const due = this.nextDueAt.get(type) ?? 0;
        if (now < due) continue;
        this.nextDueAt.set(type, computeNextDueAt(pollingConfig, now));
        void this.pollObject(type).catch((err) => {
          logger.error({ err, type }, 'scheduled sync poll failed');
        });
      }
    } catch (err) {
      logger.error({ err }, 'scheduled sync tick failed');
    } finally {
      this.scheduleTick(BASE_TICK_MS);
    }
  }

  /**
   * Polls one object (both directions) right now, regardless of its own schedule -- used by
   * the "Sync now" button. Only requires the object to be in scope (`objects[type].enabled`),
   * not that scheduled polling itself is turned on for it.
   */
  async runOnce(type: CanonicalType): Promise<SyncPollerSummary> {
    await this.ensureReady?.();
    return this.pollObject(type);
  }

  private async pollObject(type: CanonicalType): Promise<SyncPollerSummary> {
    if (this.runningTypes.has(type)) {
      return (
        this.lastRunByType.get(type) ?? {
          at: new Date().toISOString(),
          changed: 0,
          deleted: 0,
          errors: 0,
          errorMessages: [],
        }
      );
    }
    this.runningTypes.add(type);
    const summary: SyncPollerSummary = { at: new Date().toISOString(), changed: 0, deleted: 0, errors: 0, errorMessages: [] };
    try {
      const config = this.syncConfig.get();
      if (!config.objects[type]?.enabled) return summary;
      for (const system of ['salesforce', 'hubspot'] as SystemId[]) {
        if (!syncAllows(config, type, system)) continue;
        try {
          const result = await this.pollOne(system, type, config);
          summary.changed += result.changed;
          summary.deleted += result.deleted;
        } catch (err) {
          summary.errors += 1;
          const label = system === 'salesforce' ? 'Salesforce' : 'HubSpot';
          const message = friendlyErrorMessage(err, label);
          summary.errorMessages.push(`${label}: ${message}`);
          logger.error({ err, system, type, message }, 'scheduled sync poll failed for object');
        }
      }
      if (summary.changed || summary.deleted || summary.errors) {
        this.activity?.record({
          kind: summary.errors ? 'error' : 'info',
          message: summary.errors
            ? `Scheduled sync (${type}) failed: ${summary.errorMessages.join(' · ')}`
            : `Scheduled sync (${type}): ${summary.changed} change${summary.changed === 1 ? '' : 's'}, ${summary.deleted} deletion${summary.deleted === 1 ? '' : 's'} detected`,
        });
      }
    } finally {
      this.runningTypes.delete(type);
      this.lastRunByType.set(type, summary);
      const history = [summary, ...(this.historyByType.get(type) ?? [])].slice(0, SyncPoller.HISTORY_LIMIT);
      this.historyByType.set(type, history);
    }
    return summary;
  }

  private async pollOne(
    system: SystemId,
    type: CanonicalType,
    config: SyncConfig,
  ): Promise<{ changed: number; deleted: number }> {
    const connector = this.connectors[system];
    const stream = POLL_STREAM_PREFIX + type;
    const lookbackDays = config.polling[type]?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const since =
      (await this.cursors.get(system, stream)) ??
      new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    // Captured before paging starts so a record changed mid-poll isn't skipped next cycle.
    const pollStartedAt = new Date().toISOString();

    const objectConfig = config.objects[type];
    const condition: QueryCondition = {
      conditions: objectConfig?.conditions?.[system],
      rawCondition: objectConfig?.rawCondition?.[system],
    };

    const events: ChangeEvent[] = [];
    let changed = 0;
    let cursor: string | undefined;
    do {
      const page = await connector.list(type, cursor, since, condition);
      for (const record of page.records) {
        events.push({
          eventId: `poll:${system}:${type}:${record.meta.sourceId}:${record.meta.modifiedAt}`,
          system,
          type,
          sourceId: record.meta.sourceId,
          changeType: 'updated',
          occurredAt: record.meta.modifiedAt,
        });
      }
      changed += page.records.length;
      cursor = page.nextCursor;
    } while (cursor);

    // The recycle-bin/archive listing can't be condition-filtered (deleted records carry no
    // field values) -- when this native object also backs other canonical objects, only keep
    // a deletion that the id map actually links to THIS type, since only whichever poll cycle
    // matched the record's condition while it existed could ever have linked it.
    const nativeObject = requireNativeObjectName(system, type);
    const sharedNativeObject = canonicalObjectsFor(system, nativeObject).length > 1;
    const rawDeletions = await connector.listDeletedSince(type, since);
    const deletions = sharedNativeObject
      ? (
          await Promise.all(
            rawDeletions.map(async (deletion) => {
              const link = await this.idMap?.bySource(system, deletion.sourceId);
              return link && link.type !== type ? undefined : deletion;
            }),
          )
        ).filter((d): d is { sourceId: string; occurredAt: string } => Boolean(d))
      : rawDeletions;
    for (const deletion of deletions) {
      events.push({
        eventId: `poll:${system}:${type}:${deletion.sourceId}:deleted:${deletion.occurredAt}`,
        system,
        type,
        sourceId: deletion.sourceId,
        changeType: 'deleted',
        occurredAt: deletion.occurredAt,
      });
    }

    if (events.length) await this.sync.enqueue(events);
    await this.cursors.commit(system, stream, pollStartedAt);
    return { changed, deleted: deletions.length };
  }
}

function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return 30;
  return Math.min(MAX_POLLING_INTERVAL_MINUTES, Math.max(MIN_POLLING_INTERVAL_MINUTES, Math.round(minutes)));
}

/**
 * A cron expression, when set, decides the next due time instead of intervalMinutes -- it's
 * the only way to express "every Monday at 9am," which a plain repeating interval can't. Falls
 * back to the simple interval if the cron expression is missing or (shouldn't happen once
 * PATCH /api/sync/settings validates it, but the config could predate validation) unparseable.
 */
function computeNextDueAt(pollingConfig: { intervalMinutes: number; cron?: string }, now: number): number {
  if (pollingConfig.cron) {
    try {
      return nextCronOccurrences(pollingConfig.cron, new Date(now), 1)[0]!.getTime();
    } catch (err) {
      logger.warn({ err, cron: pollingConfig.cron }, 'invalid cron expression, falling back to interval');
    }
  }
  return now + clampInterval(pollingConfig.intervalMinutes) * 60_000;
}
