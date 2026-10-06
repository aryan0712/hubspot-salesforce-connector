import crypto from 'node:crypto';
import { UnsupportedAssociationError, type CRMConnector, type ConnectorAssociation } from '../core/connector.js';
import type { CanonicalRecord, CanonicalType, SystemId } from '../core/types.js';

// Re-exported for callers that historically imported it from here; it is a core contract
// error (thrown by connectors), defined in src/core/connector.ts.
export { UnsupportedAssociationError };
import type { IdMapStore } from '../core/idMap.js';
import type { ActivityLog } from '../observability/activity.js';
import { logger } from '../logger.js';

export interface AssociationLink {
  id: string;
  fromCanonicalId: string;
  toCanonicalId: string;
  kind: string;
  label?: string;
}

/** A relationship read from the source system that could not be written yet (or ever). */
export interface PendingAssociation {
  id: string;
  /** The system the relationship was read from. */
  system: SystemId;
  fromType: CanonicalType;
  fromSourceId: string;
  toType: CanonicalType;
  toSourceId: string;
  kind: string;
  label?: string;
  status: 'pending' | 'resolved' | 'unsupported' | 'failed';
  attempts: number;
  lastError?: string;
  createdAt: string;
}

export type NewPendingAssociation = Omit<PendingAssociation, 'id' | 'status' | 'attempts' | 'createdAt' | 'lastError'>;

export interface AssociationStore {
  upsert(link: AssociationLink): Promise<void>;
  /** Persists a deferred relationship (idempotent on its identity); returns its id. */
  defer(pending: NewPendingAssociation): Promise<string>;
  /** Pending relationships where this record is either end. */
  pendingFor(system: SystemId, type: CanonicalType, sourceId: string): Promise<PendingAssociation[]>;
  mark(id: string, status: PendingAssociation['status'], error?: string): Promise<void>;
  listPending(limit?: number, status?: PendingAssociation['status']): Promise<PendingAssociation[]>;
}

export class InMemoryAssociationStore implements AssociationStore {
  private links = new Map<string, AssociationLink>();
  private pending = new Map<string, PendingAssociation>();

  async upsert(link: AssociationLink): Promise<void> {
    this.links.set(link.id, { ...link });
  }

