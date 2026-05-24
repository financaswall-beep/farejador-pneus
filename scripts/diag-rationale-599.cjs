'use strict';
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    // Pega o payload completo de cada generator_produced
    const r = await c.query(`
      SELECT
        e.occurred_at,
        e.turn_index,
        e.skill_name,
        e.event_payload
      FROM agent.session_events e
      JOIN core.conversations conv ON conv.id = e.conversation_id
      WHERE conv.chatwoot_conversation_id = '599'
        AND e.event_type = 'generator_produced'
      ORDER BY e.occurred_at ASC;
    `);

    for (const row of r.rows) {
      const p = row.event_payload;
      console.log('==========================================');
      console.log('TURN', row.turn_index, '— skill:', row.skill_name);
      console.log('==========================================');
      console.log('SAY:', p.say_text);
      console.log();
      console.log('--- RATIONALE (LLM explica em texto) ---');
      console.log(p.rationale || '(vazio)');
      console.log();
      console.log('--- CLAIMS ---');
      console.log(JSON.stringify(p.claims, null, 2));
      console.log();
      console.log('--- ACTIONS resumo ---');
      const actions = p.actions || p.candidate_actions || [];
      if (actions.length === 0) console.log('  (vazio)');
      for (const a of actions) {
        if (a.type === 'update_slot') {
          console.log(`  update_slot ${a.scope} ${a.slot_key}=${JSON.stringify(a.value)} src=${a.source}`);
        } else if (a.type === 'add_to_cart') {
          console.log(`  add_to_cart product=${(a.product_id||'').slice(0,8)} qty=${a.quantity} price=${a.unit_price}`);
        } else if (a.type === 'record_offer') {
          console.log(`  record_offer item=${(a.item_id||'').slice(0,8)} produtos=${a.products?.length}`);
        } else if (a.type === 'update_draft') {
          console.log(`  update_draft ${JSON.stringify({n: a.customer_name, addr: a.delivery_address, pay: a.payment_method, mode: a.fulfillment_mode})}`);
        } else {
          console.log(`  ${a.type}`);
        }
      }
      console.log();
    }
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
