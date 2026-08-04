import { describe, expect, it } from 'vitest';
import type { CRMConnector } from '../src/core/connector.js';
import { configureNaturalKeyFields } from '../src/core/idMap.js';
import type { SystemId } from '../src/core/types.js';
import { MockConnector } from '../src/connectors/mock/mockConnector.js';
import { PreflightService } from '../src/engine/preflight.js';

describe('natural-key preflight profiling', () => {
  it('warns about missing source identities and blocks duplicate destination identities', async () => {
    configureNaturalKeyFields('company', ['domain']);
    const salesforce = new MockConnector('salesforce');
    const hubspot = new MockConnector('hubspot');
    salesforce.seed('company', { name: 'No domain' });
    salesforce.seed('company', { name: 'Unique', domain: 'unique.test' });
    hubspot.seed('company', { name: 'First duplicate', domain: 'duplicate.test' });
    hubspot.seed('company', { name: 'Second duplicate', domain: 'duplicate.test' });
    const connectors: Record<SystemId, CRMConnector> = { salesforce, hubspot };

    const report = await new PreflightService(connectors).run('salesforce', 'company');

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NATURAL_KEY_MISSING_VALUES', severity: 'warning' }),
      expect.objectContaining({ code: 'TARGET_NATURAL_KEY_DUPLICATES', severity: 'error' }),
    ]));
    expect(report.ok).toBe(false);
  });
});
