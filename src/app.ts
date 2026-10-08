import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { CRMConnector } from './core/connector.js';
import type { CanonicalType, SystemId } from './core/types.js';
import { FileIdMapStore, type IdMapStore } from './core/idMap.js';
import { SalesforceConnector } from './connectors/salesforce/salesforceConnector.js';
import { HubSpotConnector } from './connectors/hubspot/hubspotConnector.js';
import { MockConnector } from './connectors/mock/mockConnector.js';
import { Reconciler } from './engine/reconciler.js';
import { MigrationEngine } from './engine/migrationEngine.js';
import { SyncEngine } from './engine/syncEngine.js';
import { ActivityLog } from './observability/activity.js';
import { env } from './config/env.js';
import { createCipher, resolveDatabaseUrl } from './config/runtimeSecrets.js';
import { databaseOptions } from './config/database.js';
import { PostgresDatabase, runMigrations, pendingMigrations as pendingSchemaMigrations } from './db/postgres.js';
import { TenantRepository } from './db/tenantRepository.js';
import { SecretCipher } from './db/security.js';
import { PostgresIdMapStore } from './db/postgresIdMapStore.js';
import {
  configureConnectionStore,
  PostgresConnectionStore,
  type ConnectionStore,
} from './core/connectionStore.js';
import {
  configureSettingsStore,
  PostgresSettingsStore,
  type SettingsStore,
} from './core/settingsStore.js';
import { bindToTenant, type TenantScope } from './core/tenantScope.js';
import { InMemoryOAuthStateStore, type OAuthStateStore } from './security/oauthStates.js';
import { PostgresOAuthStateStore } from './db/postgresOAuthStateStore.js';
import { assertRuntimeRole, grantRuntimeRole, inspectRuntimeRole } from './db/roles.js';
import { InMemoryWebhookInbox, type WebhookInbox } from './webhooks/inbox.js';
import { PostgresWebhookInbox } from './db/postgresWebhookStores.js';
import { WebhookInboxProcessor } from './engine/webhookInboxProcessor.js';
import { resolveCanonicalType } from './engine/typeResolver.js';
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
import { InMemoryGovernanceStore, type GovernanceStore } from './engine/governanceStore.js';
import { PostgresGovernanceStore } from './db/postgresGovernanceStore.js';
import {
  InMemoryMigrationPlanStore,
  type MigrationPlanStore,
} from './engine/migrationPlanStore.js';
import { PostgresMigrationPlanStore } from './db/postgresMigrationPlanStore.js';
import { InMemoryExecutionStore, type ExecutionStore } from './engine/executionStore.js';
import { PostgresExecutionStore } from './db/postgresExecutionStore.js';
import { MigrationService } from './engine/migrationService.js';
import { logger } from './logger.js';
import {
  InMemoryIdentityLock,
  InMemoryWriteIntentStore,
  type IdentityLock,
  type WriteIntentStore,
} from './engine/writeIntents.js';
import { PostgresIdentityLock, PostgresWriteIntentStore } from './db/postgresWriteIntentStore.js';
import { PostgresAiSettingsStore } from './db/postgresAiSettingsStore.js';
import {
  defaultSyncConfig,
  InMemorySyncConfigStore,
  syncRoute,
  type SyncConfigStore,
} from './core/syncConfig.js';
import { PostgresSyncConfigStore } from './db/postgresSyncConfigStore.js';
import { ConfigContext } from './core/configContext.js';
import { SyncPoller } from './engine/syncPoller.js';
import { InMemoryReplayCursorStore, type ReplayCursorStore } from './connectors/salesforce/cdcWorker.js';
import { PostgresReplayCursorStore } from './db/postgresReplayCursorStore.js';
import { PostgresNotificationSettingsStore } from './db/postgresNotificationSettingsStore.js';
import { SyncAlertDigester } from './engine/syncAlertDigester.js';
import { evaluateAlerts, type OperationalAlert } from './observability/alerts.js';
import { PostgresNotificationDeliveryStore } from './notifications/deliveryStore.js';

/**
 * Composition root. Builds and wires every component. Nothing else in the codebase
 * constructs connectors or engines directly — pass this container around instead.
 *
 * `mock: true` swaps the real Salesforce/HubSpot connectors for in-memory ones, so the
 * app (and its dashboard) run fully with zero credentials — used for local demos + tests.
 */
