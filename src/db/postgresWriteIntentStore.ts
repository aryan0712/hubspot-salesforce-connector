import type { CanonicalType, FieldValue, SystemId } from '../core/types.js';
import type {
  IdentityLock,
  NewWriteIntent,
  WriteIntent,
  WriteIntentStatus,
  WriteIntentStore,
} from '../engine/writeIntents.js';
import { IdentityLockTimeoutError } from '../engine/writeIntents.js';
import type { PostgresDatabase } from './postgres.js';

interface IntentRow {
  operation_id: string;
  link_id: string;
  object_type: CanonicalType;
  system: SystemId;
  operation: 'create' | 'update';
  source_system: SystemId;
  source_id: string;
  target_id: string | null;
  natural_key: string | null;
  fields: Record<string, FieldValue>;
  payload: Record<string, FieldValue>;
  payload_hash: string;
  status: WriteIntentStatus;
  evidence: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const UNRESOLVED_SQL = `status IN ('pending', 'applied', 'uncertain', 'review')`;

export class PostgresWriteIntentStore implements WriteIntentStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async begin(intent: NewWriteIntent): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO write_intents(
           tenant_id, operation_id, link_id, object_type, system, operation, source_system,
           source_id, target_id, natural_key, fields, payload, payload_hash, operation_base
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          this.tenantId,
          intent.operationId,
          intent.linkId,
          intent.type,
          intent.system,
          intent.operation,
          intent.sourceSystem,
          intent.sourceId,
          intent.targetId ?? null,
          intent.naturalKey ?? null,
          JSON.stringify(intent.fields),
          JSON.stringify(intent.payload),
          intent.payloadHash,
          operationBase(intent.operationId),
        ],
      );
    });
  }

  async update(
    operationId: string,
    patch: { status: WriteIntentStatus; targetId?: string; evidence?: Record<string, unknown> },
  ): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE write_intents SET status = $3, target_id = coalesce($4, target_id),
                evidence = evidence || $5::jsonb, updated_at = now()
         WHERE tenant_id = $1 AND operation_id = $2`,
        [this.tenantId, operationId, patch.status, patch.targetId ?? null, JSON.stringify(patch.evidence ?? {})],
      );
      if (!result.rowCount) throw new Error(`write intent ${operationId} not found`);
    });
  }

  async get(operationId: string): Promise<WriteIntent | undefined> {
    return (await this.select('operation_id = $2', [operationId]))[0];
  }

  async unresolvedForSource(type: CanonicalType, sourceSystem: SystemId, sourceId: string): Promise<WriteIntent[]> {
    return this.select(
      `object_type = $2 AND source_system = $3 AND source_id = $4 AND ${UNRESOLVED_SQL}`,
      [type, sourceSystem, sourceId],
    );
  }

  async unresolvedForLink(linkId: string): Promise<WriteIntent[]> {
    return this.select(`link_id = $2 AND ${UNRESOLVED_SQL}`, [linkId]);
  }

  async listUnresolved(limit = 100): Promise<WriteIntent[]> {
    return this.select(UNRESOLVED_SQL, [], limit);
  }

  async forOperation(prefix: string): Promise<WriteIntent[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<IntentRow>(
        `SELECT * FROM write_intents
         -- "<base>:" prefixes (every deterministic id) hit the operation_base index.
         WHERE tenant_id = $1
           AND ($3::text IS NULL OR operation_base = $3)
           AND left(operation_id, length($2)) = $2
         ORDER BY created_at, operation_id`,
        [this.tenantId, prefix, prefix.endsWith(':') ? prefix.slice(0, -1) : null],
      );
      return result.rows.map(mapRow);
    });
  }

  private async select(where: string, params: unknown[], limit = 1000): Promise<WriteIntent[]> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<IntentRow>(
        `SELECT * FROM write_intents WHERE tenant_id = $1 AND ${where}
         ORDER BY created_at, operation_id LIMIT ${Math.max(1, Math.min(limit, 5000))}`,
        [this.tenantId, ...params],
      );
      return result.rows.map(mapRow);
    });
  }
}

/** Deterministic ids are "<base>:<system>:<n>:<nonce>"; the base identifies the item. */
function operationBase(operationId: string): string | null {
  const parts = operationId.split(':');
  return parts.length > 4 ? parts.slice(0, -3).join(':') : null;
}

function mapRow(row: IntentRow): WriteIntent {
  return {
    operationId: row.operation_id,
    linkId: row.link_id,
    type: row.object_type,
    system: row.system,
    operation: row.operation,
    sourceSystem: row.source_system,
    sourceId: row.source_id,
    targetId: row.target_id ?? undefined,
    naturalKey: row.natural_key ?? undefined,
    fields: row.fields,
    payload: row.payload,
    payloadHash: row.payload_hash,
    status: row.status,
    evidence: row.evidence,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Cross-process identity lock using PostgreSQL session advisory locks on one dedicated
 * connection per holder. Lock order: keys are sorted and acquired one by one, so holders
 * with overlapping keys cannot deadlock. Fencing: the locks live exactly as long as the
 * holder's connection -- a crashed worker's connection closes and its locks are released,
 * while a live holder keeps exclusivity for the whole read → write → link sequence.
 * Waiting is bounded (try-lock with a deadline) so a stuck holder turns into a retry, not a
 * pile-up of blocked workers.
 */
export class PostgresIdentityLock implements IdentityLock {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
    private readonly opts: { waitMs?: number; pollMs?: number } = {},
  ) {}

  async withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort().map((key) => `${this.tenantId}:${key}`);
    const client = await this.db.pool.connect();
    const held: string[] = [];
    try {
      const deadline = Date.now() + (this.opts.waitMs ?? 30_000);
      for (const key of ordered) {
        while (true) {
          const result = await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
            [key],
          );
          if (result.rows[0]?.locked) break;
          if (Date.now() > deadline) throw new IdentityLockTimeoutError(ordered);
          await new Promise((resolve) => setTimeout(resolve, this.opts.pollMs ?? 25));
        }
        held.push(key);
      }
      return await fn();
    } finally {
      for (const key of held.reverse()) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => undefined);
      }
      client.release();
    }
  }
}
