import axios from 'axios';
import type { CanonicalType, FieldValue, SystemId } from '../core/types.js';

/**
 * R06 -- recoverable writes.
 *
 * A WriteIntent is recorded BEFORE every CRM mutation the reconciler performs and moves
 * through pending → applied → committed. Whatever happens in between (process crash, lost
 * vendor response, database failure after the vendor accepted the write) leaves a durable
 * trace, and the next reconcile of the same record recovers from it instead of repeating
 * a create. Generic CRM create APIs are NOT assumed to be exactly-once.
 *
 * Linking is serialized with IdentityLock: every reconcile of a record holds the locks for
 * its source identity and its normalised natural key, so two workers (or the two sync
 * directions) can never both decide "no counterpart exists" and create twice.
 */
export type WriteIntentStatus = 'pending' | 'applied' | 'committed' | 'uncertain' | 'abandoned' | 'review';

export interface WriteIntent {
  operationId: string;
  linkId: string;
  type: CanonicalType;
  /** The system being written. */
  system: SystemId;
  operation: 'create' | 'update';
  sourceSystem: SystemId;
  sourceId: string;
  /** Known for updates; filled in for creates once the vendor returns an id. */
  targetId?: string;
  naturalKey?: string;
  /** Canonical values written (used to recognise the outcome during recovery). */
  fields: Record<string, FieldValue>;
  payload: Record<string, FieldValue>;
  payloadHash: string;
  status: WriteIntentStatus;
  evidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type NewWriteIntent = Omit<WriteIntent, 'status' | 'evidence' | 'createdAt' | 'updatedAt'>;

export interface WriteIntentStore {
  /** Records the intent as pending. Must be durable before the vendor call is made. */
  begin(intent: NewWriteIntent): Promise<void>;
  update(
    operationId: string,
    patch: { status: WriteIntentStatus; targetId?: string; evidence?: Record<string, unknown> },
  ): Promise<void>;
  get(operationId: string): Promise<WriteIntent | undefined>;
  /** Unresolved (pending/applied/uncertain/review) intents for one source record. */
  unresolvedForSource(type: CanonicalType, sourceSystem: SystemId, sourceId: string): Promise<WriteIntent[]>;
  /** Unresolved intents writing to any side of one link (covers write-backs). */
  unresolvedForLink(linkId: string): Promise<WriteIntent[]>;
  /** Oldest unresolved intents first, for operator views and sweeps. */
  listUnresolved(limit?: number): Promise<WriteIntent[]>;
  /** Every intent (any status) whose operation id starts with this prefix, oldest first. */
  forOperation(prefix: string): Promise<WriteIntent[]>;
}

export const UNRESOLVED: WriteIntentStatus[] = ['pending', 'applied', 'uncertain', 'review'];

export class InMemoryWriteIntentStore implements WriteIntentStore {
  private intents = new Map<string, WriteIntent>();
  /** Indexes so lookups stay O(1) per record on large runs. */
  private bySource = new Map<string, Set<string>>();
  private byLink = new Map<string, Set<string>>();
  private byBase = new Map<string, Set<string>>();

  async begin(intent: NewWriteIntent): Promise<void> {
    if (this.intents.has(intent.operationId)) throw new Error(`write intent ${intent.operationId} already exists`);
    const now = new Date().toISOString();
    this.intents.set(intent.operationId, structuredClone({ ...intent, status: 'pending', evidence: {}, createdAt: now, updatedAt: now }));
    index(this.bySource, sourceKey(intent.type, intent.sourceSystem, intent.sourceId), intent.operationId);
    index(this.byLink, intent.linkId, intent.operationId);
    const parts = intent.operationId.split(':');
    if (parts.length > 4) index(this.byBase, parts.slice(0, -3).join(':'), intent.operationId);
  }

  async update(
    operationId: string,
    patch: { status: WriteIntentStatus; targetId?: string; evidence?: Record<string, unknown> },
  ): Promise<void> {
    const intent = this.intents.get(operationId);
    if (!intent) throw new Error(`write intent ${operationId} not found`);
    intent.status = patch.status;
    if (patch.targetId) intent.targetId = patch.targetId;
    if (patch.evidence) intent.evidence = { ...intent.evidence, ...patch.evidence };
    intent.updatedAt = new Date().toISOString();
  }

