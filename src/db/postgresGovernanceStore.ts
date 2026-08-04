import type { GovernanceStore, ConflictRecord } from '../engine/governanceStore.js';
import type { ChangeEvent, SystemId } from '../core/types.js';
import type { PostgresDatabase } from './postgres.js';

export class PostgresGovernanceStore implements GovernanceStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async recordConflict(conflict: ConflictRecord): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO conflicts(
           tenant_id, link_id, object_type, source_snapshot, target_snapshot,
           strategy, resolution, status, resolved_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'resolved',now())`,
        [
          this.tenantId,
          conflict.linkId ?? null,
          conflict.type,
          JSON.stringify(conflict.source),
          JSON.stringify(conflict.target),
          conflict.strategy,
          JSON.stringify(conflict.resolution),
        ],
      );
    });
  }

  async recordDeletion(input: {
    jobId: string;
    event: ChangeEvent;
    targetSystem: SystemId;
    targetId?: string;
    policy: 'ignore' | 'cascade' | 'manual-review';
  }): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO deletion_requests(
           tenant_id, sync_event_id, source_system, object_type, source_id,
           target_id, policy, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, sync_event_id) WHERE sync_event_id IS NOT NULL
         DO UPDATE SET policy = EXCLUDED.policy`,
        [
          this.tenantId,
          input.jobId,
          input.event.system,
          input.event.type,
          input.event.sourceId,
          input.targetId ?? null,
          input.policy,
          input.policy === 'cascade' ? 'completed' : 'pending',
        ],
      );
    });
  }

  async completeDeletion(jobId: string, actorId?: string): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `UPDATE deletion_requests SET status = 'completed', reviewed_by = $3,
                reviewed_at = now()
         WHERE tenant_id = $1 AND sync_event_id = $2`,
        [this.tenantId, jobId, actorId ?? null],
      );
    });
  }
}
