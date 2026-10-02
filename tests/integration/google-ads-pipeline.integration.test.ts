import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
import type {GoogleAdsSnapshot} from '../../src/marketing/google-ads.js';
import type {GoogleAdsConfig} from '../../src/marketing/google-ads-client.js';

describe('Google Ads — livro central, atribuicao e entrega',()=>{
  let db:IntegrationDb;
  let sync:typeof import('../../src/marketing/google-sync.js').syncGoogleAds;
  let reconcile:typeof import('../../src/marketing/google-attribution.js').reconcileGoogleAttributions;
  let meta:typeof import('../../src/marketing/attribution.js').reconcileMarketingAttributions;
  let results:typeof import('../../src/marketing/google-results.js').getGoogleResults;
  let process:typeof import('../../src/marketing/google-conversions.js').processGoogleConversions;
  let order:string,conversation:string,click:string;
  const config:GoogleAdsConfig={environment:'test',customerId:'1234567890',apiVersion:'v25',scope:'account',campaignIds:[],serviceAccountJson:'test-only'};
  const snapshot=(cost='20000000'):GoogleAdsSnapshot=>({account:{id:config.customerId,name:'2W',currency:'BRL',time_zone:'America/Sao_Paulo',scope:'account'},
    period:{since:'2026-09-25',until:'2026-10-01'},fetched_at:'2026-10-01T14:00:00Z',
    campaigns:[{id:'11',name:'Pneus',status:'ENABLED',channel_type:'SEARCH',investment:Number(cost)/1e6,impressions:100,clicks:10,conversions:0,ctr:10,cpc:2,delivery_days:1,last_delivery:'2026-10-01'}],
    totals:{investment:Number(cost)/1e6,impressions:100,clicks:10,conversions:0,ctr:10,cpc:2},daily:[],
    campaign_daily:[{campaign_id:'11',date:'2026-10-01',cost_micros:cost,impressions:100,clicks:10,conversions:0}],
    ads:[{id:'22:33',ad_id:'33',ad_group_id:'22',campaign_id:'11',name:'Oferta',campaign_name:'Pneus',status:'ENABLED',format:'RESPONSIVE_SEARCH_AD',
      headlines:['Pneus'],descriptions:[],final_url:null,investment:999,impressions:100,clicks:10,conversions:0,conversion_value:0,ctr:10,cpc:2,cpm:200,
      daily:[{date:'2026-10-01',cost_micros:cost,investment:Number(cost)/1e6,impressions:100,clicks:10,conversions:0}]}]});
  beforeAll(async()=>{
    Object.assign(processEnv(),{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',
      MATRIZ_CENTRAL_LEDGER:'true',GOOGLE_ADS_ENABLED:'true',GOOGLE_ADS_CUSTOMER_ID:config.customerId,GOOGLE_ADS_SCOPE:'account',
      GOOGLE_ADS_SERVICE_ACCOUNT_JSON:'test-only',GOOGLE_ADS_CONVERSIONS_ENABLED:'true',GOOGLE_ADS_CONVERSION_ACTION_ID:'987'});
    db=await startPostgres();processEnv().DATABASE_URL=db.connectionString;vi.resetModules();
    ({syncGoogleAds:sync}=await import('../../src/marketing/google-sync.js'));
    ({reconcileGoogleAttributions:reconcile}=await import('../../src/marketing/google-attribution.js'));
    ({reconcileMarketingAttributions:meta}=await import('../../src/marketing/attribution.js'));
    ({getGoogleResults:results}=await import('../../src/marketing/google-results.js'));
    ({processGoogleConversions:process}=await import('../../src/marketing/google-conversions.js'));
  },240_000);
  afterAll(async()=>{if(db)await stopPostgres(db);const {pool}=await import('../../src/persistence/db.js');await pool.end();});
  const expense=async()=>Number((await db.pool.query(`SELECT COALESCE(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END),0) n
    FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
    WHERE t.environment='test' AND t.source_type='marketing.google_spend.adjustment' AND e.account_code='marketing_expense'`)).rows[0].n);
  it('nao contabiliza historico sem data inicial; recoleta nao duplica; corrige a diferenca',async()=>{
    await sync({dbPool:db.pool,config,snapshot:snapshot(),financeSince:null});expect(await expense()).toBe(0);
    await sync({dbPool:db.pool,config,snapshot:snapshot(),financeSince:'2026-10-01'});expect(await expense()).toBe(20);
    await sync({dbPool:db.pool,config,snapshot:snapshot(),financeSince:'2026-10-01'});expect(await expense()).toBe(20);
    await sync({dbPool:db.pool,config,snapshot:snapshot('15000000'),financeSince:'2026-10-01'});expect(await expense()).toBe(15);
  });
  it('faz vinculo explicito, nao inventa lucro sem custo e nao atribui a mesma venda na Meta',async()=>{
    const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name) VALUES('test',99801,'Teste isolado') RETURNING id`)).rows[0].id;
    conversation=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,channel_type,contact_id,current_status,started_at)
      VALUES('test',99801,1,'whatsapp',$1,'open','2026-09-30T10:00:00Z') RETURNING id`,[contact])).rows[0].id;
    click=(await db.pool.query(`INSERT INTO marketing.google_clicks(environment,account_id,campaign_id,ad_group_id,ad_id,reference,identifier_type,identifier,identifier_hash,
      consent_ad_user_data,destination,captured_at) VALUES('test','1234567890','11','22','33',$1,'gclid','test-click','test-hash',true,'whatsapp','2026-09-30T10:00:00Z') RETURNING id`,['2W-G'+'a'.repeat(32)])).rows[0].id;
    await db.pool.query(`CREATE TABLE IF NOT EXISTS core.messages_2026_09 PARTITION OF core.messages FOR VALUES FROM('2026-09-01') TO('2026-10-01')`);
    const message=(await db.pool.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,content,is_private,sent_at)
      VALUES('test',99801,$1,99801,'contact',0,$2,false,'2026-09-30T10:01:00Z') RETURNING id`,[conversation,'Quero pneu. Ref: 2W-G'+'a'.repeat(32)])).rows[0].id;
    // Referral Meta anterior. Google e o ultimo clique observado.
    await db.pool.query(`INSERT INTO marketing.ad_referrals(environment,conversation_id,source_message_id,source_message_sent_at,channel,referral_key,ctwa_clid,source_id,captured_at)
      VALUES('test',$1,$2,'2026-09-30T09:00:00Z','whatsapp','google-meta-test','google-meta-clid','meta-old','2026-09-30T09:00:00Z')`,[conversation,message]);
    const product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type)
      VALUES('test','GOOGLE-TEST','Pneu teste','tire') RETURNING id`)).rows[0].id;
    order=(await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,source_conversation_id,total_amount,status,fulfillment_mode,payment_method,delivery_status,created_at)
      VALUES('test',$1,$2,100,'confirmed','pickup','pix','pending','2026-09-30T12:00:00Z') RETURNING id`,[contact,conversation])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price) VALUES('test',$1,$2,1,100)`,[order,product]);
    expect((await meta({dbPool:db.pool,enabled:true})).created).toBe(0);
    expect((await reconcile({dbPool:db.pool})).created).toBe(1);
    expect((await reconcile({dbPool:db.pool})).created).toBe(0);
    expect((await results(config.customerId,'2026-09-25','2026-10-01',db.pool)).totals).toMatchObject({attributed_sales:1,attributed_revenue:100,gross_margin:null,pending_margin_orders:1});
    await db.pool.query(`UPDATE commerce.order_items SET matriz_unit_cost=60 WHERE environment='test' AND order_id=$1`,[order]);
    expect((await results(config.customerId,'2026-09-25','2026-10-01',db.pool)).totals.gross_margin).toBe(40);
    expect((await results('9999999999','2026-09-25','2026-10-01',db.pool)).totals.attributed_sales).toBe(0);
  });
  it('um POST aceito so e confirmado apos consulta; recoleta nao envia de novo',async()=>{
    const transport={ingest:vi.fn().mockResolvedValue('request-test'),status:vi.fn().mockResolvedValue('sent')};
    await process({dbPool:db.pool,transport});expect(transport.ingest).toHaveBeenCalledTimes(1);
    expect(transport.ingest.mock.calls[0][0]).toMatchObject({conversionValue:100,eventSource:'MESSAGE',adIdentifiers:{gclid:'test-click'}});
    expect((await db.pool.query(`SELECT status FROM marketing.google_conversion_outbox WHERE environment='test'`)).rows[0].status).toBe('accepted');
    const acceptedReport=await results(config.customerId,'2026-09-25','2026-10-01',db.pool);
    expect(acceptedReport.pipeline).toMatchObject({accepted:1,sent:0});
    expect(acceptedReport.totals.tracked_conversations).toBe(1);
    expect((await results(config.customerId,'2026-10-01','2026-10-01',db.pool)).pipeline.accepted).toBe(0);
    expect((await results('9999999999','2026-09-25','2026-10-01',db.pool)).pipeline.accepted).toBe(0);
    await db.pool.query(`UPDATE marketing.google_conversion_outbox SET not_before=now() WHERE environment='test'`);
    await process({dbPool:db.pool,transport});await process({dbPool:db.pool,transport});
    expect(transport.ingest).toHaveBeenCalledTimes(1);expect(transport.status).toHaveBeenCalledTimes(1);
    expect((await db.pool.query(`SELECT status FROM marketing.google_conversion_outbox WHERE environment='test'`)).rows[0].status).toBe('sent');
    expect((await results(config.customerId,'2026-09-25','2026-10-01',db.pool)).pipeline).toMatchObject({accepted:0,sent:1});
  });
  it('envio ambiguo exige revisao e nunca repete o POST automaticamente',async()=>{
    const {GoogleIngestAmbiguous}=await import('../../src/marketing/google-data-manager.js');
    await db.pool.query(`UPDATE marketing.google_conversion_outbox SET status='pending',request_id=NULL,not_before=now() WHERE environment='test'`);
    const transport={ingest:vi.fn().mockRejectedValue(new GoogleIngestAmbiguous()),status:vi.fn()};
    await process({dbPool:db.pool,transport});await process({dbPool:db.pool,transport});
    expect(transport.ingest).toHaveBeenCalledTimes(1);
    expect((await db.pool.query(`SELECT status,last_error_code FROM marketing.google_conversion_outbox WHERE environment='test'`)).rows[0])
      .toMatchObject({status:'review',last_error_code:'google_ingest_ambiguous'});
    // Restabelece o envio confirmado da prova anterior para testar cancelamento posterior.
    await db.pool.query(`UPDATE marketing.google_conversion_outbox SET status='sent',request_id='request-test' WHERE environment='test'`);
  });
  it('preserva historico ao cancelar, aponta ajuste de envio confirmado e bloqueia troca de ambiente',async()=>{
    await expect(db.pool.query(`UPDATE marketing.google_clicks SET environment='prod' WHERE id=$1`,[click])).rejects.toThrow(/environment/i);
    await expect(db.pool.query(`UPDATE marketing.google_order_attributions SET confidence_level=.5 WHERE environment='test'`)).rejects.toThrow(/immutable/i);
    await expect(db.pool.query(`INSERT INTO marketing.google_click_conversations(environment,click_id,conversation_id,source,observed_at)
      VALUES('prod',$1,$2,'message_reference',now())`,[click,conversation])).rejects.toThrow(/foreign key/i);
    await db.pool.query(`UPDATE commerce.orders SET status='cancelled' WHERE environment='test' AND id=$1`,[order]);
    expect((await reconcile({dbPool:db.pool})).revoked).toBe(1);
    expect((await results(config.customerId,'2026-09-25','2026-10-01',db.pool)).totals.attributed_sales).toBe(0);
    await process({dbPool:db.pool,transport:{ingest:vi.fn(),status:vi.fn()}});
    expect((await db.pool.query(`SELECT status,last_error_code FROM marketing.google_conversion_outbox WHERE environment='test'`)).rows[0])
      .toMatchObject({status:'review',last_error_code:'sent_sale_cancelled'});
    expect((await results(config.customerId,'2026-09-25','2026-10-01',db.pool)).pipeline.review).toBe(1);
    expect((await db.pool.query(`SELECT count(*)::int n FROM marketing.google_order_attributions WHERE environment='test'`)).rows[0].n).toBe(2);
  });
  it('vincula o widget web; nota privada e mensagem de funcionario nao comprovam clique',async()=>{
    const reference='2W-G'+'b'.repeat(32);
    const contact=(await db.pool.query(`SELECT contact_id FROM core.conversations WHERE id=$1`,[conversation])).rows[0].contact_id;
    const web=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,channel_type,contact_id,current_status,started_at,last_event_at,custom_attributes)
      VALUES('test',99802,1,'web',$1,'open','2026-09-30T10:00:00Z','2026-09-30T10:05:00Z',$2) RETURNING id`,[contact,JSON.stringify({farejador_google_click_ref:reference})])).rows[0].id;
    const webClick=(await db.pool.query(`INSERT INTO marketing.google_clicks(environment,account_id,campaign_id,ad_group_id,ad_id,reference,identifier_type,identifier,identifier_hash,consent_ad_user_data,destination,captured_at)
      VALUES('test','1234567890','11','22','33',$1,'gclid','web-test','web-hash',true,'web','2026-09-30T10:00:00Z') RETURNING id`,[reference])).rows[0].id;
    const privateRef='2W-G'+'c'.repeat(32);
    const privateClick=(await db.pool.query(`INSERT INTO marketing.google_clicks(environment,account_id,campaign_id,ad_group_id,ad_id,reference,identifier_type,identifier,identifier_hash,consent_ad_user_data,destination,captured_at)
      VALUES('test','1234567890','11','22','33',$1,'gclid','private-test','private-hash',true,'whatsapp','2026-09-30T10:00:00Z') RETURNING id`,[privateRef])).rows[0].id;
    for(const [id,sender,type,privateMessage] of [[99802,'contact',0,true],[99803,'user',1,false]]) {
      await db.pool.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,content,is_private,sent_at)
        VALUES('test',$1,$2,99801,$3,$4,$5,$6,'2026-09-30T10:02:00Z')`,[id,conversation,sender,type,privateRef,privateMessage]);
    }
    await reconcile({dbPool:db.pool});
    expect((await db.pool.query(`SELECT conversation_id,source FROM marketing.google_click_conversations WHERE click_id=$1`,[webClick])).rows[0])
      .toMatchObject({conversation_id:web,source:'web_custom_attribute'});
    expect((await db.pool.query(`SELECT count(*)::int n FROM marketing.google_click_conversations WHERE click_id=$1`,[privateClick])).rows[0].n).toBe(0);
  });
  it('conta uma conversa só uma vez no total, mesmo vinculada a campanhas diferentes',async()=>{
    await db.pool.query(`INSERT INTO marketing.google_campaigns(environment,account_id,campaign_id,name,status,channel_type,owned)
      VALUES('test','1234567890','44','Outra campanha 2W','ENABLED','SEARCH',true)`);
    await db.pool.query(`INSERT INTO marketing.google_ads(environment,account_id,ad_group_id,ad_id,campaign_id,name,status,format)
      VALUES('test','1234567890','22','55','44','Outro anuncio','ENABLED','RESPONSIVE_SEARCH_AD')`);
    const anotherClick=(await db.pool.query(`INSERT INTO marketing.google_clicks(environment,account_id,campaign_id,ad_group_id,ad_id,
      reference,identifier_type,identifier,identifier_hash,consent_ad_user_data,destination,captured_at)
      VALUES('test','1234567890','44','22','55',$1,'gclid','other-test','other-hash',true,'whatsapp','2026-09-30T10:10:00Z') RETURNING id`,
      ['2W-G'+'d'.repeat(32)])).rows[0].id;
    await db.pool.query(`INSERT INTO marketing.google_click_conversations(environment,click_id,conversation_id,source,observed_at)
      VALUES('test',$1,$2,'message_reference','2026-09-30T10:11:00Z')`,[anotherClick,conversation]);
    const report=await results(config.customerId,'2026-09-25','2026-10-01',db.pool);
    expect(report.campaigns.find(row=>row.id==='11')?.tracked_conversations).toBe(2);
    expect(report.campaigns.find(row=>row.id==='44')?.tracked_conversations).toBe(1);
    expect(report.totals.tracked_conversations).toBe(2);
  });
  it('protege as oito tabelas internas com RLS e sem acesso de parceiros',async()=>{
    const tables=await db.pool.query(`SELECT count(*)::int n,bool_and(c.relrowsecurity) protected
      FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
      WHERE s.nspname='marketing' AND c.relname LIKE 'google_%' AND c.relkind='r'`);
    expect(tables.rows[0]).toMatchObject({n:8,protected:true});
    const access=await db.pool.query(`SELECT has_table_privilege('farejador_partner_app','marketing.google_clicks','SELECT') allowed`);
    expect(access.rows[0].allowed).toBe(false);
  });
});
function processEnv(){return globalThis.process.env;}
