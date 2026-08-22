import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Marketing — integridade causal 0198', () => {
  let db: IntegrationDb;

  beforeAll(async () => {
    db = await startPostgres({ throughMigration: '0198_marketing_integrity.sql' });
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('mantém no máximo uma sincronização Meta em execução por ambiente', async () => {
    await db.pool.query(
      `INSERT INTO marketing.meta_sync_runs
         (environment,trigger_type,window_since,window_until)
       VALUES ('test','manual','2026-08-01','2026-08-21')`,
    );
    await expect(db.pool.query(
      `INSERT INTO marketing.meta_sync_runs
         (environment,trigger_type,window_since,window_until)
       VALUES ('test','scheduled','2026-08-01','2026-08-21')`,
    )).rejects.toThrow(/meta_sync_runs_one_running_uniq/i);
    await expect(db.pool.query(
      `UPDATE marketing.meta_sync_runs SET status='succeeded'
        WHERE environment='test' AND status='running'`,
    )).rejects.toThrow(/meta_sync_runs_lifecycle_check/i);
  });

  it('bloqueia mensagem/conversa divergente e venda fora da janela de 7 dias', async () => {
    const contact = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts (environment,chatwoot_contact_id,name)
       VALUES ('test',98001,'Cliente Integridade Marketing') RETURNING id`,
    );
    const conversations = await db.pool.query<{ id: string }>(
      `INSERT INTO core.conversations (
         environment,chatwoot_conversation_id,chatwoot_account_id,channel_type,
         contact_id,current_status,started_at
       ) VALUES
         ('test',98101,1,'whatsapp',$1,'open','2026-06-15T12:00:00Z'),
         ('test',98102,1,'whatsapp',$1,'open','2026-06-15T12:00:00Z')
       RETURNING id`,
      [contact.rows[0]!.id],
    );
    const firstConversation = conversations.rows[0]!.id;
    const secondConversation = conversations.rows[1]!.id;
    const message = await db.pool.query<{ id: string }>(
      `INSERT INTO core.messages (
         environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,
         sender_type,message_type,content_attributes,is_private,sent_at
       ) VALUES ('test',98201,$1,98101,'contact',0,'{}',false,'2026-06-15T12:00:01Z')
       RETURNING id`,
      [firstConversation],
    );

    await expect(db.pool.query(
      `INSERT INTO marketing.ad_referrals (
         environment,conversation_id,source_message_id,source_message_sent_at,
         channel,referral_key,ctwa_clid,source_id,captured_at
       ) VALUES ('test',$1,$2,'2026-06-15T12:00:01Z','whatsapp',
                 'whatsapp:wrong-conversation','clid-wrong','ad-wrong',
                 '2026-06-15T12:00:01Z')`,
      [secondConversation, message.rows[0]!.id],
    )).rejects.toThrow(/mensagem nao pertence/i);

    const referral = await db.pool.query<{ id: string }>(
      `INSERT INTO marketing.ad_referrals (
         environment,conversation_id,source_message_id,source_message_sent_at,
         channel,referral_key,ctwa_clid,source_id,captured_at
       ) VALUES ('test',$1,$2,'2026-06-15T12:00:01Z','whatsapp',
                 'whatsapp:valid','clid-valid','ad-valid','2026-06-15T12:00:01Z')
       RETURNING id`,
      [firstConversation, message.rows[0]!.id],
    );
    const order = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.orders (
         environment,contact_id,source_conversation_id,total_amount,status,fulfillment_mode,
         payment_method,delivery_status,delivered_at
       ) VALUES ('test',$1,$2,100,'delivered','pickup','pix','delivered',
                 '2026-06-23T12:00:01Z')
       RETURNING id`,
      [contact.rows[0]!.id, firstConversation],
    );

    await expect(db.pool.query(
      `INSERT INTO marketing.order_attributions (
         environment,order_id,referral_id,conversation_id,status,attribution_model,
         rule_version,source_type,truth_type,confidence_level,source_reference,
         extractor_version,realized_at
       ) VALUES ('test',$1,$2,$3,'active','last_message_click_7d',1,
                 'deterministic_meta_messaging','observed',1,'{}','integration',
                 '2026-06-23T12:00:01Z')`,
      [order.rows[0]!.id, referral.rows[0]!.id, firstConversation],
    )).rejects.toThrow(/fora da janela causal/i);
  });
});
