import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';

let db: IntegrationDb;
let conversationId: string;
let chatwootConversationId: number;
let reconcileAgentOutboundDelivery: typeof import('../../src/atendente-v2/outbound-reconcile').reconcileAgentOutboundDelivery;
let supersedeStaleAgentOutbound: typeof import('../../src/atendente-v2/outbound-worker').supersedeStaleAgentOutbound;
let getBotVisao: typeof import('../../src/admin/painel/queries-bot-visao').getBotVisao;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/farejador_test',
    CHATWOOT_HMAC_SECRET: 'integration-secret', ADMIN_AUTH_TOKEN: 'integration-admin-token',
  });
  ({ reconcileAgentOutboundDelivery } = await import('../../src/atendente-v2/outbound-reconcile'));
  ({ supersedeStaleAgentOutbound } = await import('../../src/atendente-v2/outbound-worker'));
  ({ getBotVisao } = await import('../../src/admin/painel/queries-bot-visao'));
  db = await startPostgres();
});
afterAll(async () => { if (db) await stopPostgres(db); });

beforeEach(async () => {
  chatwootConversationId = Math.floor(Math.random() * 1_000_000_000);
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO core.conversations
       (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at)
     VALUES ('test',$1,1,'open',now()) RETURNING id`, [chatwootConversationId]);
  conversationId = result.rows[0].id;
});

async function message(sender: 'contact' | 'user', secondsAgo: number, providerId?: number): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO core.messages
       (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,
        sender_type,message_type,is_private,content,sent_at,created_at)
     VALUES ('test',$1,$2,$3,$4,$5,false,'x',now()-($6||' seconds')::interval,
             now()-($6||' seconds')::interval) RETURNING id`,
    [conversationId, chatwootConversationId,
      providerId ?? Math.floor(Math.random() * 1_000_000_000), sender,
      sender === 'contact' ? 0 : 1, String(secondsAgo)]);
  return result.rows[0].id;
}

async function turn(triggerId: string, actions: unknown[] = []): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO agent.turns
       (environment,conversation_id,trigger_message_id,agent_version,context_hash,say_text,status,actions)
     VALUES ('test',$1,$2,'v2','hash','resposta','generated',$3::jsonb) RETURNING id`,
    [conversationId, triggerId, JSON.stringify(actions)]);
  return result.rows[0].id;
}

async function outbound(triggerId: string, turnId: string, status = 'pending', providerId?: number): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO ops.outbound_messages
       (environment,conversation_id,trigger_message_id,turn_id,chatwoot_conversation_id,
        provider_message_id,echo_id,kind,body,body_sha256,status,sent_at)
     VALUES ('test',$1,$2,$3,$4,$5,$6,'agent_text','resposta','hash',$7,
             CASE WHEN $7='sent_api_ack' THEN now() ELSE NULL END) RETURNING id`,
    [conversationId, triggerId, turnId, chatwootConversationId,
      providerId ?? null, `turn:${turnId}`, status]);
  return result.rows[0].id;
}

