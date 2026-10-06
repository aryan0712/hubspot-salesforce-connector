const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: 'postgresql://crm_sync:local-development-only@localhost:5432/crm_sync' });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT id, actor_id, action, resource_type, resource_id, detail, created_at
       FROM audit_entries
       WHERE resource_id = 'account_contact' OR detail::text ILIKE '%account_contact%'
       ORDER BY created_at ASC`,
    );
    console.log('total matching rows:', res.rows.length);
    for (const row of res.rows) {
      console.log(row.created_at.toISOString(), row.action, row.resource_id, JSON.stringify(row.detail));
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
