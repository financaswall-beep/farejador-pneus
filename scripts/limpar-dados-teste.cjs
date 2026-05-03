#!/usr/bin/env node
'use strict';

/* eslint-disable no-console */

/**
 * Limpa dados de teste do ambiente atual.
 *
 * Mantem schemas, tabelas, funcoes, migrations e constraints.
 * Remove apenas registros de Chatwoot e Supabase.
 *
 * Uso:
 *   node --env-file=.env scripts/limpar-dados-teste.cjs --confirm
 */

const { Pool } = require('pg');

const args = new Set(process.argv.slice(2));
const CONFIRM = args.has('--confirm');

const DATABASE_URL = process.env.DATABASE_URL;
const CHATWOOT_BASE_URL = (process.env.CHATWOOT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || '';

if (!CONFIRM) {
  console.error('[ERRO] Operacao destrutiva. Rode com --confirm.');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('[ERRO] DATABASE_URL ausente.');
  process.exit(1);
}

if (!CHATWOOT_API_TOKEN) {
  console.error('[ERRO] CHATWOOT_API_TOKEN ausente.');
  process.exit(1);
}

async function chatwootRequest(method, path) {
  const response = await fetch(`${CHATWOOT_BASE_URL}${path}`, {
    method,
    headers: {
      api_access_token: CHATWOOT_API_TOKEN,
      'content-type': 'application/json',
    },
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { ok: response.ok, status: response.status, body: parsed, text };
}

async function listChatwootConversations() {
  const conversations = [];
  for (let page = 1; page <= 50; page++) {
    const result = await chatwootRequest(
      'GET',
      `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations?status=all&page=${page}`,
    );
    if (!result.ok) {
      throw new Error(`Falha ao listar Chatwoot page=${page}: HTTP ${result.status} ${result.text.slice(0, 300)}`);
    }
    const payload = result.body?.data?.payload ?? result.body?.payload ?? [];
    if (!Array.isArray(payload) || payload.length === 0) break;
    conversations.push(...payload);
    if (payload.length < 25) break;
  }
  return conversations;
}

async function deleteChatwootConversations() {
  const conversations = await listChatwootConversations();
  const deleted = [];
  const failed = [];

  for (const conversation of conversations) {
    const id = conversation.id;
    const result = await chatwootRequest(
      'DELETE',
      `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${id}`,
    );
    if (result.ok || result.status === 404) {
      deleted.push(id);
    } else {
      failed.push({ id, status: result.status, body: result.text.slice(0, 300) });
    }
  }

  return { found: conversations.length, deleted, failed };
}

async function deleteChatwootContacts() {
  const contacts = [];
  for (let page = 1; page <= 50; page++) {
    const result = await chatwootRequest('GET', `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts?page=${page}`);
    if (!result.ok) {
      return { found: 0, deleted: [], failed: [{ id: null, status: result.status, body: result.text.slice(0, 300) }] };
    }
    const payload = result.body?.payload ?? result.body?.data?.payload ?? [];
    if (!Array.isArray(payload) || payload.length === 0) break;
    contacts.push(...payload);
    if (payload.length < 15) break;
  }

  const deleted = [];
  const failed = [];
  for (const contact of contacts) {
    const id = contact.id ?? contact.payload?.id;
    if (!id) continue;
    const result = await chatwootRequest('DELETE', `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/${id}`);
    if (result.ok || result.status === 404) {
      deleted.push(id);
    } else {
      failed.push({ id, status: result.status, body: result.text.slice(0, 300) });
    }
  }
  return { found: contacts.length, deleted, failed };
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
    const result = await pool.query(`select count(*)::int as total from ${ident}`).catch((error) => ({
      rows: [{ total: `ERROR: ${error.message}` }],
    }));
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
  console.log('Limpando Chatwoot...');
  const chatwootConversations = await deleteChatwootConversations();
  console.log(JSON.stringify({ chatwootConversations }, null, 2));

  console.log('Limpando contatos Chatwoot...');
  const chatwootContacts = await deleteChatwootContacts();
  console.log(JSON.stringify({ chatwootContacts }, null, 2));

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });

  try {
    console.log('Contagem antes do truncate...');
    const before = await tableCounts(pool);
    console.log(JSON.stringify(before.filter((row) => row.total !== 0), null, 2));

    console.log('Limpando Supabase...');
    await truncateSupabaseData(pool);

    console.log('Contagem depois do truncate...');
    const after = await tableCounts(pool);
    console.log(JSON.stringify(after.filter((row) => row.total !== 0), null, 2));
  } finally {
    await pool.end();
  }

  const remainingConversations = await listChatwootConversations();
  console.log(JSON.stringify({ remainingChatwootConversations: remainingConversations.length }, null, 2));
}

main().catch((error) => {
  console.error('[ERRO]', error.message);
  process.exit(1);
});
