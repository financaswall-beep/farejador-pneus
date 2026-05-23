'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  const convs = await client.query(`
    SELECT c.id, c.chatwoot_conversation_id, c.contact_id, c.current_status, c.started_at, c.last_activity_at,
           ct.chatwoot_contact_id, ct.name
    FROM core.conversations c
    LEFT JOIN core.contacts ct ON ct.id = c.contact_id
    ORDER BY c.started_at DESC
    LIMIT 5;
  `);
  console.log('Conversas mais recentes:');
  for (const c of convs.rows) {
    console.log(`  #${c.chatwoot_conversation_id} (uuid ${c.id}) | contact chatwoot=${c.chatwoot_contact_id ?? '-'} nome=${c.name ?? '-'} | status=${c.current_status} | inicio=${c.started_at?.toISOString()} | ult=${c.last_activity_at?.toISOString() ?? '-'}`);
  }
  console.log();

  if (convs.rows.length === 0) {
    console.log('Nenhuma conversa ainda.');
    await client.end();
    return;
  }

  const last = convs.rows[0];

  const msgs = await client.query(
    `SELECT COUNT(*)::int AS n FROM core.messages WHERE conversation_id = $1;`,
    [last.id],
  );
  const orgJobs = await client.query(
    `SELECT status, COUNT(*)::int AS n FROM ops.enrichment_jobs WHERE conversation_id = $1 GROUP BY status;`,
    [last.id],
  );
  const atJobs = await client.query(
    `SELECT status, locked_at, processed_at, COUNT(*)::int AS n FROM ops.atendente_jobs WHERE conversation_id = $1 GROUP BY status, locked_at, processed_at ORDER BY processed_at;`,
    [last.id],
  );
  const turns = await client.query(
    `SELECT id, selected_skill, status, created_at FROM agent.turns WHERE conversation_id = $1 ORDER BY created_at;`,
    [last.id],
  );
  const facts = await client.query(
    `SELECT COUNT(*)::int AS n FROM analytics.conversation_facts WHERE conversation_id = $1;`,
    [last.id],
  );
  const pendingAt = await client.query(
    `SELECT id, status, created_at, locked_at, processed_at FROM ops.atendente_jobs WHERE conversation_id = $1 ORDER BY created_at;`,
    [last.id],
  );
  // enrichment_jobs nao tem coluna conversation_id; usa target_type+target_id (msg ou conv)
  const pendingOrg = await client.query(
    `SELECT j.id, j.status, j.target_type, j.created_at, j.started_at, j.completed_at, j.attempts, j.last_error
     FROM ops.enrichment_jobs j
     LEFT JOIN core.messages m ON m.id = j.target_id AND j.target_type='message'
     WHERE (j.target_type='conversation' AND j.target_id = $1)
        OR (j.target_type='message' AND m.conversation_id = $1)
     ORDER BY j.created_at;`,
    [last.id],
  );

  console.log(`Conversa ${last.chatwoot_conversation_id}:`);
  console.log(`  Mensagens em core: ${msgs.rows[0].n}`);
  console.log(`  Facts extraidos: ${facts.rows[0].n}`);
  console.log(`  Turns do atendente: ${turns.rows.length}`);
  console.log();

  console.log('Jobs ATENDENTE:');
  for (const j of pendingAt.rows) {
    const dur = j.processed_at && j.locked_at ? `${((new Date(j.processed_at) - new Date(j.locked_at))/1000).toFixed(1)}s` : '-';
    console.log(`  ${j.status}\tcriado=${j.created_at.toISOString()}\tprocessado=${j.processed_at?.toISOString() ?? '-'}\tdur=${dur}`);
  }
  console.log();

  console.log('Jobs ORGANIZADORA:');
  for (const j of pendingOrg.rows) {
    const dur = j.completed_at && j.started_at ? `${((new Date(j.completed_at) - new Date(j.started_at))/1000).toFixed(1)}s` : '-';
    console.log(`  ${j.status} (${j.target_type})\tcriado=${j.created_at.toISOString()}\tcompleto=${j.completed_at?.toISOString() ?? '-'}\tdur=${dur} attempts=${j.attempts}${j.last_error ? ' err=' + j.last_error.slice(0, 100) : ''}`);
  }

  await client.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
