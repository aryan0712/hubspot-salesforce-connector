import os from 'node:os';
import path from 'node:path';
import type { CRMConnector } from './core/connector.js';
import type { SystemId } from './core/types.js';
import { FileIdMapStore, type IdMapStore } from './core/idMap.js';
import { SalesforceConnector } from './connectors/salesforce/salesforceConnector.js';
import { HubSpotConnector } from './connectors/hubspot/hubspotConnector.js';
import { MockConnector } from './connectors/mock/mockConnector.js';
import { Reconciler } from './engine/reconciler.js';
import { MigrationEngine } from './engine/migrationEngine.js';
import { SyncEngine } from './engine/syncEngine.js';
import { ActivityLog } from './observability/activity.js';
import { env } from './config/env.js';
import { resolveDatabaseUrl, resolveEncryptionKey } from './config/runtimeSecrets.js';
import { PostgresDatabase, runMigrations } from './db/postgres.js';
import { TenantRepository } from './db/tenantRepository.js';
import { SecretCipher } from './db/security.js';
import { PostgresIdMapStore } from './db/postgresIdMapStore.js';
import {
  configureConnectionStore,
  PostgresConnectionStore,
} from './core/connectionStore.js';
import {
  configureSettingsStore,
  PostgresSettingsStore,
  settings,
} from './core/settingsStore.js';
import { FileMappingStore, type MappingStore } from './core/mappingStore.js';
import { PostgresMappingStore } from './db/postgresMappingStore.js';
import { InMemorySyncEventStore } from './engine/syncEventStore.js';
import { PostgresSyncEventStore } from './db/postgresSyncEventStore.js';
import { InMemoryMigrationStore } from './engine/migrationStore.js';
import { PostgresMigrationStore } from './db/postgresMigrationStore.js';
import {
  PostgresApiKeyRepository,
  PostgresOperationsRepository,
} from './db/operationsRepository.js';
import { AssociationEngine, InMemoryAssociationStore } from './engine/associationEngine.js';
import { PostgresAssociationStore } from './db/postgresAssociationStore.js';
import { PreflightService } from './engine/preflight.js';
import { PostgresSchemaSnapshotStore } from './db/postgresSchemaSnapshotStore.js';
import { PostgresValueMappingStore } from './db/postgresValueMappingStore.js';
import { PostgresObjectMappingStore } from './db/postgresObjectMappingStore.js';
import { InMemoryGovernanceStore } from './engine/governanceStore.js';
import { PostgresGovernanceStore } from './db/postgresGovernanceStore.js';
import {
  InMemoryMigrationPlanStore,
  type MigrationPlanStore,
} from './engine/migrationPlanStore.js';
import { PostgresMigrationPlanStore } from './db/postgresMigrationPlanStore.js';
import { PostgresAiSettingsStore } from './db/postgresAiSettingsStore.js';
import {
  defaultSyncConfig,
  InMemorySyncConfigStore,
  syncAllows,
  type SyncConfigStore,
} from './core/syncConfig.js';
import { PostgresSyncConfigStore } from './db/postgresSyncConfigStore.js';
import { listCanonicalObjects } from './core/objectRegistry.js';
import { SyncPoller } from './engine/syncPoller.js';
import { InMemoryReplayCursorStore, type ReplayCursorStore } from './connectors/salesforce/cdcWorker.js';
import { PostgresReplayCursorStore } from './db/postgresReplayCursorStore.js';
import { PostgresNotificationSettingsStore } from './db/postgresNotificationSettingsStore.js';
import { SyncAlertDigester } from './engine/syncAlertDigester.js';

/**
 * Composition root. Builds and wires every component. Nothing else in the codebase
 * constructs connectors or engines directly — pass this container around instead.
 *
 * `mock: true` swaps the real Salesforce/HubSpot connectors for in-memory ones, so the
 * app (and its dashboard) run fully with zero credentials — used for local demos + tests.
 */
export interface App {
  connectors: Record<SystemId, CRMConnector>;
  idMap: IdMapStore;
  mappingStore: MappingStore;
  reconciler: Reconciler;
  migration: MigrationEngine;
  sync: SyncEngine;
  activity: ActivityLog;
  mock: boolean;
  db?: PostgresDatabase;
  tenantId?: string;
  operations?: PostgresOperationsRepository;
  apiKeys?: PostgresApiKeyRepository;
  associations: AssociationEngine;
  preflight: PreflightService;
  valueMappings?: PostgresValueMappingStore;
  objectMappings?: PostgresObjectMappingStore;
  migrationPlans: MigrationPlanStore;
  aiSettings?: PostgresAiSettingsStore;
  syncConfig: SyncConfigStore;
  poller: SyncPoller;
  notificationSettings?: PostgresNotificationSettingsStore;
  alertDigester?: SyncAlertDigester;
}