export interface App {
  connectors: Record<SystemId, CRMConnector>;
  /** This app's own mapping/registry/natural-key configuration. */
  config: ConfigContext;
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
  /** The single approved-plan path for every CRM-writing migration (R02-R04). */
  migrations: MigrationService;
  executions: ExecutionStore;
  /** R06: durable write intents (recovery evidence for every CRM mutation). */
  intents: WriteIntentStore;
  /** R10: conflicts, deletion approvals and tombstones. */
  governance: GovernanceStore;
  aiSettings?: PostgresAiSettingsStore;
  syncConfig: SyncConfigStore;
  poller: SyncPoller;
  notificationSettings?: PostgresNotificationSettingsStore;
  alertDigester?: SyncAlertDigester;
  /** R11: this tenant's connection/credential stores; connectors always run inside it. */
  scope?: TenantScope;
  /** R11: persisted, session-bound OAuth state. */
  oauthStates: OAuthStateStore;
  /** The shared database handle, so a multi-tenant process can compose other workspaces. */
  database?: SharedDatabase;
  /** R12: verified webhook deliveries, persisted before acknowledgement. */
  webhookInbox: WebhookInbox;
  /** R12: resolves inbox entries into sync jobs on an initialized worker. */
  inboxProcessor: WebhookInboxProcessor;
  /** Whether this process runs this App's background workers (reported by readiness). */
  workersStarted?: boolean;
  /** R14: this workspace's operational alerts (stale sync, failures, migrations, ...). */
  alerts(): Promise<OperationalAlert[]>;
  /** Migrations this build has that the database has not applied yet (readiness). */
  pendingMigrations(): Promise<string[]>;
}

/** A database shared by several tenant apps in one process (multi-tenant mode, tests). */
export interface SharedDatabase {
  db: PostgresDatabase;
  cipher: SecretCipher;
  tenantId: string;
}

