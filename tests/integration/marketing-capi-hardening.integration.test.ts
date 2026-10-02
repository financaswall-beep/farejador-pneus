import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, applyMigrationFile, type IntegrationDb } from './helpers/postgres.js';

describe('CAPI real e recuperação restrita da migration 0252', () => {
  let db: IntegrationDb;
  let capi: typeof import('../../src/marketing/capi.js');
  let queue: string, ambiguous: string, acknowledged: string;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-only', ADMIN_AUTH_TOKEN: 'test-only', MATRIZ_CENTRAL_LEDGER: 'true',
      MARKETING_SCOPE_ENFORCEMENT_ENABLED: 'true', META_CAPI_WHATSAPP_DATASET_ID: '123',
      META_CAPI_WHATSAPP_ACCESS_TOKEN: 'test-only', META_WHATSAPP_BUSINESS_ACCOUNT_ID: '123' });
    db = await startPostgres({ throughMigration: '0251_google_ads_access.sql' });
    process.env.DATABASE_URL = db.connectionString; vi.resetModules();
    const now = new Date(); const month = now.toISOString().slice(0, 7);
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    await db.pool.query(`CREATE TABLE IF NOT EXISTS core.messages_${month.replace('-', '_')} PARTITION OF core.messages
      FOR VALUES FROM ('${month}-01') TO ('${next}')`);
    const contact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
      VALUES('test',991,'Cliente sintético') RETURNING id`)).rows[0].id;
    const conversation = (await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
      channel_type,contact_id,current_status,started_at) VALUES('test',991,1,'whatsapp',$1,'open',now()) RETURNING id`, [contact])).rows[0].id;
    const message = (await db.pool.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,
      chatwoot_conversation_id,sender_type,message_type,content,is_private,sent_at)
      VALUES('test',991,$1,991,'contact',0,'Pneu teste',false,now()) RETURNING id,sent_at`, [conversation])).rows[0];
    const referral = (await db.pool.query(`INSERT INTO marketing.ad_referrals(environment,conversation_id,source_message_id,
      source_message_sent_at,channel,referral_key,ctwa_clid,source_id,captured_at)
      VALUES('test',$1,$2,$3,'whatsapp','capi-test','capi-clid','111',now()) RETURNING id`, [conversation,message.id,message.sent_at])).rows[0].id;
    const order = (await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,source_conversation_id,total_amount,
      status,fulfillment_mode,payment_method,delivery_status,created_at)
      VALUES('test',$1,$2,100,'confirmed','pickup','pix','pending',now()) RETURNING id`, [contact,conversation])).rows[0].id;
    const attribution = (await db.pool.query(`INSERT INTO marketing.order_attributions(environment,order_id,referral_id,conversation_id,
      status,attribution_model,rule_version,source_type,truth_type,confidence_level,source_reference,extractor_version,realized_at)
      VALUES('test',$1,$2,$3,'active','last_message_click_7d',1,'deterministic_meta_messaging','observed',1,'{}','integration',now()) RETURNING id`,
    [order,referral,conversation])).rows[0].id;
    const scope = (await db.pool.query(`INSERT INTO marketing.campaign_scopes(environment,ad_account_id,campaign_id,scope,
      classification_reason,classified_by,classified_at)
      VALUES('test','act_123','10','matrix','Campanha da prova','test',now()) RETURNING id`)).rows[0].id;
    const run = (await db.pool.query(`INSERT INTO marketing.meta_sync_runs(environment,trigger_type,window_since,window_until)
      VALUES('test','manual',current_date,current_date) RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO marketing.meta_identity_accounts(environment,ad_account_id,sync_run_id) VALUES('test','act_123',$1);
      `,[run]);
    await db.pool.query(`INSERT INTO marketing.meta_ad_identities(environment,ad_account_id,ad_id,campaign_id,facebook_page_id,scope)
      VALUES('test','act_123','111','10','1434857906367394','matrix')`);
    const payload = JSON.stringify({data:[{event_name:'Purchase',event_time:Math.floor(Date.now()/1000),messaging_channel:'whatsapp',event_id:'capi-test'}]});
    const rows = (await db.pool.query(`INSERT INTO marketing.capi_outbox(environment,attribution_id,campaign_scope_id,event_id,payload,
      status,attempts,last_error_summary,events_received)
      VALUES('test',$1,$2,'known-sql',$3,'dead_letter',5,'column "ad_account_id" does not exist',NULL),
        ('test',$1,$2,'ambiguous',$3,'dead_letter',5,'network timeout',NULL),
        ('test',$1,$2,'acknowledged',$3,'dead_letter',5,'column "ad_account_id" does not exist',1)
      RETURNING id,event_id`, [attribution,scope,payload])).rows;
    queue = rows.find(row=>row.event_id==='known-sql').id;
    ambiguous = rows.find(row=>row.event_id==='ambiguous').id;
    acknowledged = rows.find(row=>row.event_id==='acknowledged').id;
    await applyMigrationFile(db.pool, '0252_marketing_integration_hardening.sql');
    capi = await import('../../src/marketing/capi.js');
  },240_000);
  afterAll(async () => {
    if(db) await stopPostgres(db);
    const {pool}=await import('../../src/persistence/db.js'); await pool.end();
  });
  it('reabre só a falha SQL anterior ao POST, mantendo eventos ambíguos e reconhecidos fechados',async()=>{
    const rows=(await db.pool.query(`SELECT id,status,attempts FROM marketing.capi_outbox WHERE environment='test'`)).rows;
    expect(rows.find(row=>row.id===queue)).toMatchObject({status:'failed',attempts:0});
    expect(rows.find(row=>row.id===ambiguous)).toMatchObject({status:'dead_letter',attempts:5});
    expect(rows.find(row=>row.id===acknowledged)).toMatchObject({status:'dead_letter',attempts:5});
  });
  it('executa a fila real, revalida o anúncio no SQL e confirma somente um POST simulado',async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({events_received:1,fbtrace_id:'test-trace'}));
    expect(await capi.pollCapiOutbox({dbPool:db.pool,fetcher})).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await db.pool.query(`SELECT status,events_received,attempts FROM marketing.capi_outbox WHERE id=$1`,[queue])).rows[0])
      .toMatchObject({status:'sent',events_received:1,attempts:1});
    expect(await capi.pollCapiOutbox({dbPool:db.pool,fetcher})).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('suprime um evento cuja identidade mudou antes do envio',async()=>{
    await db.pool.query(`UPDATE marketing.meta_ad_identities SET scope='external' WHERE environment='test' AND ad_id='111'`);
    await db.pool.query(`UPDATE marketing.capi_outbox SET status='pending',attempts=0,not_before=now() WHERE id=$1`,[ambiguous]);
    const fetcher=vi.fn(); expect(await capi.pollCapiOutbox({dbPool:db.pool,fetcher,scopeEnforcement:false})).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await db.pool.query(`SELECT status FROM marketing.capi_outbox WHERE id=$1`,[ambiguous])).rows[0].status).toBe('suppressed');
  });
});
