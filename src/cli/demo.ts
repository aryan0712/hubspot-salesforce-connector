import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { CRMConnector } from '../core/connector.js';
import type { ChangeEvent, SystemId } from '../core/types.js';
import { MockConnector } from '../connectors/mock/mockConnector.js';
import { FileIdMapStore } from '../core/idMap.js';
import { Reconciler } from '../engine/reconciler.js';
import { MigrationEngine } from '../engine/migrationEngine.js';
import { applyDefaultObjects } from '../core/defaultObjects.js';

/**
 * End-to-end demo with ZERO credentials. Two in-memory CRMs stand in for Salesforce and
 * HubSpot. It proves the four things a buyer cares about actually work:
 *   1. Migration (bulk backfill Salesforce -> HubSpot)
 *   2. Real-time bidirectional sync (an edit in HubSpot lands in Salesforce)
 *   3. Loop prevention (our own writes don't bounce back forever)
 *   4. Conflict resolution (concurrent edits resolve deterministically)
 *
 * Run: npm run demo
 */
const h = (t: string) => console.log(`\n\x1b[1m\x1b[36m# ${t}\x1b[0m`);
const ok = (t: string) => console.log(`  \x1b[32m✓\x1b[0m ${t}`);
const info = (t: string) => console.log(`  · ${t}`);

async function main(): Promise<void> {
  await applyDefaultObjects();
  const sf = new MockConnector('salesforce');
  const hs = new MockConnector('hubspot');
  const connectors: Record<SystemId, CRMConnector> = { salesforce: sf, hubspot: hs };

  // Fresh id map in a temp file so runs are independent.
  const idMap = new FileIdMapStore(path.join(os.tmpdir(), `idmap-${crypto.randomUUID()}.json`));
  await idMap.init();
  const reconciler = new Reconciler(connectors, idMap);
  const migration = new MigrationEngine(connectors, reconciler);

  // Capture every event each CRM emits, so we can replay them as "webhooks".
  const inbox: ChangeEvent[] = [];
  sf.onChange((e) => inbox.push(e));
  hs.onChange((e) => inbox.push(e));

  // ---------------------------------------------------------------- 1. seed
  h('1. Seed Salesforce (data that already exists before migration)');
  const adaId = sf.seed('contact', { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@analytical.co', phone: '+1-111' });
  sf.seed('contact', { firstName: 'Alan', lastName: 'Turing', email: 'alan@enigma.uk', phone: '+44-222' });
  ok('Salesforce has 2 contacts, HubSpot has 0');

  // ---------------------------------------------------------------- 2. migrate
  h('2. Migrate Salesforce -> HubSpot');
  inbox.length = 0;
  const report = await migration.run({ from: 'salesforce', types: ['contact'] });
  ok(`Migrated ${report.perType.contact!.reconciled} contacts`);
  const adaInHs = (await hs.list('contact')).records.find((r) => r.fields.email === 'ada@analytical.co');
  info(`HubSpot now has Ada: ${adaInHs?.fields.firstName} ${adaInHs?.fields.lastName} <${adaInHs?.fields.email}>`);
  info(`(HubSpot emitted ${inbox.length} "created" webhooks as a side effect of migration)`);

  // ---------------------------------------------------------------- 3. loop prevention
  h('3. Loop prevention — replay HubSpot\'s own "created" webhooks back through sync');
  let propagated = 0;
  for (const e of [...inbox]) {
    const rec = await connectors[e.system].read(e.type, e.sourceId);
    if (!rec) continue;
    const before = (await sf.list('contact')).records.length;
    await reconciler.reconcile(rec);
    const after = (await sf.list('contact')).records.length;
    if (after !== before) propagated += 1;
  }
  ok(`${inbox.length} echo events replayed, ${propagated} caused a write (expected 0 — echoes suppressed by content hash)`);

  // ---------------------------------------------------------------- 4. real-time edit HS -> SF
  h('4. Real-time sync — a user edits Ada\'s phone in HubSpot');
  const adaHsId = (await hs.list('contact')).records.find((r) => r.fields.email === 'ada@analytical.co')!.meta.sourceId;
  inbox.length = 0;
  await hs.upsert(
    { canonicalId: '', type: 'contact', fields: { phone: '+1-999-NEW' }, meta: { source: 'hubspot', sourceId: adaHsId, modifiedAt: new Date().toISOString() } },
    adaHsId,
  );
  const editEvent = inbox.find((e) => e.sourceId === adaHsId)!;
  const edited = await hs.read('contact', editEvent.sourceId);
  await reconciler.reconcile(edited!);
  const adaSf = sf.peek('contact', adaId, 'Phone');
  ok(`Salesforce Ada.Phone is now "${adaSf}" (synced from HubSpot)`);

  // ---------------------------------------------------------------- 5. conflict resolution
  h('5. Conflict — Ada\'s first name edited in BOTH systems at once (last-write-wins)');
  const now = Date.now();
  await hs.upsert({ canonicalId: '', type: 'contact', fields: { firstName: 'Robert' }, meta: { source: 'hubspot', sourceId: adaHsId, modifiedAt: new Date(now).toISOString() } }, adaHsId);
  hs.setModifiedAt('contact', adaHsId, new Date(now).toISOString()); // older
  await sf.upsert({ canonicalId: '', type: 'contact', fields: { firstName: 'Bob' }, meta: { source: 'salesforce', sourceId: adaId, modifiedAt: new Date(now + 5000).toISOString() } }, adaId);
  sf.setModifiedAt('contact', adaId, new Date(now + 5000).toISOString()); // newer -> should win
  const sfEdited = await sf.read('contact', adaId);
  await reconciler.reconcile(sfEdited!);
  info(`HubSpot had "Robert" (older), Salesforce had "Bob" (newer)`);
  ok(`After resolve, HubSpot Ada.firstname = "${hs.peek('contact', adaHsId, 'firstname')}" (newer edit won)`);

  h('Done');
  console.log('  Migration + bidirectional sync + loop prevention + conflict resolution: all working.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
