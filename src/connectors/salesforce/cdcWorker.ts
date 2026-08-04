import type { ChangeEvent } from '../../core/types.js';
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

export interface ReplayCursorStore {
  get(system: 'salesforce', stream: string): Promise<string | undefined>;
  commit(system: 'salesforce', stream: string, replayId: string): Promise<void>;
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
