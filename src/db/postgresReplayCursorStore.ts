import type { ReplayCursorStore } from '../connectors/salesforce/cdcWorker.js';
import type { PostgresDatabase } from './postgres.js';

export class PostgresReplayCursorStore implements ReplayCursorStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly tenantId: string,
  ) {}

  async get(system: 'salesforce', stream: string): Promise<string | undefined> {
    return this.db.tenant(this.tenantId, async (client) => {
      const result = await client.query<{ replay_id: string }>(
        `SELECT replay_id FROM webhook_cursors
         WHERE tenant_id = $1 AND system = $2 AND stream_name = $3`,
        [this.tenantId, system, stream],
      );
      return result.rows[0]?.replay_id;
    });
  }

  async commit(system: 'salesforce', stream: string, replayId: string): Promise<void> {
    await this.db.tenant(this.tenantId, async (client) => {
      await client.query(
        `INSERT INTO webhook_cursors(tenant_id, system, stream_name, replay_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, system, stream_name) DO UPDATE SET
           replay_id = EXCLUDED.replay_id, committed_at = now()`,
        [this.tenantId, system, stream, replayId],
      );
    });
  }
}