describe('Etapa 8 — outbox e DLQ no PostgreSQL real', () => {
  it('blocks cross-environment references at the database boundary', async () => {
    await expect(db.pool.query(
      `INSERT INTO ops.outbound_messages
         (environment,conversation_id,chatwoot_conversation_id,kind,body,body_sha256)
       VALUES ('prod',$1,$2,'agent_text','x','hash')`,
      [conversationId, chatwootConversationId],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps the outbound transition ledger append-only', async () => {
    const triggerId = await message('contact', 10);
    const turnId = await turn(triggerId);
    const outboundId = await outbound(triggerId, turnId);
    const event = await db.pool.query<{ id: string }>(
      `INSERT INTO ops.outbound_message_events
         (environment,outbound_id,from_status,to_status,reason)
       VALUES ('test',$1,'pending','sending','picked') RETURNING id`, [outboundId]);

    await expect(db.pool.query(
      `UPDATE ops.outbound_message_events SET reason='changed' WHERE id=$1`,
      [event.rows[0].id],
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('confirms delivery by provider id and stores the core message proof', async () => {
    const triggerId = await message('contact', 20);
    const turnId = await turn(triggerId);
    const providerId = Math.floor(Math.random() * 1_000_000_000);
    const outboundId = await outbound(triggerId, turnId, 'sent_api_ack', providerId);
    const coreId = await message('user', 0, providerId);

    await expect(reconcileAgentOutboundDelivery(
      db.pool as never, 'test', coreId, providerId,
    )).resolves.toBe(true);
    const saved = await db.pool.query<{ status: string; delivered_message_id: string }>(
      `SELECT status,delivered_message_id FROM agent.turns WHERE id=$1`, [turnId]);
    expect(saved.rows[0]).toEqual({ status: 'delivered', delivered_message_id: coreId });
    const events = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ops.outbound_message_events
        WHERE outbound_id=$1 AND to_status='delivered'`, [outboundId]);
    expect(events.rows[0].count).toBe('1');
  });

  it('extracts analytics on the first outbox delivery transition without duplicating', async () => {
    const triggerId = await message('contact', 20);
    const actions = [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call-product', type: 'function',
            function: {
              name: 'buscar_produto',
              arguments: JSON.stringify({ medida_pneu: '90/90-18' }),
            },
          },
          {
            id: 'call-freight', type: 'function',
            function: {
              name: 'calcular_frete',
              arguments: JSON.stringify({ bairro: 'Itaipuacu' }),
            },
          },
        ],
      },
      {
        role: 'tool', tool_call_id: 'call-product',
        content: JSON.stringify({ encontrado: false }),
      },
      {
        role: 'tool', tool_call_id: 'call-freight',
        content: JSON.stringify({
          encontrado: true, bairro_canonico: 'Itaipuacu', municipio: 'Marica',
          valor: 20, prazo_dias: 1,
        }),
      },
    ];
    const turnId = await turn(triggerId, actions);

    const before = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM analytics.conversation_facts
       WHERE conversation_id=$1`, [conversationId]);
    expect(before.rows[0].count).toBe('0');

    await db.pool.query(
      `UPDATE agent.turns SET status='sent_api_ack', sent_at=now() WHERE id=$1`,
      [turnId],
    );

    const afterAck = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM analytics.conversation_facts
       WHERE conversation_id=$1`, [conversationId]);
    expect(afterAck.rows[0].count).toBe('0');

    await db.pool.query(`UPDATE agent.turns SET status='delivered' WHERE id=$1`, [turnId]);

    const facts = await db.pool.query<{ fact_key: string }>(
      `SELECT fact_key FROM analytics.conversation_facts
       WHERE conversation_id=$1 ORDER BY fact_key`, [conversationId]);
    expect(facts.rows.map((row) => row.fact_key)).toEqual(expect.arrayContaining([
      'bairro_canonico', 'bairro_consultado', 'faltou_estoque',
      'medida_consultada', 'municipio_entrega',
    ]));

    const classifications = await db.pool.query<{ dimension: string }>(
      `SELECT dimension FROM analytics.conversation_classifications
       WHERE conversation_id=$1`, [conversationId]);
    expect(classifications.rows.map((row) => row.dimension)).toContain('stage_reached');

    const factCount = facts.rowCount;
    await db.pool.query(`UPDATE agent.turns SET status='delivered' WHERE id=$1`, [turnId]);
    const afterDelivered = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM analytics.conversation_facts
       WHERE conversation_id=$1`, [conversationId]);
    expect(Number(afterDelivered.rows[0].count)).toBe(factCount);

    const visao = await getBotVisao('today', 'test', db.pool);
    expect(visao.mapa).toEqual(expect.arrayContaining([
      expect.objectContaining({ municipio: 'Marica', chamou: 1 }),
    ]));
    expect(visao.radar).toEqual(expect.arrayContaining([
      expect.objectContaining({ medida: '90/90-18', fora_catalogo: 1 }),
    ]));
    expect(visao.horarios).toHaveLength(24);
    expect(visao.horarios.reduce((total, item) => total + item.conversas, 0)).toBeGreaterThan(0);
  });

  it('supersedes a stale queued draft after a newer customer message', async () => {
    const triggerId = await message('contact', 30);
    const turnId = await turn(triggerId);
    const outboundId = await outbound(triggerId, turnId);
    await message('contact', 0);

    await expect(supersedeStaleAgentOutbound(db.pool as never, 'test')).resolves.toBe(1);
    const saved = await db.pool.query<{ status: string; turn_status: string }>(
      `SELECT o.status,t.status AS turn_status FROM ops.outbound_messages o
       JOIN agent.turns t ON t.id=o.turn_id WHERE o.id=$1`, [outboundId]);
    expect(saved.rows[0]).toEqual({ status: 'superseded', turn_status: 'blocked' });
  });
});
