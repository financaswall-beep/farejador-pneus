import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Anúncios — resultado com o motor de atribuição existente', () => {
  let db: IntegrationDb;
  let getCreatives: typeof import('../../src/admin/painel/queries-marketing-creatives.js').getMarketingCreatives;
  let orderId: string;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin', MARKETING_SCOPE_ENFORCEMENT_ENABLED: 'true' });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    vi.resetModules();
    ({ getMarketingCreatives: getCreatives } = await import('../../src/admin/painel/queries-marketing-creatives.js'));
    const contact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
      VALUES ('test',99051,'Cliente de teste') RETURNING id`)).rows[0].id;
    const conversation = (await db.pool.query(`INSERT INTO core.conversations
      (environment,chatwoot_conversation_id,chatwoot_account_id,channel_type,contact_id,current_status,started_at)
      VALUES ('test',99051,1,'whatsapp',$1,'open','2026-09-29T10:00:00Z') RETURNING id`, [contact])).rows[0].id;
    const message = (await db.pool.query(`INSERT INTO core.messages
      (environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,content_attributes,is_private,sent_at)
      VALUES ('test',99051,$1,99051,'contact',0,'{}',false,'2026-09-29T10:00:00Z') RETURNING id`, [conversation])).rows[0].id;
    const referral = (await db.pool.query(`INSERT INTO marketing.ad_referrals
      (environment,conversation_id,source_message_id,source_message_sent_at,channel,referral_key,ctwa_clid,source_id,captured_at)
      VALUES ('test',$1,$2,'2026-09-29T10:00:00Z','whatsapp','ads-results:1','test-ads-clid','111','2026-09-29T10:00:00Z') RETURNING id`, [conversation, message])).rows[0].id;
    await db.pool.query(`INSERT INTO marketing.meta_insights_daily
      (environment,ad_account_id,api_version,account_currency,entity_level,entity_id,campaign_id,metric_date,spend,conversations,actions_raw)
      VALUES ('test','act_123','v26.0','BRL','ad','111','10','2026-09-29',20,4,'[]')`);
    await db.pool.query(`UPDATE marketing.campaign_scopes SET scope='matrix',classification_reason='Teste',classified_by='integration',classified_at=now()
      WHERE environment='test' AND ad_account_id='act_123' AND campaign_id='10'`);
    const product = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type)
      VALUES ('test','ADS-RESULT-TEST','Pneu de teste','tire') RETURNING id`)).rows[0].id;
    orderId = (await db.pool.query(`INSERT INTO commerce.orders
      (environment,contact_id,source_conversation_id,total_amount,status,fulfillment_mode,payment_method,delivery_status,created_at)
      VALUES ('test',$1,$2,100,'confirmed','pickup','pix','pending','2026-09-29T12:00:00Z') RETURNING id`, [contact, conversation])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price)
      VALUES ('test',$1,$2,1,100)`, [orderId, product]);
    await db.pool.query(`INSERT INTO marketing.order_attributions
      (environment,order_id,referral_id,conversation_id,status,attribution_model,rule_version,source_type,truth_type,confidence_level,source_reference,extractor_version,realized_at)
      VALUES ('test',$1,$2,$3,'active','last_message_click_7d',1,'deterministic_meta_messaging','observed',1,'{}','integration','2026-09-29T12:00:00Z')`, [orderId, referral, conversation]);
  }, 240_000);
  afterAll(async () => {
    if (db) await stopPostgres(db);
    const { pool } = await import('../../src/persistence/db.js');
    await pool.end();
  });
  const read = () => getCreatives('7d', { dbPool: db.pool, now: new Date('2026-09-30T12:00:00Z'),
    config: { adAccountId: 'act_123', accessToken: 'test-only', apiVersion: 'v26.0' },
    attributionEnabled: true, enforceScope: true, mediaProvider: async () => ({ ads: [], unavailable: 1 }) });
  it('não inventa lucro quando falta custo do pneu', async () => {
    expect((await read()).creatives[0]).toMatchObject({ investment: 20, attributed_sales: 1,
      attributed_revenue: 100, pending_margin_orders: 1, net_after_media: null });
  });
  it('desconta o custo do pneu e a mídia uma única vez', async () => {
    await db.pool.query('UPDATE commerce.order_items SET matriz_unit_cost=60 WHERE environment=$1 AND order_id=$2', ['test', orderId]);
    expect((await read()).creatives[0]).toMatchObject({ attributed_sales: 1, gross_margin: 40, net_after_media: 20, pending_margin_orders: 0 });
  });
  it('exclui venda cancelada sem apagar a atribuição histórica', async () => {
    await db.pool.query("UPDATE commerce.orders SET status='cancelled' WHERE environment='test' AND id=$1", [orderId]);
    expect((await read()).creatives[0]).toMatchObject({ attributed_sales: 0, attributed_revenue: 0, net_after_media: -20 });
    expect((await db.pool.query('SELECT count(*)::int n FROM marketing.order_attributions WHERE order_id=$1', [orderId])).rows[0].n).toBe(1);
  });
});
