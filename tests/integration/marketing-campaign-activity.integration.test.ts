import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

async function seed(db: Pool, index: number, environment: string, campaign: string, day: string, status: string) {
  const at = `${day}T12:00:00Z`;
  const contact = (await db.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
    VALUES ($1,$2,'Cliente teste') RETURNING id`, [environment, index])).rows[0].id;
  const conversation = (await db.query(`INSERT INTO core.conversations
    (environment,chatwoot_conversation_id,chatwoot_account_id,channel_type,contact_id,current_status,started_at)
    VALUES ($1,$2,1,'whatsapp',$3,'open',$4) RETURNING id`, [environment, index, contact, at])).rows[0].id;
  const message = (await db.query(`INSERT INTO core.messages
    (environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,content_attributes,is_private,sent_at)
    VALUES ($1,$2,$3,$2,'contact',0,'{}',false,$4) RETURNING id`, [environment, index, conversation, at])).rows[0].id;
  const ad = String(index);
  const referral = (await db.query(`INSERT INTO marketing.ad_referrals
    (environment,conversation_id,source_message_id,source_message_sent_at,channel,referral_key,ctwa_clid,source_id,captured_at)
    VALUES ($1,$2,$3,$4,'whatsapp',$5,$5,$6,$4) RETURNING id`,
  [environment, conversation, message, at, `campaign-activity:${index}`, ad])).rows[0].id;
  // Duas linhas diárias do mesmo anúncio não podem duplicar uma conversão.
  await db.query(`INSERT INTO marketing.meta_insights_daily
    (environment,ad_account_id,api_version,account_currency,entity_level,entity_id,campaign_id,metric_date,spend,conversations,actions_raw)
    SELECT $1,'act_123','v26.0','BRL','ad',$2,$3,$4::date+n,20,4,'[]'::jsonb FROM generate_series(0,1) n`,
  [environment, ad, campaign, day]);
  const order = (await db.query(`INSERT INTO commerce.orders
    (environment,contact_id,source_conversation_id,total_amount,status,fulfillment_mode,payment_method,delivery_status,created_at)
    VALUES ($1,$2,$3,100,'confirmed','pickup','pix','pending',$4) RETURNING id`,
  [environment, contact, conversation, at])).rows[0].id;
  const attribution = (await db.query(`INSERT INTO marketing.order_attributions
    (environment,order_id,referral_id,conversation_id,status,attribution_model,rule_version,source_type,truth_type,confidence_level,source_reference,extractor_version,realized_at)
    VALUES ($1,$2,$3,$4,'active','last_message_click_7d',1,'deterministic_meta_messaging','observed',1,'{}','integration',$5) RETURNING id`,
  [environment, order, referral, conversation, at])).rows[0].id;
  await db.query(`INSERT INTO marketing.capi_outbox(environment,attribution_id,event_id,payload,status,attempts)
    VALUES ($1,$2,$3,'{"sensitive":"never return"}',$4,1)`, [environment, attribution, `event:${index}`, status]);
}

describe('Campanha — envios à Meta isolados por ambiente e período', () => {
  let db: IntegrationDb;
  let load: typeof import('../../src/admin/painel/queries-marketing-campaign-activity.js').loadCampaignConversions;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-only', ADMIN_AUTH_TOKEN: 'test-only', META_ADS_ACCOUNT_ID: 'act_123' });
    db = await startPostgres();
    await db.pool.query(`CREATE TABLE IF NOT EXISTS core.messages_2026_08 PARTITION OF core.messages
      FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
      CREATE TABLE IF NOT EXISTS core.messages_2026_09 PARTITION OF core.messages
      FOR VALUES FROM ('2026-09-01') TO ('2026-10-01')`);
    process.env.DATABASE_URL = db.connectionString;
    vi.resetModules();
    ({ loadCampaignConversions: load } = await import('../../src/admin/painel/queries-marketing-campaign-activity.js'));
    await seed(db.pool, 99101, 'test', '10', '2026-09-29', 'sent');
    await seed(db.pool, 99102, 'test', '10', '2026-09-29', 'pending');
    await seed(db.pool, 99103, 'test', '20', '2026-09-29', 'failed');
    await seed(db.pool, 99104, 'prod', '10', '2026-09-29', 'sent');
    await seed(db.pool, 99105, 'test', '10', '2026-08-10', 'failed');
  }, 240_000);
  afterAll(async () => {
    if (db) await stopPostgres(db);
    const { pool } = await import('../../src/persistence/db.js');
    await pool.end();
  });
  it('não duplica eventos pelos dias de insight nem mistura campanhas, ambientes ou datas', async () => {
    const result = await load('10', '2026-09-01', '2026-09-30', db.pool);
    expect(result).toMatchObject({ available: true, sent: 1, pending: 1, failed: 0 });
    expect(result.events).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(result.events.every(event => !('payload' in event))).toBe(true);
  });
  it('retorna zero somente quando a consulta foi concluída sem envios', async () => {
    expect(await load('30', '2026-09-01', '2026-09-30', db.pool)).toMatchObject({
      available: true, sent: 0, pending: 0, failed: 0, events: [],
    });
  });
});