export async function createApp(
  opts: {
    initConnectors?: boolean;
    mock?: boolean;
    activity?: ActivityLog;
    /** Supply a pre-built context (tests); otherwise each app creates its own. */
    config?: ConfigContext;
    /** Use an already-migrated shared database for this tenant instead of opening one. */
    database?: SharedDatabase;
    /**
     * Multi-tenant: never install this tenant's stores as the process-wide default; they
     * are reached only through the tenant scope (requests, workers, bound connectors).
     */
    scoped?: boolean;
  } = {},
): Promise<App> {
  const mock = opts.mock ?? false;
  const activity = opts.activity ?? new ActivityLog();
  // Every app owns its configuration: the demo playground and each tenant get separate
  // registries, mappings and natural keys, and separate on-disk state for mock runs.
  const instanceId = crypto.randomUUID();
  const config = opts.config ?? new ConfigContext(mock ? `demo:${instanceId}` : 'tenant');

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
  let connectionStore: ConnectionStore | undefined;
  let settingsStore: SettingsStore | undefined;
  let cipher: SecretCipher | undefined;
  if (mock) {
    idMap = new FileIdMapStore(path.join(os.tmpdir(), `idmap-demo-${process.pid}-${instanceId}.json`));
    mappingStore = new FileMappingStore(
      config,
      path.join(os.tmpdir(), `mappings-demo-${process.pid}-${instanceId}.json`),
    );
  } else {
    if (opts.database) {
      ({ db, cipher, tenantId } = opts.database);
    } else {
      const opened = await openDatabase();
      db = opened.db;
      cipher = opened.cipher;
      tenantId = (await new TenantRepository(db).ensure(env.DEFAULT_TENANT_SLUG)).id;
    }
    connectionStore = new PostgresConnectionStore(db, cipher, tenantId);
    settingsStore = new PostgresSettingsStore(db, cipher, tenantId);
    if (!opts.scoped) {
      configureConnectionStore(connectionStore);
      configureSettingsStore(settingsStore);
    }
    idMap = new PostgresIdMapStore(db, tenantId);
    mappingStore = new PostgresMappingStore(db, tenantId, config);
    valueMappings = new PostgresValueMappingStore(db, tenantId, config);
    await valueMappings.init();
    objectMappings = new PostgresObjectMappingStore(db, tenantId, config);
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
  const registeredTypes = config.listCanonicalObjects().map((object) => object.canonicalObject);
  const syncDefaults = defaultSyncConfig(env.CONFLICT_STRATEGY, env.SOURCE_OF_TRUTH, registeredTypes);
  if (mock || !db || !tenantId) {
    syncConfig = new InMemorySyncConfigStore(syncDefaults);
  } else {
    const postgresSyncConfig = new PostgresSyncConfigStore(db, tenantId, syncDefaults);
    await postgresSyncConfig.init();
    syncConfig = postgresSyncConfig;
  }
  const syncConfigStore: SyncConfigStore = syncConfig;

  const scope: TenantScope | undefined =
    tenantId && connectionStore && settingsStore
      ? { tenantId, connections: connectionStore, settings: settingsStore }
      : undefined;
  const hubspotAppSecret = settingsStore ? (await settingsStore.get('hubspot'))?.clientSecret ?? '' : '';
  // Live connectors run every call inside this tenant's scope, whoever invokes them (a
  // request, the sync worker, a poller timer), so they only ever use this tenant's tokens.
  const connectors: Record<SystemId, CRMConnector> = mock || !scope
    ? { salesforce: new MockConnector('salesforce', config), hubspot: new MockConnector('hubspot', config) }
    : {
        salesforce: bindToTenant(new SalesforceConnector(config, tenantId), scope),
        hubspot: bindToTenant(new HubSpotConnector(config, hubspotAppSecret, tenantId), scope),
      };
  const oauthStates: OAuthStateStore =
    db && cipher && !mock ? new PostgresOAuthStateStore(db, cipher) : new InMemoryOAuthStateStore();

  if (!mock && (opts.initConnectors ?? true)) {
    await Promise.all(Object.values(connectors).map((c) => c.init()));
  }

  const governance =
    mock || !db || !tenantId
      ? new InMemoryGovernanceStore()
      : new PostgresGovernanceStore(db, tenantId);
  // R06: every CRM mutation is recorded as a durable intent first, and work on one record
  // identity is serialized across workers (advisory locks when running on PostgreSQL).
  const intents: WriteIntentStore =
    mock || !db || !tenantId ? new InMemoryWriteIntentStore() : new PostgresWriteIntentStore(db, tenantId);
  const locks: IdentityLock =
    mock || !db || !tenantId ? new InMemoryIdentityLock() : new PostgresIdentityLock(db, tenantId);
  const reconciler = new Reconciler(connectors, idMap, config, {
    intents,
    locks,
    activity,
    governance,
    conflictOptions: (type?: CanonicalType) => {
      const config = syncConfigStore.get();
      const objConfig = type ? config.objects[type] : undefined;
      return {
        strategy: objConfig?.conflictStrategy ?? config.conflictStrategy,
        sourceOfTruth: objConfig?.sourceOfTruth ?? config.sourceOfTruth,
      };
    },
    // A one-directional sync must never write a merged value back to the system that is
    // only a source for that object.
    syncWriteScope: (type) =>
      syncConfigStore.get().objects[type]?.direction === 'bidirectional' ? 'bidirectional' : 'destination-only',
  });
  const associationStore =
    mock || !db || !tenantId
      ? new InMemoryAssociationStore()
      : new PostgresAssociationStore(db, tenantId);
  const associations = new AssociationEngine(connectors, idMap, associationStore, activity);
  const preflight = new PreflightService(
    connectors,
    config,
    !mock && db && tenantId ? new PostgresSchemaSnapshotStore(db, tenantId) : undefined,
  );
  const migrationStore =
    mock || !db || !tenantId
      ? new InMemoryMigrationStore()
      : new PostgresMigrationStore(db, tenantId);
  const migration = new MigrationEngine(
    connectors,
    config,
    reconciler,
    activity,
    migrationStore,
  );
  let migrationPlans: MigrationPlanStore;
  let executions: ExecutionStore;
  if (mock || !db || !tenantId) {
    const plans = new InMemoryMigrationPlanStore();
    migrationPlans = plans;
    executions = new InMemoryExecutionStore(plans);
  } else {
    migrationPlans = new PostgresMigrationPlanStore(db, tenantId);
    executions = new PostgresExecutionStore(db, tenantId);
  }
  const migrations = new MigrationService(migration, preflight, executions, migrationPlans, {
    connectors,
    config,
    idMap,
    reconciler,
    activity,
  });
  // Configuration is fully hydrated at this point, so every later publish is an operator
  // change: previews and canaries of plans covering those objects no longer describe the
  // writes they approved. (Execution re-checks the fingerprint regardless.)
  config.onChange((change) => {
    if (!change.types.length) return;
    void migrationPlans.invalidateApprovals(change.types).catch((err) => {
      logger.error({ err, types: change.types }, 'failed to invalidate approvals after a mapping change');
    });
  });
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
    route: (event) => syncRoute(syncConfigStore.get(), event.type, event.system),
    // The live worker starts claiming only once connectors are initialized (see
    // httpApp startBackground / src/worker.ts); the mock app processes immediately.
    manualStart: !mock,
  });
  await sync.init();

  const webhookInbox: WebhookInbox =
    mock || !db || !tenantId ? new InMemoryWebhookInbox() : new PostgresWebhookInbox(db, tenantId);
  const inboxProcessor = new WebhookInboxProcessor(connectors, webhookInbox, (events) => sync.enqueue(events), {
    activity,
    resolveType: (system, nativeObject, sourceId) =>
      resolveCanonicalType(system, nativeObject, sourceId, connectors[system], syncConfigStore.get(), config),
  });
  // The mock app has no separate worker side; live apps start it with the other workers.
  if (mock) inboxProcessor.start();

  const cursors: ReplayCursorStore =
    mock || !db || !tenantId
      ? new InMemoryReplayCursorStore()
      : new PostgresReplayCursorStore(db, tenantId);
  const poller = new SyncPoller(connectors, syncConfigStore, cursors, sync, config, activity, idMap);

  const pendingMigrations = () => (db ? pendingSchemaMigrations(db) : Promise.resolve([]));
  const alerts = () =>
    evaluateAlerts({
      db,
      syncStore,
      executions,
      webhookInbox,
      connectors,
      maxWebhookBacklog: env.WEBHOOK_MAX_BACKLOG,
    });
  const alertDigester = notificationSettings
    ? new SyncAlertDigester(sync, { get: () => notificationSettings!.get() }, activity, {
        // R14: delivery state survives restarts (retries, no duplicate alerts).
        deliveries: db && tenantId ? new PostgresNotificationDeliveryStore(db, tenantId) : undefined,
        // Operational alerts join the digest, re-notified at most once a day while active.
        extraIssues: async () => {
          const day = new Date().toISOString().slice(0, 10);
          return (await alerts()).map((alert) => ({
            key: `alert:${alert.id}:${day}`,
            line: `- [${alert.severity}] ${alert.title}: ${alert.detail}`,
          }));
        },
      })
    : undefined;

  return {
    connectors,
    config,
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
    migrations,
    executions,
    intents,
    governance,
    aiSettings,
    syncConfig: syncConfigStore,
    poller,
    notificationSettings,
    alertDigester,
    scope,
    oauthStates,
    database: db && cipher && tenantId ? { db, cipher, tenantId } : undefined,
    webhookInbox,
    inboxProcessor,
    alerts,
    pendingMigrations,
  };
}

/**
 * Opens the runtime database. Schema migrations run with DATABASE_MIGRATION_URL when it is
 * set (a separate role that owns the schema), which then grants the runtime role only data
 * privileges; the runtime role is checked (never superuser / BYPASSRLS / schema owner in
 * production). Without a migration URL (local development) the runtime role migrates.
 */
export async function openDatabase(): Promise<{ db: PostgresDatabase; cipher: SecretCipher }> {
  const db = new PostgresDatabase(databaseOptions(env, resolveDatabaseUrl(env)));
  if (env.DATABASE_MIGRATION_URL) {
    const migrator = new PostgresDatabase(databaseOptions(env, env.DATABASE_MIGRATION_URL, { max: 1 }));
    try {
      await runMigrations(migrator);
      const runtimeRole = (await db.pool.query<{ current_user: string }>('SELECT current_user')).rows[0]!.current_user;
      await grantRuntimeRole(migrator, runtimeRole);
    } finally {
      await migrator.close();
    }
  } else {
    await runMigrations(db);
  }
  assertRuntimeRole(await inspectRuntimeRole(db), env.NODE_ENV === 'production');
  return { db, cipher: createCipher(env) };
}
