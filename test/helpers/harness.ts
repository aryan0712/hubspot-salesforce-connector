import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { CRMConnector } from '../../src/core/connector.js';
import type { SystemId } from '../../src/core/types.js';
import type { ConflictStrategy } from '../../src/core/conflict.js';
import { MockConnector } from '../../src/connectors/mock/mockConnector.js';
import { FileIdMapStore, type IdMapStore } from '../../src/core/idMap.js';
import { ConfigContext, createDefaultConfigContext } from '../../src/core/configContext.js';
import { Reconciler } from '../../src/engine/reconciler.js';
import { MigrationEngine } from '../../src/engine/migrationEngine.js';
import { InMemoryMigrationStore, type MigrationStore } from '../../src/engine/migrationStore.js';
import {
  InMemoryMigrationPlanStore,
  type MigrationPlanStore,
} from '../../src/engine/migrationPlanStore.js';
import { InMemoryExecutionStore, type ExecutionStore } from '../../src/engine/executionStore.js';
import { MigrationService } from '../../src/engine/migrationService.js';
import type { MigrationWorkerOptions } from '../../src/engine/migrationWorker.js';
import { PreflightService } from '../../src/engine/preflight.js';
import type { PostgresDatabase } from '../../src/db/postgres.js';
import { PostgresMigrationStore } from '../../src/db/postgresMigrationStore.js';
import { PostgresMigrationPlanStore } from '../../src/db/postgresMigrationPlanStore.js';
import { PostgresExecutionStore } from '../../src/db/postgresExecutionStore.js';
import { PostgresIdMapStore } from '../../src/db/postgresIdMapStore.js';
import {
  InMemoryIdentityLock,
  InMemoryWriteIntentStore,
  type IdentityLock,
  type WriteIntentStore,
} from '../../src/engine/writeIntents.js';
import { PostgresIdentityLock, PostgresWriteIntentStore } from '../../src/db/postgresWriteIntentStore.js';

/** The two mock CRMs; share one pair across harnesses to model separate app processes. */
export interface MockCrms {
  sf: MockConnector;
  hs: MockConnector;
  connectors: Record<SystemId, CRMConnector>;
}

export function mockCrms(config: ConfigContext): MockCrms {
  const sf = new MockConnector('salesforce', config);
  const hs = new MockConnector('hubspot', config);
  return { sf, hs, connectors: { salesforce: sf, hubspot: hs } };
}

export interface Harness extends MockCrms {
  config: ConfigContext;
  idMap: IdMapStore;
  reconciler: Reconciler;
  engine: MigrationEngine;
  service: MigrationService;
  plans: MigrationPlanStore;
  executions: ExecutionStore;
  runs: MigrationStore;
  intents: WriteIntentStore;
  locks: IdentityLock;
  /** Mutable conflict settings the reconciler reads on every plan. */
  conflict: { strategy: ConflictStrategy; sourceOfTruth: SystemId };
}

export async function buildHarness(opts: {
  config?: ConfigContext;
  crms?: MockCrms;
  postgres?: { db: PostgresDatabase; tenantId: string };
  limits?: Record<string, number>;
  searchVisibilityMs?: number;
  worker?: MigrationWorkerOptions;
  /** Keep the file-backed id map purely in memory (large synthetic runs). */
  idMapInMemory?: boolean;
} = {}): Promise<Harness> {
  const config = opts.config ?? createDefaultConfigContext('harness');
  const crms = opts.crms ?? mockCrms(config);
  const conflict = { strategy: 'last-write-wins' as ConflictStrategy, sourceOfTruth: 'salesforce' as SystemId };
  let idMap: IdMapStore;
  let runs: MigrationStore;
  let plans: MigrationPlanStore;
  let executions: ExecutionStore;
  let intents: WriteIntentStore;
  let locks: IdentityLock;
  if (opts.postgres) {
    const { db, tenantId } = opts.postgres;
    idMap = new PostgresIdMapStore(db, tenantId);
    runs = new PostgresMigrationStore(db, tenantId);
    plans = new PostgresMigrationPlanStore(db, tenantId);
    executions = new PostgresExecutionStore(db, tenantId);
    intents = new PostgresWriteIntentStore(db, tenantId);
    locks = new PostgresIdentityLock(db, tenantId);
  } else {
    intents = new InMemoryWriteIntentStore();
    locks = new InMemoryIdentityLock();
    idMap = new FileIdMapStore(
      opts.idMapInMemory ? null : path.join(os.tmpdir(), `idmap-harness-${crypto.randomUUID()}.json`),
    );
    runs = new InMemoryMigrationStore();
    const memoryPlans = new InMemoryMigrationPlanStore();
    plans = memoryPlans;
    executions = new InMemoryExecutionStore(memoryPlans, opts.limits);
  }
  await idMap.init();
  const reconciler = new Reconciler(crms.connectors, idMap, config, {
    conflictOptions: () => ({ ...conflict }),
    intents,
    locks,
    searchVisibilityMs: opts.searchVisibilityMs,
  });
  const engine = new MigrationEngine(crms.connectors, config, reconciler, undefined, runs);
  const preflight = new PreflightService(crms.connectors, config);
  const service = new MigrationService(engine, preflight, executions, plans, {
    connectors: crms.connectors,
    config,
    idMap,
    reconciler,
    worker: opts.worker,
  });
  return { ...crms, config, idMap, reconciler, engine, service, plans, executions, runs, intents, locks, conflict };
}

export const OLD = '2020-01-01T00:00:00.000Z';
export const NEW = '2025-01-01T00:00:00.000Z';
