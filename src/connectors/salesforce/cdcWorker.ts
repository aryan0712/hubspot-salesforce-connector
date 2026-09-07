import type { ChangeEvent, SystemId } from '../../core/types.js';
import type { SyncEngine } from '../../engine/syncEngine.js';
import { logger } from '../../logger.js';

export interface CdcEnvelope {
  replayId: string;
  event: ChangeEvent;
}

export interface SalesforceCdcTransport {
  subscribe(
    topic: string,
    afterReplayId: string | undefined,
    signal: AbortSignal,
  ): AsyncIterable<CdcEnvelope>;
}

/**
 * Persists an opaque per-(system, stream) cursor. Originally Salesforce Pub/Sub replay ids
 * only; the scheduled sync poller (see engine/syncPoller.ts) reuses this same store/table
 * for both systems, storing an ISO "last polled at" timestamp as the cursor value instead.
 */
export interface ReplayCursorStore {
  get(system: SystemId, stream: string): Promise<string | undefined>;
  commit(system: SystemId, stream: string, replayId: string): Promise<void>;
}

/** In-memory ReplayCursorStore for mock mode / tests — mirrors the other InMemory*Store stand-ins. */
export class InMemoryReplayCursorStore implements ReplayCursorStore {
  private cursors = new Map<string, string>();

  async get(system: SystemId, stream: string): Promise<string | undefined> {
    return this.cursors.get(`${system}:${stream}`);
  }

  async commit(system: SystemId, stream: string, replayId: string): Promise<void> {
    this.cursors.set(`${system}:${stream}`, replayId);
  }
}

/**
 * Orchestrates Salesforce Pub/Sub API consumption without coupling the engine to gRPC or
 * Avro. A transport adapter owns authentication/deserialization; this worker persists an
 * event before committing its Replay ID, giving at-least-once delivery with idempotency.
 */
export class SalesforceCdcWorker {
  private controller?: AbortController;

  constructor(
    private readonly transport: SalesforceCdcTransport,
    private readonly cursors: ReplayCursorStore,
    private readonly sync: SyncEngine,
  ) {}

  start(topics: string[]): void {
    if (this.controller) throw new Error('Salesforce CDC worker already running');
    this.controller = new AbortController();
    for (const topic of topics) void this.consume(topic, this.controller.signal);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  private async consume(topic: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const cursor = await this.cursors.get('salesforce', topic);
        for await (const envelope of this.transport.subscribe(topic, cursor, signal)) {
          if (signal.aborted) break;
          await this.sync.enqueue([
            { ...envelope.event, eventId: `sf-cdc:${topic}:${envelope.replayId}` },
          ]);
          await this.cursors.commit('salesforce', topic, envelope.replayId);
        }
      } catch (err) {
        if (signal.aborted) return;
        logger.error({ err, topic }, 'Salesforce CDC stream disconnected');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}
