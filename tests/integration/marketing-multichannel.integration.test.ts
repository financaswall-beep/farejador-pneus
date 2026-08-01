import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcilePendingMetaReferrals } from '../../src/marketing/meta-messaging-referrals.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Marketing multicanal — migration aditiva', () => {
  let db: IntegrationDb;
  let reconcileMarketingAttributions:
    typeof import('../../src/marketing/attribution.js').reconcileMarketingAttributions;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    });
    db = await startPostgres({ throughMigration: '0161_marketing_multichannel_messaging.sql' });
    ({ reconcileMarketingAttributions } = await import('../../src/marketing/attribution.js'));
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('preserva CTWA e adiciona inbox Meta e identidade por canal', async () => {
    const columns = await db.pool.query<{ table_schema: string; table_name: string; column_name: string }>(
      `SELECT table_schema,table_name,column_name
         FROM information_schema.columns
        WHERE (table_schema,table_name,column_name) IN (
          ('core','messages','native_message_id'),
          ('marketing','ad_referrals','channel'),
          ('marketing','ad_referrals','referral_key'),
          ('marketing','ad_referrals','user_scoped_id'),
          ('marketing','ad_referrals','business_account_id')
        )
        ORDER BY table_schema,table_name,column_name`,
    );
    expect(columns.rows).toHaveLength(5);
    const tables = await db.pool.query<{ name: string | null }>(
      `SELECT to_regclass('raw.meta_messaging_events')::text AS name
       UNION ALL
       SELECT to_regclass('marketing.meta_messaging_referrals')::text`,
    );
    expect(tables.rows.map((row) => row.name)).toEqual([
      'raw.meta_messaging_events',
      'marketing.meta_messaging_referrals',
    ]);
  });

  it('mantém o payload Meta bruto imutável e permite só o estado operacional', async () => {
    const inserted = await db.pool.query<{ id: number }>(
      `INSERT INTO raw.meta_messaging_events
         (environment,payload_sha256,signature,object_type,payload)
       VALUES ('test',$1,'sha256=assinatura','page','{"object":"page"}')
       RETURNING id`,
      ['a'.repeat(64)],
    );
    const id = inserted.rows[0]!.id;
    await expect(db.pool.query(
      `UPDATE raw.meta_messaging_events SET payload='{}' WHERE id=$1`,
      [id],
    )).rejects.toThrow(/imutavel/i);
    await expect(db.pool.query(
      `UPDATE raw.meta_messaging_events SET processing_status='processed',processed_at=now()
        WHERE id=$1`,
      [id],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it('casa referral Meta com a mensagem nativa sem erro de tipo no PostgreSQL', async () => {
    const conversation = await db.pool.query<{ id: string }>(
      `INSERT INTO core.conversations (
         environment,chatwoot_conversation_id,chatwoot_account_id,chatwoot_inbox_id,
         channel_type,current_status,started_at
       ) VALUES ('test',91001,1,1,'facebook','open','2026-06-15T12:00:00Z')
       RETURNING id`,
    );
    const conversationId = conversation.rows[0]!.id;
    const message = await db.pool.query<{ id: string }>(
      `INSERT INTO core.messages (
         environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,
         sender_type,message_type,content_attributes,native_message_id,is_private,sent_at
       ) VALUES ('test',92001,$1,91001,'contact',0,'{}','mid.integration.1',false,
                 '2026-06-15T12:00:01Z')
       RETURNING id`,
      [conversationId],
    );
    const rawEvent = await db.pool.query<{ id: number }>(
      `INSERT INTO raw.meta_messaging_events
         (environment,payload_sha256,signature,object_type,payload)
       VALUES ('test',$1,'sha256=assinatura','page','{"object":"page"}')
       RETURNING id`,
      ['b'.repeat(64)],
    );
    await db.pool.query(
      `INSERT INTO marketing.meta_messaging_referrals (
         environment,raw_event_id,provider_event_key,channel,provider_message_id,
         user_scoped_id,business_account_id,ad_id,source_type,occurred_at
       ) VALUES ('test',$1,'event.integration.1','messenger','mid.integration.1',
                 'psid.integration.1','page.integration.1','ad.integration.1','ADS',
                 '2026-06-15T12:00:01Z')`,
      [rawEvent.rows[0]!.id],
    );

    const client = await db.pool.connect();
    try {
      await expect(reconcilePendingMetaReferrals(client, 'test')).resolves.toBe(1);
    } finally {
      client.release();
    }

    const staging = await db.pool.query<{ status: string; matched_message_id: string }>(
      `SELECT status,matched_message_id
         FROM marketing.meta_messaging_referrals
        WHERE environment='test' AND provider_event_key='event.integration.1'`,
    );
    expect(staging.rows[0]).toMatchObject({
      status: 'matched',
      matched_message_id: message.rows[0]!.id,
    });
    const referral = await db.pool.query<{ channel: string; source_id: string }>(
      `SELECT channel,source_id
         FROM marketing.ad_referrals
        WHERE environment='test' AND native_message_id='mid.integration.1'`,
    );
    expect(referral.rows[0]).toEqual({ channel: 'messenger', source_id: 'ad.integration.1' });
  });

  it('atribui uma entrega do Messenger sem ambiguidade nos UUIDs do JSON', async () => {
    const contact = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts (environment,chatwoot_contact_id,name)
       VALUES ('test',93001,'Cliente Messenger') RETURNING id`,
    );
    const conversation = await db.pool.query<{ id: string }>(
      `INSERT INTO core.conversations (
         environment,chatwoot_conversation_id,chatwoot_account_id,chatwoot_inbox_id,
         channel_type,contact_id,current_status,started_at
       ) VALUES ('test',93001,1,1,'facebook',$1,'open',now()-interval '10 minutes')
       RETURNING id`,
      [contact.rows[0]!.id],
    );
    const message = await db.pool.query<{ id: string; sent_at: string }>(
      `INSERT INTO core.messages (
         environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,
         sender_type,message_type,content_attributes,native_message_id,is_private,sent_at
       ) VALUES ('test',93001,$1,93001,'contact',0,'{}','mid.integration.attribution',false,
                 now()-interval '9 minutes')
       RETURNING id,sent_at::text`,
      [conversation.rows[0]!.id],
    );
    await db.pool.query(
      `INSERT INTO marketing.ad_referrals (
         environment,conversation_id,source_message_id,source_message_sent_at,
         channel,referral_key,user_scoped_id,business_account_id,native_message_id,
         source_id,captured_at
       ) VALUES ('test',$1,$2,$3,'messenger','messenger:integration-attribution',
                 'psid.integration.attribution','page.integration.attribution',
                 'mid.integration.attribution','ad.integration.attribution',$3)`,
      [conversation.rows[0]!.id, message.rows[0]!.id, message.rows[0]!.sent_at],
    );
    const order = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.orders (
         environment,contact_id,source_conversation_id,total_amount,status,
         fulfillment_mode,payment_method,delivery_address,delivery_status,delivered_at
       ) VALUES ('test',$1,$2,98.90,'delivered','delivery','pix','Rua Teste, 1',
                 'delivered',now())
       RETURNING id`,
      [contact.rows[0]!.id, conversation.rows[0]!.id],
    );

    const result = await reconcileMarketingAttributions({ dbPool: db.pool, enabled: true });

    expect(result.created).toBe(1);
    const attribution = await db.pool.query<{ order_id: string; source_reference: Record<string, string> }>(
      `SELECT order_id,source_reference
         FROM marketing.order_attributions
        WHERE environment='test' AND order_id=$1 AND status='active'`,
      [order.rows[0]!.id],
    );
    expect(attribution.rows[0]?.order_id).toBe(order.rows[0]!.id);
    expect(attribution.rows[0]?.source_reference).toMatchObject({
      order_id: order.rows[0]!.id,
      channel: 'messenger',
    });
  });
});
