/**
 * R14 operational metrics in the Prometheus text format (no dependency). Counters and
 * histograms are recorded as things happen; gauges are collected at scrape time from the
 * live system (queues, backlog, circuits, pool). Label values are bounded: route patterns,
 * status codes, systems, reasons and workspace ids -- never record ids or user input.
 */
type Labels = Record<string, string | number>;

interface Sample {
  name: string;
  labels?: Labels;
  value: number;
}

function key(labels: Labels = {}): string {
  return JSON.stringify(Object.keys(labels).sort().map((name) => [name, String(labels[name])]));
}

function formatLabels(labels: Labels = {}): string {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  const body = entries
    .map(([name, value]) => `${name}="${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join(',');
  return `{${body}}`;
}

export class Counter {
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}

  inc(labels: Labels = {}, amount = 1): void {
    const k = key(labels);
    const entry = this.values.get(k) ?? { labels, value: 0 };
    entry.value += amount;
    this.values.set(k, entry);
  }

  value(labels: Labels = {}): number {
    return this.values.get(key(labels))?.value ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    return lines.join('\n');
  }
}

export class Histogram {
  private series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ) {}

  observe(labels: Labels, value: number): void {
    const k = key(labels);
    const entry = this.series.get(k) ?? { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((bound, index) => {
      if (value <= bound) entry.counts[index]! += 1;
    });
    entry.sum += value;
    entry.count += 1;
    this.series.set(k, entry);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, count } of this.series.values()) {
      this.buckets.forEach((bound, index) =>
        lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: bound })} ${counts[index]}`),
      );
      lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${count}`);
      lines.push(`${this.name}_sum${formatLabels(labels)} ${sum}`);
      lines.push(`${this.name}_count${formatLabels(labels)} ${count}`);
    }
    return lines.join('\n');
  }
}

export type GaugeCollector = () => Promise<{ name: string; help: string; samples: Omit<Sample, 'name'>[] }[]>;

export class MetricsRegistry {
  private counters: Counter[] = [];
  private histograms: Histogram[] = [];
  private collectors: GaugeCollector[] = [];

  counter(name: string, help: string): Counter {
    const counter = new Counter(name, help);
    this.counters.push(counter);
    return counter;
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    const histogram = new Histogram(name, help, buckets);
    this.histograms.push(histogram);
    return histogram;
  }

  collect(collector: GaugeCollector): () => void {
    this.collectors.push(collector);
    return () => {
      this.collectors = this.collectors.filter((item) => item !== collector);
    };
  }

  async render(): Promise<string> {
    const blocks = [...this.counters.map((c) => c.render()), ...this.histograms.map((h) => h.render())];
    const gauges = new Map<string, { help: string; lines: string[] }>();
    for (const collector of this.collectors) {
      for (const family of await collector().catch(() => [])) {
        const entry = gauges.get(family.name) ?? { help: family.help, lines: [] };
        for (const sample of family.samples) entry.lines.push(`${family.name}${formatLabels(sample.labels)} ${sample.value}`);
        gauges.set(family.name, entry);
      }
    }
    for (const [name, { help, lines }] of gauges) {
      blocks.push([`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...lines].join('\n'));
    }
    return `${blocks.join('\n')}\n`;
  }
}

/** Process-wide registry and the event counters recorded across the codebase. */
export const metrics = new MetricsRegistry();
export const httpRequests = metrics.counter('crm_sync_http_requests_total', 'HTTP requests by method, route and status.');
export const httpDuration = metrics.histogram('crm_sync_http_request_duration_seconds', 'HTTP request latency by method and route.');
export const authFailures = metrics.counter('crm_sync_auth_failures_total', 'Rejected authentication attempts by reason.');
export const webhookOutcomes = metrics.counter('crm_sync_webhook_deliveries_total', 'Webhook deliveries by system and outcome.');
export const migrationRefusals = metrics.counter(
  'crm_sync_migration_refusals_total',
  'Migration writes refused before touching a CRM (drift, invalidated approval, ...), by reason.',
);
