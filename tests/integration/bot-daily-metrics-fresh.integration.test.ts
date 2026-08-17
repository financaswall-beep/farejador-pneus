import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrationFile,
  startPostgres,
  stopPostgres,
  type IntegrationDb,
} from './helpers/postgres.js';

let getBotVisao: typeof import('../../src/admin/painel/queries-bot-visao').getBotVisao;

describe('0177 - metricas diarias do Bot no schema greenfield', () => {
  let db: IntegrationDb;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      FAREJADOR_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/farejador_test',
      CHATWOOT_HMAC_SECRET: 'integration-secret',
      ADMIN_AUTH_TOKEN: 'integration-admin-token',
    });
    ({ getBotVisao } = await import('../../src/admin/painel/queries-bot-visao'));
    db = await startPostgres({ throughMigration: '0176_matriz_operation_stock_permission.sql' });
    await applyMigrationFile(db.pool, '0177_bot_daily_metrics_fresh_schema.sql');
  }, 120_000);

  afterAll(async () => {
    await stopPostgres(db);
  }, 30_000);

  it('cria a view que faltava e permite reaplicar a migration', async () => {
    const before = await db.pool.query<{ view_name: string | null }>(
      `SELECT to_regclass('analytics.v_daily_metrics')::text AS view_name`,
    );
    expect(before.rows[0]?.view_name).toBe('analytics.v_daily_metrics');

    await expect(applyMigrationFile(db.pool, '0177_bot_daily_metrics_fresh_schema.sql'))
      .resolves.toBeUndefined();
  });

  it('alimenta os cards por ambiente sem contar pedido cancelado', async () => {
    const contacts = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts (environment, chatwoot_contact_id, name)
       VALUES ('test', 977001, 'BOT DAILY TEST'),
              ('prod', 977002, 'BOT DAILY PROD')
       RETURNING id`,
    );
    const testContactId = contacts.rows[0]!.id;
    const prodContactId = contacts.rows[1]!.id;

    const conversations = await db.pool.query<{ id: string; chatwoot_conversation_id: string }>(
      `INSERT INTO core.conversations
         (environment, chatwoot_conversation_id, chatwoot_account_id, contact_id,
          current_status, started_at, last_activity_at)
       VALUES
         ('test', 977001, 977, $1, 'resolved',
          (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')+interval '10 minutes', now()),
         ('test', 977002, 977, $1, 'open',
          (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')+interval '20 minutes', now()),
         ('test', 977003, 977, $1, 'resolved',
          (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')+interval '30 minutes', now()),
         ('test', 977004, 977, $1, 'resolved',
          (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')+interval '40 minutes', now()),
         ('prod', 977005, 977, $2, 'resolved',
          (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')+interval '50 minutes', now())
       RETURNING id, chatwoot_conversation_id::text`,
      [testContactId, prodContactId],
    );
    const byChatwoot = new Map(conversations.rows.map((row) => [row.chatwoot_conversation_id, row.id]));
    const saleId = byChatwoot.get('977001')!;
    const escalatedId = byChatwoot.get('977002')!;
    const abandonedId = byChatwoot.get('977003')!;
    const cancelledId = byChatwoot.get('977004')!;

    const messages = await db.pool.query<{ id: string; chatwoot_conversation_id: string }>(
      `INSERT INTO core.messages
         (environment, chatwoot_message_id, conversation_id, chatwoot_conversation_id,
          sender_type, message_type, content, is_private, sent_at)
       VALUES
         ('test', 9770011, $1, 977001, 'contact', 0, 'quero comprar', false,
          (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')+interval '10 minutes'),
         ('test', 9770012, $1, 977001, 'agent_bot', 1, 'resposta', false,
          (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')+interval '11 minutes'),
         ('test', 9770021, $2, 977002, 'contact', 0, 'quero humano', false,
          (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')+interval '20 minutes'),
         ('test', 9770031, $3, 977003, 'contact', 0, 'oi', false,
          (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')+interval '30 minutes'),
         ('test', 9770041, $4, 977004, 'contact', 0, 'cancelei', false,
          (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')+interval '40 minutes')
       RETURNING id, chatwoot_conversation_id::text`,
      [saleId, escalatedId, abandonedId, cancelledId],
    );
    const saleMessageId = messages.rows.find((row) => row.chatwoot_conversation_id === '977001')!.id;

    await db.pool.query(
      `INSERT INTO agent.turns
         (environment, conversation_id, trigger_message_id, agent_version, context_hash,
          status, llm_input_tokens, llm_output_tokens)
       VALUES ('test', $1, $2, 'v2', 'daily-metrics', 'delivered', 1000, 500)`,
      [saleId, saleMessageId],
    );
    await db.pool.query(
      `INSERT INTO analytics.conversation_facts
         (environment, conversation_id, fact_key, fact_value, truth_type, source, extractor_version)
       VALUES ('test', $1, 'escalou', 'true'::jsonb, 'observed', 'integration_test', '0177_test')`,
      [escalatedId],
    );
    await db.pool.query(
      `INSERT INTO commerce.orders
         (environment, contact_id, source_conversation_id, total_amount, status,
          fulfillment_mode, source)
       VALUES ('test', $1, $2, 350, 'delivered', 'pickup', 'bot_promoted'),
              ('test', $1, $3, 999, 'cancelled', 'pickup', 'bot_promoted')`,
      [testContactId, saleId, cancelledId],
    );

    const view = await db.pool.query<{
      conversas_total: string;
      fecharam: string;
      escalaram: string;
      abandonaram: string;
      faturamento: string;
      ticket_medio: string;
      resposta_media_seg: string;
      tokens_total: string;
      custo_bot_brl: string;
      bucket_total: string;
    }>(
      `SELECT conversas_total, fecharam, escalaram, abandonaram,
              faturamento, ticket_medio, resposta_media_seg, tokens_total, custo_bot_brl,
              (conv_madrugada + conv_manha + conv_tarde + conv_noite)::text AS bucket_total
       FROM analytics.v_daily_metrics
       WHERE environment = 'test'
         AND dia = (now() AT TIME ZONE 'America/Sao_Paulo')::date`,
    );
    expect(view.rows[0]).toMatchObject({
      conversas_total: '4',
      fecharam: '1',
      escalaram: '1',
      abandonaram: '2',
      faturamento: '350.00',
      ticket_medio: '350.00',
      resposta_media_seg: '60',
      tokens_total: '1500',
      custo_bot_brl: '0.01',
      bucket_total: '4',
    });

    const payload = await getBotVisao('today', 'test', db.pool);
    expect(payload.cards).toMatchObject({
      conversas: 4,
      fecharam: 1,
      escalaram: 1,
      abandonaram: 2,
      faturamento: '350.00',
      ticket_medio: '350.00',
      resposta_seg: 60,
      respondidas_bot_48h: 1,
    });

    const prod = await db.pool.query<{ conversas_total: string }>(
      `SELECT conversas_total FROM analytics.v_daily_metrics
       WHERE environment = 'prod'
         AND dia = (now() AT TIME ZONE 'America/Sao_Paulo')::date`,
    );
    expect(prod.rows[0]?.conversas_total).toBe('1');
  });
});