  async defer(input: NewPendingAssociation): Promise<string> {
    const key = pendingKey(input);
    const existing = this.pending.get(key);
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.pending.set(key, {
      ...input,
      id,
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  async pendingFor(system: SystemId, type: CanonicalType, sourceId: string): Promise<PendingAssociation[]> {
    return [...this.pending.values()]
      .filter(
        (item) =>
          item.status === 'pending' &&
          item.system === system &&
          ((item.fromType === type && item.fromSourceId === sourceId) ||
            (item.toType === type && item.toSourceId === sourceId)),
      )
      .map((item) => ({ ...item }));
  }

  async mark(id: string, status: PendingAssociation['status'], error?: string): Promise<void> {
    for (const item of this.pending.values()) {
      if (item.id !== id) continue;
      item.status = status;
      item.attempts += 1;
      item.lastError = error;
    }
  }

  async listPending(limit = 100, status?: PendingAssociation['status']): Promise<PendingAssociation[]> {
    return [...this.pending.values()]
      .filter((item) => !status || item.status === status)
      .slice(0, limit)
      .map((item) => ({ ...item }));
  }

  /** Test helper. */
  count(): number {
    return this.links.size;
  }
}

function pendingKey(item: NewPendingAssociation): string {
  return [item.system, item.fromType, item.fromSourceId, item.toType, item.toSourceId, item.kind, item.label ?? ''].join('|');
}

/**
 * Propagates relationships in live sync (migration is record-only, see R10 in the plan):
 *  - a relationship whose related record is linked is written to the destination;
 *  - one whose related record is not linked yet is persisted as pending and retried when
 *    that record (or this one) is reconciled later -- no new edit needed;
 *  - one the destination cannot represent is recorded as unsupported for operator reporting.
 * Relationships are additive: removing one in the source does not remove it in the
 * destination, and single-valued parent lookups (e.g. Contact.AccountId) are replaced.
 */
export class AssociationEngine {
  constructor(
    private readonly connectors: Record<SystemId, CRMConnector>,
    private readonly idMap: IdMapStore,
    private readonly store: AssociationStore,
    private readonly activity?: ActivityLog,
  ) {}

  async syncRecord(source: CanonicalRecord): Promise<{ synced: number; deferred: number; unsupported: number }> {
    const from = source.meta.source;
    const associations = await this.connectors[from].listAssociations(source.type, source.meta.sourceId);
    let synced = 0;
    let deferred = 0;
    let unsupported = 0;
    for (const association of associations) {
      const outcome = await this.write(from, source.type, source.meta.sourceId, association);
      if (outcome === 'synced') synced += 1;
      else if (outcome === 'unsupported') unsupported += 1;
      else deferred += 1;
    }
    const retried = await this.retryPendingFor(from, source.type, source.meta.sourceId);
    synced += retried;
    if (synced) {
      this.activity?.record({
        kind: 'association',
        message: `Synced ${synced} ${source.type} relationship${synced === 1 ? '' : 's'}`,
      });
    }
    return { synced, deferred, unsupported };
  }

  /** Retries pending relationships touching this record now that it may be linked. */
  async retryPendingFor(system: SystemId, type: CanonicalType, sourceId: string): Promise<number> {
    let resolved = 0;
    for (const pending of await this.store.pendingFor(system, type, sourceId)) {
      const outcome = await this.write(pending.system, pending.fromType, pending.fromSourceId, {
        toType: pending.toType,
        toId: pending.toSourceId,
        kind: pending.kind,
        label: pending.label,
      }, pending.id);
      if (outcome === 'synced') resolved += 1;
    }
    return resolved;
  }

  async listPending(limit?: number, status?: PendingAssociation['status']): Promise<PendingAssociation[]> {
    return this.store.listPending(limit, status);
  }

  private async write(
    from: SystemId,
    fromType: CanonicalType,
    fromSourceId: string,
    association: ConnectorAssociation,
    pendingId?: string,
  ): Promise<'synced' | 'deferred' | 'unsupported'> {
    const to: SystemId = from === 'salesforce' ? 'hubspot' : 'salesforce';
    const fromLink = await this.idMap.bySource(from, fromSourceId, fromType);
    const relatedLink = await this.idMap.bySource(from, association.toId, association.toType);
    const targetFromId = fromLink?.ids[to];
    const targetToId = relatedLink?.ids[to];
    if (!fromLink || !relatedLink || !targetFromId || !targetToId) {
      if (!pendingId) {
        await this.store.defer({
          system: from,
          fromType,
          fromSourceId,
          toType: association.toType,
          toSourceId: association.toId,
          kind: association.kind,
          label: association.label,
        });
      }
      return 'deferred';
    }
    try {
      await this.connectors[to].associate(fromType, targetFromId, { ...association, toId: targetToId });
    } catch (err) {
      if (err instanceof UnsupportedAssociationError) {
        const id = pendingId ?? await this.store.defer({
          system: from,
          fromType,
          fromSourceId,
          toType: association.toType,
          toSourceId: association.toId,
          kind: association.kind,
          label: association.label,
        });
        await this.store.mark(id, 'unsupported', err.message);
        logger.warn({ fromType, toType: association.toType, err: err.message }, 'relationship not supported by destination');
        return 'unsupported';
      }
      throw err;
    }
    await this.store.upsert({
      id: stableAssociationId(fromLink.canonicalId, relatedLink.canonicalId, association.kind, association.label),
      fromCanonicalId: fromLink.canonicalId,
      toCanonicalId: relatedLink.canonicalId,
      kind: association.kind,
      label: association.label,
    });
    if (pendingId) await this.store.mark(pendingId, 'resolved');
    return 'synced';
  }
}

function stableAssociationId(from: string, to: string, kind: string, label?: string): string {
  const hex = crypto
    .createHash('sha256')
    .update(`${from}:${to}:${kind}:${label ?? ''}`)
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
