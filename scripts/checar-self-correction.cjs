'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();
  const convId = 'c6d3b44c-b291-4051-a79d-21a423b80a45';

  const events = await client.query(`
    SELECT
      occurred_at,
      event_payload->>'turn_id' AS turn_id,
      event_payload->>'blocked' AS blocked,
      event_payload->>'block_reason' AS block_reason,
      event_payload->>'self_correction_round' AS sc_round,
      event_payload->>'self_correction_previous_reason' AS sc_prev_reason,
      event_payload->>'input_tokens' AS input_tokens,
      event_payload->>'duration_ms' AS duration_ms,
      LEFT(event_payload->>'say_text', 100) AS say_text,
      LEFT(event_payload->>'blocked_say_text', 100) AS blocked_say
    FROM agent.session_events
    WHERE conversation_id = $1 AND event_type = 'generator_produced'
    ORDER BY occurred_at;
  `, [convId]);

  console.log('=== generator_produced events da conv 592 ===\n');
  for (let i = 0; i < events.rows.length; i++) {
    const e = events.rows[i];
    console.log(`Turn ${i+1} (${e.occurred_at.toISOString()}):`);
    console.log(`  blocked = ${e.blocked}`);
    if (e.block_reason) console.log(`  block_reason = ${e.block_reason}`);
    console.log(`  self_correction_round = ${e.sc_round ?? '(nulo)'}`);
    if (e.sc_prev_reason) console.log(`  sc_previous_reason = ${e.sc_prev_reason}`);
    console.log(`  input_tokens = ${e.input_tokens}, duration_ms = ${e.duration_ms}`);
    if (e.say_text) console.log(`  SAY: ${e.say_text}...`);
    if (e.blocked_say) console.log(`  BLOCKED SAY: ${e.blocked_say}...`);
    console.log('');
  }

  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
