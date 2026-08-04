/**
 * A tiny in-memory activity log + running stats that the engines feed into, and the
 * dashboard reads from. Deliberately dependency-free: swap for a real event store /
 * time-series DB in production. Newest entries first; capped so it can't grow unbounded.
 */
export type ActivityKind =
  | 'migrate'
  | 'sync'
  | 'echo-suppressed'
  | 'conflict'
  | 'delete'
  | 'association'
  | 'error'
  | 'info';

export interface ActivityEntry {
  at: string;
  kind: ActivityKind;
  message: string;
}

export interface Stats {
  migrated: number;
  synced: number;
  echoesSuppressed: number;
  conflicts: number;
}

export class ActivityLog {
  private buf: ActivityEntry[] = [];
  private stats: Stats = { migrated: 0, synced: 0, echoesSuppressed: 0, conflicts: 0 };
  private sink?: {
    recordActivity(entry: ActivityEntry): Promise<void>;
    incrementUsage?(metric: string, quantity: number): Promise<void>;
  };

  attachSink(sink: {
    recordActivity(entry: ActivityEntry): Promise<void>;
    incrementUsage?(metric: string, quantity: number): Promise<void>;
  }): void {
    this.sink = sink;
  }

  record(entry: Omit<ActivityEntry, 'at'>): void {
    const complete = { at: new Date().toISOString(), ...entry };
    this.buf.unshift(complete);
    void this.sink?.recordActivity(complete).catch(() => {
      // Operational telemetry must never take the sync engine down.
    });
    if (this.buf.length > 200) this.buf.pop();
    if (entry.kind === 'sync') this.stats.synced += 1;
    else if (entry.kind === 'echo-suppressed') this.stats.echoesSuppressed += 1;
    else if (entry.kind === 'conflict') this.stats.conflicts += 1;
  }

  incMigrated(n: number): void {
    this.stats.migrated += n;
    void this.sink?.incrementUsage?.('records_migrated', n).catch(() => {
      // Usage telemetry is recoverable from migration runs.
    });
  }

  recent(n = 50): ActivityEntry[] {
    return this.buf.slice(0, n);
  }

  snapshot(): Stats {
    return { ...this.stats };
  }
}
