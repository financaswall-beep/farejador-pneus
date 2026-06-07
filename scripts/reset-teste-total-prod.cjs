#!/usr/bin/env node
'use strict';
/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// RESET TOTAL DE TESTE (prod) — 2026-06-07. Tudo é teste (confirmado pelo dono).
// Zera conversas + estado do bot + analytics + raw + pedidos/leads/recebíveis de
// teste, e LIBERA as reservas de estoque (mantém o on_hand). Volta tudo ao zero
// pra validar o geo do zero: justiça neutra, estoque cheio, sem histórico.
//
// Usa TRUNCATE (não dispara o trigger append-only do fact_evidence).
// PRESERVA: catálogo, parceiros+coords, unit_coverage, core.units, stock_levels,
//   partner_stock_levels (linhas; só zera reserved), payables/expenses (não são
//   dos pedidos), delivery_zones, store_policies, vehicle_*.
// GUARD: se o CASCADE encostar em qualquer PROTEGIDA → ROLLBACK automático.
//
//   DRY-RUN: node --env-file=.env scripts/reset-teste-total-prod.cjs
//   COMMIT:  COMMIT=1 node --env-file=.env scripts/reset-teste-total-prod.cjs
//
// ⚠️ Depois: apagar as conversas no Chatwoot (UI) pra o webhook não recriar.
// ─────────────────────────────────────────────────────────────────────────────
const { Client } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
const COMMIT = process.env.COMMIT === '1';
if (!DATABASE_URL) { console.error('[ERRO] DATABASE_URL ausente (use --env-file=.env).'); process.exit(1); }

const WIPE = [
  // conversas / bot / analytics / raw
  'analytics.fact_evidence', 'analytics.conversation_facts', 'analytics.conversation_classifications',
  'analytics.conversation_signals', 'analytics.customer_journey', 'analytics.linguistic_hints',
  'ops.agent_incidents', 'ops.atendente_jobs', 'ops.erasure_log',
  'agent.session_current', 'agent.turns',
  'core.message_reactions', 'core.message_attachments', 'core.messages',
  'core.conversation_tags', 'core.conversation_status_events', 'core.conversation_assignments',
  'core.conversations', 'core.contacts',
  'raw.delivery_seen', 'raw.raw_events',
  // pedidos / leads / recebíveis dos pedidos de teste + fitment aprendido em conversa
  'commerce.order_items', 'commerce.orders',
  'commerce.partner_order_items', 'commerce.partner_orders',
  'finance.partner_receivable_installments', 'finance.partner_receivables',
  'commerce.fitment_discoveries',
];
const PROTECTED = [
  'commerce.products', 'commerce.product_prices', 'commerce.stock_levels', 'commerce.partner_stock_levels',
  'commerce.store_policies', 'commerce.delivery_zones', 'commerce.vehicle_models', 'commerce.vehicle_fitments',
  'commerce.tire_specs', 'commerce.partner_purchases',
  'finance.partner_payables', 'finance.partner_expenses',
  'network.partners', 'network.partner_units', 'network.unit_coverage', 'core.units',
];

async function existing(client, tables) {
  const out = [];
  for (const t of tables) { const r = await client.query('SELECT to_regclass($1) AS reg', [t]); if (r.rows[0].reg) out.push(t); }
  return out;
}
async function counts(client, tables) {
  const out = {};
  for (const t of tables) { const r = await client.query(`SELECT COUNT(*)::int AS n FROM ${t}`); out[t] = r.rows[0].n; }
  return out;
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log(`=== RESET TOTAL DE TESTE (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) ===\n`);
  try {
    const toWipe = await existing(client, WIPE);
    const before = await counts(client, toWipe);
    console.log('--- A APAGAR (só != 0) ---');
    for (const [t, n] of Object.entries(before)) if (n) console.log(`  ${t.padEnd(44)} ${n}`);

    const reservedBefore = await client.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(quantity_reserved),0)::int AS s FROM commerce.partner_stock_levels WHERE COALESCE(quantity_reserved,0)<>0`);
    console.log(`\n--- RESERVAS a liberar: ${reservedBefore.rows[0].n} linha(s), ${reservedBefore.rows[0].s} unidade(s) (on_hand intacto) ---`);

    const protBefore = await counts(client, PROTECTED);

    await client.query('BEGIN');
    await client.query(`UPDATE commerce.partner_stock_levels SET quantity_reserved = 0 WHERE COALESCE(quantity_reserved,0) <> 0`);
    await client.query(`TRUNCATE TABLE ${toWipe.join(', ')} CASCADE`);

    const protAfter = await counts(client, PROTECTED);
    let alarme = false;
    for (const t of PROTECTED) if (protBefore[t] !== protAfter[t]) { console.log(`  ⚠ ALARME ${t}: ${protBefore[t]} → ${protAfter[t]} (CASCADE encostou no protegido!)`); alarme = true; }
    const after = await counts(client, toWipe);
    const resto = Object.entries(after).filter(([, n]) => n);
    const reservedAfter = await client.query(`SELECT COUNT(*)::int AS n FROM commerce.partner_stock_levels WHERE COALESCE(quantity_reserved,0)<>0`);

    if (alarme || resto.length || reservedAfter.rows[0].n) {
      await client.query('ROLLBACK');
      console.log('\n*** ROLLBACK — ' + (alarme ? 'cascade em protegida' : resto.length ? 'tabela não zerou: ' + resto.map(([t]) => t).join(',') : 'reserva não liberou') + '. NADA apagado. ***');
    } else if (COMMIT) {
      await client.query('COMMIT');
      console.log('  OK — tudo zerado, reservas liberadas, protegidas intactas.');
      console.log('\n*** COMMIT efetuado. Reset total concluído. ***');
      console.log('PRÓXIMO: apagar as conversas no Chatwoot (UI) pra o webhook não recriar.');
    } else {
      await client.query('ROLLBACK');
      console.log('  OK — tudo zerado, reservas liberadas, protegidas intactas (simulado).');
      console.log('\n*** DRY-RUN: ROLLBACK. Rode com COMMIT=1 pra aplicar. ***');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nErro — ROLLBACK:', err.message);
    throw err;
  } finally {
    await client.end();
  }
}
main().catch(() => process.exit(1));