export async function createApp(
  opts: { initConnectors?: boolean; mock?: boolean; activity?: ActivityLog } = {},
): Promise<App> {
  const mock = opts.mock ?? false;
  const activity = opts.activity ?? new ActivityLog();

  let db: PostgresDatabase | undefined;
  let tenantId: string | undefined;
  let operations: PostgresOperationsRepository | undefined;
  let apiKeys: PostgresApiKeyRepository | undefined;
  let valueMappings: PostgresValueMappingStore | undefined;
  let objectMappings: PostgresObjectMappingStore | undefined;
  let aiSettings: PostgresAiSettingsStore | undefined;
  let notificationSettings: PostgresNotificationSettingsStore | undefined;
  let syncConfig: SyncConfigStore | undefined;
  let idMap: IdMapStore;
  let mappingStore: MappingStore;
  if (mock) {
    idMap = new FileIdMapStore(path.join(os.tmpdir(), `idmap-demo-${process.pid}.json`));
    mappingStore = new FileMappingStore(
      path.join(os.tmpdir(), `mappings-demo-${process.pid}.json`),
    );
  } else {
    const databaseUrl = resolveDatabaseUrl(env);
    const encryptionKey = resolveEncryptionKey(env);
    db = new PostgresDatabase({
      connectionString: databaseUrl,
      ssl: env.DATABASE_SSL,
    });
    await runMigrations(db);
    const tenant = await new TenantRepository(db).ensure(env.DEFAULT_TENANT_SLUG);
    tenantId = tenant.id;
    const cipher = new SecretCipher(encryptionKey);
    configureConnectionStore(new PostgresConnectionStore(db, cipher, tenantId));
    configureSettingsStore(new PostgresSettingsStore(db, cipher, tenantId));
    idMap = new PostgresIdMapStore(db, tenantId);
    mappingStore = new PostgresMappingStore(db, tenantId);
    valueMappings = new PostgresValueMappingStore(db, tenantId);
    await valueMappings.init();
    objectMappings = new PostgresObjectMappingStore(db, tenantId);
    await objectMappings.init();
    operations = new PostgresOperationsRepository(db, tenantId);
    apiKeys = new PostgresApiKeyRepository(db, tenantId);
    aiSettings = new PostgresAiSettingsStore(db, cipher, tenantId);
    notificationSettings = new PostgresNotificationSettingsStore(db, cipher, tenantId);
    activity.attachSink(operations);
  }
  await idMap.init();
  await mappingStore.init();

  // The object registry (and therefore the set of canonical objects available to default
  // sync settings onto) is only guaranteed populated after mappingStore.init() above —
  // objectMappings.init() ran before it in the Postgres branch, and FileMappingStore's
  // init() calls applyDefaultObjects() itself in the mock branch.
  const registeredTypes = listCanonicalObjects().map((object) => object.canonicalObject);
  const syncDefaults = defaultSyncConfig(env.CONFLICT_STRATEGY, env.SOURCE_OF_TRUTH, registeredTypes);
  if (mock || !db || !tenantId) {
    syncConfig = new InMemorySyncConfigStore(syncDefaults);
  } else {
    const postgresSyncConfig = new PostgresSyncConfigStore(db, tenantId, syncDefaults);
    await postgresSyncConfig.init();
    syncConfig = postgresSyncConfig;
  }
  const syncConfigStore: SyncConfigStore = syncConfig;

  const hubspotAppSecret = mock ? '' : (await settings.get('hubspot'))?.clientSecret ?? '';
  const connectors: Record<SystemId, CRMConnector> = mock
    ? { salesforce: new MockConnector('salesforce'), hubspot: new MockConnector('hubspot') }
    : {
        salesforce: new SalesforceConnector(),
        hubspot: new HubSpotConnector(hubspotAppSecret),
      };

  if (!mock && (opts.initConnectors ?? true)) {
    await Promise.all(Object.values(connectors).map((c) => c.init()));
  }

  const governance =
    mock || !db || !tenantId
      ? new InMemoryGovernanceStore()
      : new PostgresGovernanceStore(db, tenantId);
  const reconciler = new Reconciler(connectors, idMap, {
    activity,
    governance,
    conflictOptions: () => {
      const config = syncConfigStore.get();
      return {
        strategy: config.conflictStrategy,
        sourceOfTruth: config.sourceOfTruth,
      };
    },
  });
  const associationStore =
    mock || !db || !tenantId
      ? new InMemoryAssociationStore()
      : new PostgresAssociationStore(db, tenantId);
  const associations = new AssociationEngine(connectors, idMap, associationStore, activity);
  const preflight = new PreflightService(
    connectors,
    !mock && db && tenantId ? new PostgresSchemaSnapshotStore(db, tenantId) : undefined,
  );
  const migrationStore =
    mock || !db || !tenantId
      ? new InMemoryMigrationStore()
      : new PostgresMigrationStore(db, tenantId);
  const migration = new MigrationEngine(
    connectors,
    reconciler,
    activity,
    migrationStore,
  );
  const migrationPlans =
    mock || !db || !tenantId
      ? new InMemoryMigrationPlanStore()
      : new PostgresMigrationPlanStore(db, tenantId);
  const syncStore =
    mock || !db || !tenantId
      ? new InMemorySyncEventStore()
      : new PostgresSyncEventStore(db, tenantId);
  const sync = new SyncEngine(connectors, reconciler, syncStore, {
    concurrency: env.SYNC_CONCURRENCY,
    maxAttempts: env.SYNC_MAX_ATTEMPTS,
    deletePolicy: env.DELETE_POLICY,
    activity,
    associations,
    governance,
    shouldProcess: (event) => syncAllows(syncConfigStore.get(), event.type, event.system),
  });
  await sync.init();

  const cursors: ReplayCursorStore =
    mock || !db || !tenantId
      ? new InMemoryReplayCursorStore()
      : new PostgresReplayCursorStore(db, tenantId);
  const poller = new SyncPoller(connectors, syncConfigStore, cursors, sync, activity);

  const alertDigester = notificationSettings
    ? new SyncAlertDigester(sync, { get: () => notificationSettings!.get() }, activity)
    : undefined;

  return {
    connectors,
    idMap,
    mappingStore,
    reconciler,
    migration,
    sync,
    activity,
    mock,
    db,
    tenantId,
    operations,
    apiKeys,
    associations,
    preflight,
    valueMappings,
    objectMappings,
    migrationPlans,
    aiSettings,
    syncConfig: syncConfigStore,
    poller,
    notificationSettings,
    alertDigester,
  };
}
