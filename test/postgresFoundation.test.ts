import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SecretCipher } from '../src/db/security.js';

describe('PostgreSQL product foundation', () => {
  it('encrypts secrets with randomized authenticated ciphertext', () => {
    const cipher = new SecretCipher('a-unique-development-key-that-is-long-enough');
    const first = cipher.encrypt('refresh-token', 'tenant:hubspot:refresh');
    const second = cipher.encrypt('refresh-token', 'tenant:hubspot:refresh');
    expect(first).not.toContain('refresh-token');
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first, 'tenant:hubspot:refresh')).toBe('refresh-token');
    expect(() => cipher.decrypt(first, 'wrong-context')).toThrow();
  });

  it('defines tenant-scoped tables for every durable product concern', async () => {
    const migrations = (
      await Promise.all(
        [
          '001_initial.sql',
          '002_metadata_and_governance.sql',
          '005_ai_provider_credentials.sql',
          '006_field_mapping_sets.sql',
        ].map((file) =>
          fs.readFile(path.resolve('db/migrations', file), 'utf8'),
        ),
      )
    ).join('\n');
    for (const table of [
      'crm_connections',
      'oauth_app_credentials',
      'field_mappings',
      'record_links',
      'record_associations',
      'migration_runs',
      'migration_items',
      'sync_events',
      'conflicts',
      'audit_entries',
      'usage_counters',
      'subscriptions',
      'schema_snapshots',
      'deletion_requests',
      'ai_provider_credentials',
      'field_mapping_sets',
    ]) {
      expect(migrations).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migrations).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migrations).toContain('FORCE ROW LEVEL SECURITY');
  });
});
