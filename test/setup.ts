import { beforeEach } from 'vitest';
import { applyDefaultObjects } from '../src/core/defaultObjects.js';

/**
 * The built-in contact/company/deal objects are no longer hardcoded into core/mapping.ts —
 * they're seed data (src/core/defaultObjects.ts) applied at runtime. Tests that construct
 * MockConnector/Reconciler/etc. directly (without going through createApp's Postgres path)
 * need that same seed data applied before each test, mirroring what createApp does via
 * PostgresObjectMappingStore/PostgresMappingStore or FileMappingStore in the real app.
 */
beforeEach(async () => {
  await applyDefaultObjects();
});