  async get(operationId: string): Promise<WriteIntent | undefined> {
    const intent = this.intents.get(operationId);
    return intent ? structuredClone(intent) : undefined;
  }

  async unresolvedForSource(type: CanonicalType, sourceSystem: SystemId, sourceId: string): Promise<WriteIntent[]> {
    return this.fromIds(this.bySource.get(sourceKey(type, sourceSystem, sourceId)));
  }

  async unresolvedForLink(linkId: string): Promise<WriteIntent[]> {
    return this.fromIds(this.byLink.get(linkId));
  }

  private fromIds(ids: Set<string> | undefined): WriteIntent[] {
    return [...(ids ?? [])]
      .map((id) => this.intents.get(id)!)
      .filter((intent) => UNRESOLVED.includes(intent.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((intent) => structuredClone(intent));
  }

  async listUnresolved(limit = 100): Promise<WriteIntent[]> {
    return (await this.filter(() => true)).slice(0, limit);
  }

  async forOperation(prefix: string): Promise<WriteIntent[]> {
    // Deterministic ids are "<base>:<system>:<n>:<nonce>"; a "<base>:" prefix is an index hit.
    const candidates = prefix.endsWith(':')
      ? [...(this.byBase.get(prefix.slice(0, -1)) ?? [])].map((id) => this.intents.get(id)!)
      : [...this.intents.values()];
    return candidates
      .filter((intent) => intent.operationId.startsWith(prefix))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((intent) => structuredClone(intent));
  }

  /** Test helper: every intent, in creation order. */
  all(): WriteIntent[] {
    return [...this.intents.values()].map((intent) => structuredClone(intent));
  }

  private async filter(predicate: (intent: WriteIntent) => boolean): Promise<WriteIntent[]> {
    return [...this.intents.values()]
      .filter((intent) => UNRESOLVED.includes(intent.status) && predicate(intent))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((intent) => structuredClone(intent));
  }
}

function sourceKey(type: CanonicalType, system: SystemId, sourceId: string): string {
  return `${type}|${system}|${sourceId}`;
}

function index(map: Map<string, Set<string>>, key: string, id: string): void {
  let ids = map.get(key);
  if (!ids) {
    ids = new Set();
    map.set(key, ids);
  }
  ids.add(id);
}

/**
 * Serializes work on record identities. Keys are acquired in sorted order (the documented
 * lock order), so two holders needing overlapping key sets can never deadlock. A holder
 * that dies releases its locks with its connection (Postgres session advisory locks), so a
 * crashed worker can never fence out the next one indefinitely.
 */
export interface IdentityLock {
  withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T>;
}

/** Lock could not be acquired within the wait budget; the caller should retry later. */
export class IdentityLockTimeoutError extends Error {
  constructor(keys: string[]) {
    super(`record identity is busy (${keys.join(', ')}); retry later`);
    this.name = 'IdentityLockTimeoutError';
  }
}

/** Single-process lock: a promise chain per key. */
export class InMemoryIdentityLock implements IdentityLock {
  private tails = new Map<string, Promise<void>>();

  async withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const releases: (() => void)[] = [];
    try {
      for (const key of ordered) {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        const tail = previous.then(() => current);
        this.tails.set(key, tail);
        await previous;
        releases.push(() => {
          release();
          if (this.tails.get(key) === tail) this.tails.delete(key);
        });
      }
      return await fn();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }
}

/**
 * The outcome of a failed vendor mutation is unknown when no response arrived (timeout,
 * reset, DNS) or the vendor answered 5xx after possibly applying it. A 4xx is a definite
 * rejection: nothing was written.
 */
export function isUncertainOutcome(err: unknown): boolean {
  if (axios.isAxiosError(err)) {
    if (!err.response) return true;
    return err.response.status >= 500;
  }
  const code = (err as { code?: string } | undefined)?.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN'].includes(code ?? '');
}

/** A write's outcome is unknown; sync retries later (recovering first), migration stops. */
export class UncertainWriteError extends Error {
  constructor(message: string, readonly operationId: string) {
    super(message);
    this.name = 'UncertainWriteError';
  }
}
