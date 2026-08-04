import crypto from 'node:crypto';
import type { CRMConnector, ConnectorAssociation } from '../core/connector.js';
import type { CanonicalRecord, SystemId } from '../core/types.js';
import type { IdMapStore } from '../core/idMap.js';
import type { ActivityLog } from '../observability/activity.js';

export interface AssociationLink {
  id: string;
  fromCanonicalId: string;
  toCanonicalId: string;
  kind: string;
  label?: string;
}

export interface AssociationStore {
  upsert(link: AssociationLink): Promise<void>;
}

export class InMemoryAssociationStore implements AssociationStore {
  private links = new Map<string, AssociationLink>();
  async upsert(link: AssociationLink): Promise<void> {
    this.links.set(link.id, { ...link });
  }
}

export class AssociationEngine {
  constructor(
    private readonly connectors: Record<SystemId, CRMConnector>,
    private readonly idMap: IdMapStore,
    private readonly store: AssociationStore,
    private readonly activity?: ActivityLog,
  ) {}

  async syncRecord(source: CanonicalRecord): Promise<{ synced: number; deferred: number }> {
    const from = source.meta.source;
    const to: SystemId = from === 'salesforce' ? 'hubspot' : 'salesforce';
    const fromLink = await this.idMap.bySource(from, source.meta.sourceId);
    const targetFromId = fromLink?.ids[to];
    if (!fromLink || !targetFromId) return { synced: 0, deferred: 0 };

    const associations = await this.connectors[from].listAssociations(
      source.type,
      source.meta.sourceId,
    );
    let synced = 0;
    let deferred = 0;
    for (const association of associations) {
      const relatedLink = await this.idMap.bySource(from, association.toId);
      const targetToId = relatedLink?.ids[to];
      if (!relatedLink || !targetToId) {
        deferred += 1;
        continue;
      }
      const targetAssociation: ConnectorAssociation = {
        ...association,
        toId: targetToId,
      };
      await this.connectors[to].associate(source.type, targetFromId, targetAssociation);
      const id = stableAssociationId(
        fromLink.canonicalId,
        relatedLink.canonicalId,
        association.kind,
        association.label,
      );
      await this.store.upsert({
        id,
        fromCanonicalId: fromLink.canonicalId,
        toCanonicalId: relatedLink.canonicalId,
        kind: association.kind,
        label: association.label,
      });
      synced += 1;
    }
    if (synced) {
      this.activity?.record({
        kind: 'association',
        message: `Synced ${synced} ${source.type} relationship${synced === 1 ? '' : 's'}`,
      });
    }
    return { synced, deferred };
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
