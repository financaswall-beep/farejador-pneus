#!/usr/bin/env node
'use strict';

/* eslint-disable no-console */

/**
 * Limpa apenas o banco (Supabase). NAO mexe em Chatwoot.
 * Util quando o ambiente nao tem acesso de rede ao Chatwoot.
 *
 * Voce eh responsavel por apagar as conversas no Chatwoot (UI ou outro caminho)
 * antes/depois — senao webhook recria tudo.
 *
 * NAO toca em commerce.* — catalogo, precos, estoque e delivery_zones ficam.
 *
 * Uso:
 *   node --env-file=.env scripts/limpar-banco-apenas.cjs --confirm
 */

const { Pool } = require('pg');

const args = new Set(process.argv.slice(2));
const CONFIRM = args.has('--confirm');

const DATABASE_URL = process.env.DATABASE_URL;

if (!CONFIRM) {
  console.error('[ERRO] Operacao destrutiva. Rode com --confirm.');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('[ERRO] DATABASE_URL ausente.');
  process.exit(1);
}

async function tableCounts(pool) {
  const tables = await pool.query(`
    select table_schema, table_name
    from information_schema.tables
    where table_schema in ('raw','core','analytics','ops','agent','commerce')
      and table_type = 'BASE TABLE'
    order by table_schema, table_name
  `);

  const rows = [];
  for (const table of tables.rows) {
    const ident = `"${table.table_schema}"."${table.table_name}"`;
    const result = await pool
      .query(`select count(*)::int as total from ${ident}`)
      .catch((error) => ({ rows: [{ total: `ERROR: ${error.message}` }] }));
    rows.push({ schema: table.table_schema, table: table.table_name, total: result.rows[0].total });
  }
  return rows;
}

async function truncateSupabaseData(pool) {
  await pool.query('begin');
  try {
    await pool.query(`
      TRUNCATE TABLE
        analytics.fact_evidence,
        analytics.conversation_facts,
        analytics.conversation_classifications,
        analytics.conversation_signals,
        analytics.customer_journey,
        analytics.linguistic_hints,
        ops.agent_incidents,
        ops.atendente_jobs,
        ops.bot_events,
        ops.enrichment_jobs,
        ops.erasure_log,
        ops.stock_snapshots,
        ops.unhandled_messages,
        agent.cart_current_items,
        agent.cart_current,
        agent.cart_events,
        agent.escalations,
        agent.order_drafts,
        agent.pending_confirmations,
        agent.session_events,
        agent.session_slots,
        agent.session_items,
        agent.session_current,
        agent.turns,
        core.message_reactions,
        core.message_attachments,
        core.messages,
        core.conversation_tags,
        core.conversation_status_events,
        core.conversation_assignments,
        core.conversations,
        core.contacts,
        raw.delivery_seen,
        raw.raw_events
      CASCADE
    `);
    await pool.query('commit');
  } catch (error) {
    await pool.query('rollback');
    throw error;
  }
}

async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });

  try {
    console.log('Contagem ANTES do truncate (so linhas != 0):');
    const before = await tableCounts(pool);
    console.log(JSON.stringify(before.filter((row) => row.total !== 0), null, 2));

    console.log('\nLimpando Supabase (raw/core/analytics/ops/agent)...');
    await truncateSupabaseData(pool);

    console.log('\nContagem DEPOIS do truncate (so linhas != 0):');
    const after = await tableCounts(pool);
    const remaining = after.filter((row) => row.total !== 0);
    console.log(JSON.stringify(remaining, null, 2));

    console.log('\nFAZER A SEGUIR:');
    console.log(' 1. Apagar as conversas no Chatwoot pela UI (senao webhook recria estado).');
    console.log(' 2. Iniciar nova conversa de teste.');
    console.log(' 3. Me passar o id pra rodar auditar-conversa.ts.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[ERRO]', error.message);
  process.exit(1);
});
