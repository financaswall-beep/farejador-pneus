/**
 * Auditoria turn-a-turn de uma conversa: Organizadora + Planner + Atendente.
 * Apenas SELECT. Nao altera nada.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/auditar-conversa.ts <chatwoot_id>
 *
 * Aceita tanto chatwoot_conversation_id quanto chatwoot_contact_id.
 */

import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[ERRO] DATABASE_URL ausente.');
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) {
  console.error('[ERRO] passe o id: npx tsx --env-file=.env scripts/auditar-conversa.ts <chatwoot_id>');
  process.exit(1);
}

const chatwootId = Number(arg);
if (!Number.isFinite(chatwootId)) {
  console.error('[ERRO] id invalido:', arg);
  process.exit(1);
}

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function fmt(ts: Date | string | null): string {
  if (!ts) return '-';
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function truncate(s: string | null | undefined, n = 200): string {
  if (!s) return '';
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > n ? cleaned.substring(0, n) + '…' : cleaned;
}

async function main() {
  await client.connect();

  // 1) Resolver UUID da conversa.
  let conv = await client.query(
    `SELECT id, environment, chatwoot_conversation_id, contact_id, current_status, started_at, last_activity_at
     FROM core.conversations
     WHERE chatwoot_conversation_id = $1
     ORDER BY started_at DESC
     LIMIT 1;`,
    [chatwootId],
  );

  let interpretacao = 'chatwoot_conversation_id';

  if (conv.rows.length === 0) {
    // Tentar como contact_id.
    const ctt = await client.query(
      `SELECT id, chatwoot_contact_id FROM core.contacts WHERE chatwoot_contact_id = $1 LIMIT 1;`,
      [chatwootId],
    );
    if (ctt.rows.length > 0) {
      const contactUuid = ctt.rows[0].id;
      conv = await client.query(
        `SELECT id, environment, chatwoot_conversation_id, contact_id, current_status, started_at, last_activity_at
         FROM core.conversations
         WHERE contact_id = $1
         ORDER BY started_at DESC
         LIMIT 1;`,
        [contactUuid],
      );
      interpretacao = 'chatwoot_contact_id → conversa mais recente';
    }
  }

  if (conv.rows.length === 0) {
    console.log(`Nenhuma conversa ou contato encontrado pro id ${chatwootId}.`);
    await client.end();
    return;
  }

  const c = conv.rows[0];
  console.log(`=== AUDITORIA conversa Chatwoot ${chatwootId} (${interpretacao}) ===`);
  console.log(`UUID:               ${c.id}`);
  console.log(`Env:                ${c.environment}`);
  console.log(`Status:             ${c.current_status}`);
  console.log(`Iniciada / ult.ativ.: ${fmt(c.started_at)} | ${fmt(c.last_activity_at)}`);
  console.log(`Chatwoot conv id:   ${c.chatwoot_conversation_id}`);
  console.log('');

  // 2) Mensagens core.
  const msgs = await client.query(
    `SELECT id, chatwoot_message_id, sender_type, message_type_name, content, sent_at, is_private
     FROM core.messages
     WHERE conversation_id = $1
     ORDER BY sent_at ASC;`,
    [c.id],
  );

  console.log(`--- MENSAGENS (${msgs.rows.length}) ---`);
  for (const m of msgs.rows) {
    const role = m.sender_type === 'contact' ? 'CLIENTE' : m.sender_type.toUpperCase();
    const priv = m.is_private ? ' (PRIVADA)' : '';
    console.log(`[${fmt(m.sent_at)}] ${role}${priv} #${m.chatwoot_message_id}: ${truncate(m.content, 280)}`);
  }
  console.log('');

  // 3) Jobs da Organizadora.
  const orgJobs = await client.query(
    `SELECT id, status, attempts, locked_by, locked_at, processed_at, error_message, created_at
     FROM ops.enrichment_jobs
     WHERE conversation_id = $1
     ORDER BY created_at ASC;`,
    [c.id],
  ).catch(() => ({ rows: [] as any[] }));

  console.log(`--- JOBS ORGANIZADORA (${orgJobs.rows.length}) ---`);
  for (const j of orgJobs.rows) {
    console.log(`  ${j.status} | tentativas=${j.attempts ?? '-'} | criado=${fmt(j.created_at)} | processado=${fmt(j.processed_at)}${j.error_message ? ' | erro=' + truncate(j.error_message, 120) : ''}`);
  }
  console.log('');

  // 4) Fatos extraidos pela Organizadora.
  const facts = await client.query(
    `SELECT fact_key, fact_value, truth_type, source, confidence_level, extractor_version, observed_at, superseded_by, created_at
     FROM analytics.conversation_facts
     WHERE conversation_id = $1
     ORDER BY observed_at ASC NULLS FIRST, created_at ASC;`,
    [c.id],
  );

  console.log(`--- FATOS (${facts.rows.length}) ---`);
  for (const f of facts.rows) {
    const sup = f.superseded_by ? ' [SUBSTITUIDO]' : '';
    console.log(`  ${f.fact_key} = ${JSON.stringify(f.fact_value)} | ${f.truth_type} | conf=${f.confidence_level} | ${f.source}@${f.extractor_version}${sup}`);
  }
  console.log('');

  // 5) Jobs do Atendente.
  const atJobs = await client.query(
    `SELECT id, status, attempts, locked_by, locked_at, processed_at, error_message, created_at
     FROM ops.atendente_jobs
     WHERE conversation_id = $1
     ORDER BY created_at ASC;`,
    [c.id],
  );

  console.log(`--- JOBS ATENDENTE (${atJobs.rows.length}) ---`);
  for (const j of atJobs.rows) {
    console.log(`  ${j.status} | tentativas=${j.attempts ?? '-'} | criado=${fmt(j.created_at)} | processado=${fmt(j.processed_at)}${j.error_message ? ' | erro=' + truncate(j.error_message, 160) : ''}`);
  }
  console.log('');

  // 6) Eventos da sessao (Planner + Tool Executor + estado).
  const events = await client.query(
    `SELECT id, event_type, skill_name, event_payload, occurred_at
     FROM agent.session_events
     WHERE conversation_id = $1
     ORDER BY occurred_at ASC;`,
    [c.id],
  );

  console.log(`--- EVENTOS DE SESSAO (${events.rows.length}) ---`);
  for (const e of events.rows) {
    const event_payloadStr = e.event_payload ? truncate(JSON.stringify(e.event_payload), 300) : '';
    console.log(`  [${fmt(e.occurred_at)}] ${e.event_type}${e.skill_name ? ' / ' + e.skill_name : ''} ${event_payloadStr}`);
  }
  console.log('');

  // 7) Turns do Atendente / Generator.
  const turns = await client.query(
    `SELECT id, selected_skill, agent_version, status, say_text, actions,
            llm_duration_ms, llm_input_tokens, llm_output_tokens, error_message,
            trigger_message_id, delivered_message_id, created_at
     FROM agent.turns
     WHERE conversation_id = $1
     ORDER BY created_at ASC;`,
    [c.id],
  );

  console.log(`--- TURNS DO ATENDENTE (${turns.rows.length}) ---`);
  for (const t of turns.rows) {
    console.log(`\n  [${fmt(t.created_at)}] skill=${t.selected_skill ?? '-'} | status=${t.status} | ${t.agent_version}`);
    console.log(`    trigger_msg=${t.trigger_message_id}`);
    console.log(`    duracao=${t.llm_duration_ms}ms | tokens in/out=${t.llm_input_tokens}/${t.llm_output_tokens}`);
    if (t.say_text) console.log(`    SAY: ${truncate(t.say_text, 280)}`);
    if (t.actions && Array.isArray(t.actions) && t.actions.length > 0) {
      console.log(`    ACOES: ${truncate(JSON.stringify(t.actions), 320)}`);
    }
    if (t.error_message) console.log(`    ERRO: ${truncate(t.error_message, 220)}`);
    if (t.delivered_message_id) console.log(`    entregue como msg ${t.delivered_message_id}`);
  }
  console.log('');

  // 8) Order drafts (carrinho/pedido).
  const drafts = await client.query(
    `SELECT id, draft_status, customer_name, delivery_address, fulfillment_mode, payment_method,
            promoted_order_id, promoted_at, created_at, updated_at
     FROM agent.order_drafts
     WHERE conversation_id = $1
     ORDER BY created_at ASC;`,
    [c.id],
  ).catch(() => ({ rows: [] as any[] }));

  if (drafts.rows.length > 0) {
    console.log(`--- ORDER DRAFTS (${drafts.rows.length}) ---`);
    for (const d of drafts.rows) {
      console.log(`  [${fmt(d.created_at)}] status=${d.draft_status} | nome=${d.customer_name ?? '-'} | endereco=${d.delivery_address ?? '-'} | modal=${d.fulfillment_mode ?? '-'} | pagto=${d.payment_method ?? '-'} | promoted_order=${d.promoted_order_id ?? '-'}`);
    }
    console.log('');
  }

  // 9) Incidentes / human review.
  const incidents = await client.query(
    `SELECT id, incident_type, agent_turn_id, created_at
     FROM ops.agent_incidents
     WHERE conversation_id = $1
     ORDER BY created_at ASC;`,
    [c.id],
  ).catch(() => ({ rows: [] as any[] }));

  if (incidents.rows.length > 0) {
    console.log(`--- INCIDENTES (${incidents.rows.length}) ---`);
    for (const i of incidents.rows) {
      console.log(`  [${fmt(i.created_at)}] ${i.incident_type} | turn=${i.agent_turn_id ?? '-'}`);
    }
    console.log('');
  }

  console.log('=== FIM ===');
  await client.end();
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
