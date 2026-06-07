#!/usr/bin/env node
'use strict';
/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// LIMPA conversas/mensagens/estado do bot/analytics/raw — começar testes do zero.
// Versão 2026-06-07 (corrige a lista do script velho, que citava tabelas que já
// não existem). Usa TRUNCATE (não dispara o trigger append-only do fact_evidence).
//
// APAGA (só o que EXISTE hoje — filtrado por to_regclass):
//   raw.*, core.* (EXCETO core.units), analytics.*, ops.*, agent.*
// PRESERVA: commerce.* (catálogo/pedidos/parceiros/estoque/coords) + core.units.
//
// GUARD: se o TRUNCATE CASCADE encostar em commerce/units (FK inesperada),
//   detecta a perda de linhas e dá ROLLBACK automático.
//
//   DRY-RUN: node --env-file=.env scripts/limpar-conversas-prod.cjs
//   COMMIT:  COMMIT=1 node --env-file=.env scripts/limpar-conversas-prod.cjs
//
// ⚠️ Depois: apagar as conversas no Chatwoot (UI) também, senão o webhook recria.
// ─────────────────────────────────────────────────────────────────────────────
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const COMMIT = process.env.COMMIT === '1';
if (!DATABASE_URL) { console.error('[ERRO] DATABASE_URL ausente (use --env-file=.env).'); process.exit(1); }

// Candidatas (parents de tabelas particionadas truncam as partições juntas).
const CANDIDATES = [
  'analytics.fact_evidence', 'analytics.conversation_facts', 'analytics.conversation_classifications',
  'analytics.conversation_signals', 'analytics.customer_journey', 'analytics.linguistic_hints',
  'ops.agent_incidents', 'ops.atendente_jobs', 'ops.erasure_log',
  'agent.session_current', 'agent.turns',
  'core.message_reactions', 'core.message_attachments', 'core.messages',
  'core.conversation_tags', 'core.conversation_status_events', 'core.conversation_assignments',
  'core.conversations', 'core.contacts',
  'raw.delivery_seen', 'raw.raw_events',
];

const PROTECTED = [
  'commerce.products', 'commerce.product_prices', 'commerce.stock_levels', 'commerce.store_policies',
  'commerce.partner_orders', 'commerce.partner_purchases', 'commerce.partner_stock_levels',
  'commerce.orders', 'commerce.order_items', 'commerce.delivery_zones', 'core.units',
];

async function existing(client, tables) {
  const out = [];
  for (const t of tables) {
    const r = await client.query('SELECT to_regclass($1) AS reg', [t]);
    if (r.rows[0].reg) out.push(t);
  }
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
  console.log(`=== LIMPAR CONVERSAS (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) ===\n`);
  try {
    const toWipe = await existing(client, CANDIDATES);
    console.log('--- ANTES (a apagar, só != 0) ---');
    const before = await counts(client, toWipe);
    for (const [t, n] of Object.entries(before)) if (n) console.log(`  ${t.padEnd(42)} ${n}`);

    const protBefore = await counts(client, PROTECTED);
    console.log('\n--- PRESERVADAS (commerce + units) ---');
    for (const [t, n] of Object.entries(protBefore)) if (n) console.log(`  ${t.padEnd(42)} ${n}`);

    await client.query('BEGIN');
    console.log(`\n--- TRUNCATE CASCADE em ${toWipe.length} tabelas existentes ---`);
    await client.query(`TRUNCATE TABLE ${toWipe.join(', ')} CASCADE`);

    const protAfter = await counts(client, PROTECTED);
    let alarme = false;
    for (const t of PROTECTED) if (protBefore[t] !== protAfter[t]) { console.log(`  ⚠ ALARME ${t}: ${protBefore[t]} → ${protAfter[t]} (CASCADE encostou no protegido!)`); alarme = true; }
    const after = await counts(client, toWipe);
    const resto = Object.entries(after).filter(([, n]) => n);

    if (alarme) {
      await client.query('ROLLBACK');
      console.log('\n*** ROLLBACK — CASCADE inesperado em tabela protegida. NADA apagado. ***');
    } else if (resto.length) {
      await client.query('ROLLBACK');
      console.log('\n*** ROLLBACK — alguma tabela não zerou:', resto.map(([t]) => t).join(', '));
    } else if (COMMIT) {
      await client.query('COMMIT');
      console.log('  OK — zerou tudo. Protegidas intactas.');
      console.log('\n*** COMMIT efetuado. Banco de conversas limpo. ***');
      console.log('PRÓXIMO: apagar as conversas no Chatwoot (UI) pra o webhook não recriar.');
    } else {
      await client.query('ROLLBACK');
      console.log('  OK — zerou tudo (simulado). Protegidas intactas.');
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
