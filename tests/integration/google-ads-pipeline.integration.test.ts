import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
import type {GoogleAdsSnapshot} from '../../src/marketing/google-ads.js';
import type {GoogleAdsConfig} from '../../src/marketing/google-ads-client.js';
import {createPartnerFixture} from './helpers/partner-fixtures.js';

describe('Google Ads — livro central, atribuicao e entrega',()=>{
  let db:IntegrationDb;
  let sync:typeof import('../../src/marketing/google-sync.js').syncGoogleAds;
  let reconcile:typeof import('../../src/marketing/google-attribution.js').reconcileGoogleAttributions;
  let meta:typeof import('../../src/marketing/attribution.js').reconcileMarketingAttributions;
  let results:typeof import('../../src/marketing/google-results.js').getGoogleResults;
  let activity:typeof import('../../src/marketing/google-campaign-activity.js').getGoogleCampaignActivity;
  let adActivity:typeof import('../../src/marketing/google-campaign-activity.js').getGoogleAdActivity;
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
    ({getGoogleCampaignActivity:activity}=await import('../../src/marketing/google-campaign-activity.js'));
    ({getGoogleAdActivity:adActivity}=await import('../../src/marketing/google-campaign-activity.js'));
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
  it('preserva a data financeira sem variável e concilia Meta mais Google em todas as verificações',async()=>{
    await sync({dbPool:db.pool,config,snapshot:snapshot('15000000'),financeSince:null});
    await sync({dbPool:db.pool,config,snapshot:snapshot('15000000')});
    expect(await expense()).toBe(15);
    const account=await db.pool.query(`SELECT finance_since::text FROM marketing.google_accounts WHERE environment='test'`);
    expect(account.rows[0].finance_since).toBe('2026-10-01');
    const insight=(await db.pool.query(`INSERT INTO marketing.meta_insights_daily
      (environment,ad_account_id,api_version,account_currency,entity_level,entity_id,campaign_id,metric_date,spend,impressions,clicks,actions_raw)
      VALUES('test','act_345','v26.0','BRL','campaign','meta-finance','meta-finance','2026-10-01',30,100,10,'[]') RETURNING id`)).rows[0].id;
    const {reconcileMatrizMarketingSpend}=await import('../../src/marketing/matriz-ledger-spend.js');
    const client=await db.pool.connect();
    try {await client.query('BEGIN');await reconcileMatrizMarketingSpend(client,insight,'proof');await client.query('COMMIT');}
    finally {client.release();}
    const {getMatrizCentralLedgerFinancialTruth:truth}=await import('../../src/admin/painel/matriz-ledger-financial-read.js');
    const {getMatrizLedgerCompetenceGate:gate}=await import('../../src/admin/painel/matriz-ledger-competence-gate.js');
    const {getMatrizStage4LedgerReconciliation:stage4}=await import('../../src/admin/painel/matriz-ledger-stage4-reconciliation.js');
    const {getMatrizLedgerIntegrationHealth:health}=await import('../../src/admin/painel/matriz-ledger-integration-health.js');
    const report=await truth('test',db.pool,'2026-10');
    const {getMatrizLedgerOpenItems:openItems}=await import('../../src/admin/painel/matriz-ledger-open-items.js');
    const payable=(await openItems('test',db.pool)).a_pagar.itens.find(item=>item.tipo==='marketing');
    expect(payable).toMatchObject({nome:'Marketing · Anúncios',valor:'45.00'});
    expect(report.competencia.status).toBe('confirmado');
    expect(report.conciliacao.origens.find(row=>row.origem==='marketing')).toMatchObject({origem_total:'45.00',contabilizado:'45.00',diferenca:'0.00'});
    expect((await gate(['2026-09-01','2026-10-01'],'test',db.pool)).status).toBe('green');
    expect((await stage4('test',db.pool)).errors.marketing_spend_mismatch).toBe(0);
    expect((await health('test',db.pool)).modules.marketing.status).toBe('green');
    await db.pool.query(`UPDATE marketing.google_insights_daily SET cost_micros=16000000 WHERE environment='test' AND entity_level='campaign'`);
    expect((await stage4('test',db.pool)).errors.marketing_spend_mismatch).toBe(1);
    expect((await gate(['2026-09-01','2026-10-01'],'test',db.pool)).status).toBe('red');
    expect((await health('test',db.pool)).modules.marketing.status).toBe('red');
    await sync({dbPool:db.pool,config,snapshot:snapshot('15000000')});
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
    const financial=await results(config.customerId,'2026-09-25','2026-10-01',db.pool);
    expect(financial.campaigns[0]).toMatchObject({product_cost:60,partner_payout:0,gross_margin:40});
    expect((await results('9999999999','2026-09-25','2026-10-01',db.pool)).totals.attributed_sales).toBe(0);
  });
  it('um POST aceito so e confirmado apos consulta; recoleta nao envia de novo',async()=>{
    const transport={ingest:vi.fn().mockResolvedValue('request-test'),status:vi.fn().mockResolvedValue('sent')};
    await process({dbPool:db.pool,transport});expect(transport.ingest).toHaveBeenCalledTimes(1);
    expect(transport.ingest.mock.calls[0][0]).toMatchObject({conversionValue:100,eventSource:'MESSAGE',adIdentifiers:{gclid:'test-click'}});
    expect((await db.pool.query(`SELECT status FROM marketing.google_conversion_outbox WHERE environment='test'`)).rows[0].status).toBe('accepted');
    const acceptedReport=await results(config.customerId,'2026-09-25','2026-10-01',db.pool);
    expect(acceptedReport.pipeline).toMatchObject({accepted:1,sent:0});
    expect(acceptedReport.campaign_pipelines['11']).toMatchObject({accepted:1,sent:0});
    expect(acceptedReport.ad_pipelines['22:33']).toMatchObject({accepted:1,sent:0});
    const detail=await activity(config.customerId,'11','2026-09-25','2026-10-01',1,1,db.pool);
    expect(detail.orders).toMatchObject({total:1,page:1,rows:[{order_id:order,revenue:'100.00',product_cost:'60',partner_payout:'0',conversion_status:'accepted'}]});
    expect(detail.conversations.total).toBe(1);expect(detail.events).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain('test-click');
    const second=await activity(config.customerId,'11','2026-09-25','2026-10-01',2,2,db.pool);
    expect(second.orders).toMatchObject({total:1,rows:[]});expect(second.conversations).toMatchObject({total:1,rows:[]});
    for(const [account,campaign,since] of [[config.customerId,'99','2026-09-25'],['9999999999','11','2026-09-25'],[config.customerId,'11','2026-10-01']]) {
      const empty=await activity(account,campaign,since,'2026-10-01',1,1,db.pool);
      expect(empty.orders.total).toBe(0);expect(empty.conversations.total).toBe(0);expect(empty.events).toEqual([]);
    }
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
    const {reviewGoogleConversion:review,listGoogleConversionReviews:list}=await import('../../src/marketing/google-conversion-review.js');
    const row=(await list(db.pool)).rows[0];
    const reviewInput={id:row.id,reason:'Conferência da prova isolada',actor:'test',idempotencyKey:'google-review-ambiguous'};
    await expect(review({...reviewInput,action:'retry'},{dbPool:db.pool,transport})).rejects.toThrow('google_retry_not_proven_safe');
    expect(transport.ingest).toHaveBeenCalledTimes(1);
    await review({...reviewInput,action:'close'},{dbPool:db.pool,transport});
    expect((await db.pool.query(`SELECT status FROM marketing.google_conversion_outbox WHERE id=$1`,[row.id])).rows[0].status).toBe('closed');
    await process({dbPool:db.pool,transport});expect(transport.ingest).toHaveBeenCalledTimes(1);
    // Reabre somente a fixture para verificar rejeição comprovada, sem mudar o identificador da venda.
    await db.pool.query(`UPDATE marketing.google_conversion_outbox SET status='review',request_id='request-test',attempts=20 WHERE id=$1`,[row.id]);
    transport.status.mockResolvedValue('processing');
    await review({...reviewInput,action:'check',idempotencyKey:'google-check-processing'},{dbPool:db.pool,transport});
    expect((await db.pool.query(`SELECT status,attempts FROM marketing.google_conversion_outbox WHERE id=$1`,[row.id])).rows[0]).toMatchObject({status:'accepted',attempts:0});
    await db.pool.query(`UPDATE marketing.google_conversion_outbox SET status='dead_letter' WHERE id=$1`,[row.id]);
    transport.status.mockResolvedValue('failed');
    const transactionId=(await db.pool.query(`SELECT transaction_id FROM marketing.google_conversion_outbox WHERE id=$1`,[row.id])).rows[0].transaction_id;
    await review({...reviewInput,action:'retry',idempotencyKey:'google-retry-rejected'},{dbPool:db.pool,transport});
    expect((await db.pool.query(`SELECT status,attempts,request_id,transaction_id FROM marketing.google_conversion_outbox WHERE id=$1`,[row.id])).rows[0])
      .toMatchObject({status:'pending',attempts:0,request_id:null,transaction_id:transactionId});
    expect(transport.ingest).toHaveBeenCalledTimes(1);
    await expect(review({...reviewInput,action:'close'},{dbPool:db.pool,transport})).rejects.toThrow('google_conversion_not_reviewable');
    const audits=await db.pool.query(`SELECT count(*)::int n FROM audit.events WHERE environment='test' AND entity_id=$1 AND event_type='marketing_google_conversion_reviewed'`,[row.id]);
    expect(audits.rows[0].n).toBe(3);
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
    const cancelled=await activity(config.customerId,'11','2026-09-25','2026-10-01',1,1,db.pool);
    expect(cancelled.orders.total).toBe(0);expect(cancelled.events[0]?.status).toBe('review');
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
    expect(report.campaign_pipelines['44']).toBeUndefined();
    expect((await activity(config.customerId,'44','2026-09-25','2026-10-01',1,1,db.pool)).conversations.total).toBe(1);
  });
  it('protege as oito tabelas internas com RLS e sem acesso de parceiros',async()=>{
    const tables=await db.pool.query(`SELECT count(*)::int n,bool_and(c.relrowsecurity) protected
      FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
      WHERE s.nspname='marketing' AND c.relname LIKE 'google_%' AND c.relkind='r'`);
    expect(tables.rows[0]).toMatchObject({n:8,protected:true});
    const access=await db.pool.query(`SELECT has_table_privilege('farejador_partner_app','marketing.google_clicks','SELECT') allowed`);
    expect(access.rows[0].allowed).toBe(false);
  });
  it('separa repasses de parceiros e isola envios por campanha, ação e propriedade',async()=>{
    const f=await createPartnerFixture(db.pool);
    const po=(await db.pool.query(`INSERT INTO commerce.partner_orders(environment,unit_id,total_amount,status,
      fulfillment_mode,awaiting_pickup,retrieved_at,created_at)
      VALUES('test',$1,100,'confirmed','pickup',false,'2026-09-30T12:00:00Z','2026-09-30T12:00:00Z') RETURNING id`,[f.unitId])).rows[0].id;
    const customer=(await db.pool.query(`SELECT contact_id FROM core.conversations WHERE id=$1`,[conversation])).rows[0].contact_id;
    const partnerSale=(await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,source_conversation_id,
      total_amount,status,fulfillment_mode,payment_method,delivery_status,partner_order_id,created_at)
      VALUES('test',$1,$2,100,'confirmed','pickup','pix','pending',$3,'2026-09-30T12:00:00Z') RETURNING id`,[customer,conversation,po])).rows[0].id;
    const partnerClick=(await db.pool.query(`SELECT id FROM marketing.google_clicks WHERE environment='test' AND campaign_id='44'`)).rows[0].id;
    const attribution=(await db.pool.query(`INSERT INTO marketing.google_order_attributions(environment,order_id,click_id,
      conversation_id,status,realized_at,truth_type,confidence_level,source_reference,extractor_version)
      VALUES('test',$1,$2,$3,'active','2026-09-30T12:00:00Z','observed',1,'{}','integration') RETURNING id`,[partnerSale,partnerClick,conversation])).rows[0].id;
    let report=await results(config.customerId,'2026-09-25','2026-10-01',db.pool);
    expect(report.campaigns.find(r=>r.id==='44')).toMatchObject({product_cost:0,partner_payout:null,gross_margin:null,pending_margin_orders:1});
    await db.pool.query(`INSERT INTO network.commission_entries(environment,partner_id,partner_unit_id,unit_id,
      partner_order_id,order_total,commission_percent,commission_amount,status,realized_at)
      VALUES('test',$1,$2,$3,$4,100,10,10,'open','2026-09-30T12:00:00Z')`,[f.partnerId,f.partnerUnitId,f.unitId,po]);
    const product=(await db.pool.query(`SELECT id FROM commerce.products WHERE environment='test' AND product_code='GOOGLE-TEST'`)).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,matriz_unit_cost)
      VALUES('test',$1,$2,1,100,60)`,[partnerSale,product]);
    await db.pool.query(`INSERT INTO marketing.google_conversion_outbox(environment,attribution_id,order_id,action_id,transaction_id,status)
      VALUES('test',$1,$2,'987','partner-google-test','pending'),
            ('test',$1,$2,'999','other-action-test','failed')`,[attribution,partnerSale]);
    report=await results(config.customerId,'2026-09-25','2026-10-01',db.pool);
    expect(report.campaigns.find(r=>r.id==='44')).toMatchObject({product_cost:0,partner_payout:90,gross_margin:10,pending_margin_orders:0});
    expect(report.campaign_pipelines['44']).toMatchObject({pending:1,review:0,failed:0});
    expect(report.ad_pipelines['22:55']).toMatchObject({pending:1,review:0,failed:0});
    expect(report.campaign_pipelines['11']).toMatchObject({pending:0,review:1,failed:0});
    expect(report.pipeline).toMatchObject({pending:1,review:1,failed:0});
    const detail=await activity(config.customerId,'44','2026-09-25','2026-10-01',1,1,db.pool);
    expect(detail.orders.total).toBe(1);expect(Number(detail.orders.rows[0]?.partner_payout)).toBe(90);
    expect(detail.events).toHaveLength(1);expect(JSON.stringify(detail)).not.toContain('partner-google-test');
    await db.pool.query(`UPDATE marketing.google_campaigns SET owned=false WHERE environment='test' AND campaign_id='44'`);
    const hidden=await activity(config.customerId,'44','2026-09-25','2026-10-01',1,1,db.pool);
    expect(hidden.orders.total).toBe(0);expect(hidden.conversations.total).toBe(0);expect(hidden.events).toEqual([]);
    expect((await results(config.customerId,'2026-09-25','2026-10-01',db.pool)).campaign_pipelines['44']).toBeUndefined();
  });
  it('isola anúncio por grupo, campanha e propriedade, preservando revisão e paginação',async()=>{
    await db.pool.query(`INSERT INTO marketing.google_ads(environment,account_id,ad_group_id,ad_id,campaign_id,name,status,format)
      VALUES('test','1234567890','23','33','11','Mesmo ID em outro grupo','ENABLED','RESPONSIVE_SEARCH_AD')`);
    const other=(await db.pool.query(`INSERT INTO marketing.google_clicks(environment,account_id,campaign_id,ad_group_id,ad_id,
      reference,identifier_type,identifier,identifier_hash,consent_ad_user_data,destination,captured_at)
      VALUES('test','1234567890','11','23','33',$1,'gclid','separate-group','separate-group-hash',true,'whatsapp','2026-09-30T11:00:00Z')
      RETURNING id`,['2W-G'+'e'.repeat(32)])).rows[0].id;
    await db.pool.query(`INSERT INTO marketing.google_click_conversations(environment,click_id,conversation_id,source,observed_at)
      VALUES('test',$1,$2,'message_reference','2026-09-30T11:01:00Z')`,[other,conversation]);
    const detail=await adActivity(config.customerId,'11','22:33','2026-09-25','2026-10-01',1,1,db.pool);
    expect(detail.conversations.total).toBe(2);expect(detail.orders.total).toBe(0);
    expect(detail.events).toHaveLength(1);expect(detail.events[0]?.status).toBe('review');
    const second=await adActivity(config.customerId,'11','22:33','2026-09-25','2026-10-01',2,2,db.pool);
    expect(second.conversations).toMatchObject({total:2,rows:[]});expect(second.events).toHaveLength(1);
    const sameId=await adActivity(config.customerId,'11','23:33','2026-09-25','2026-10-01',1,1,db.pool);
    expect(sameId.conversations.total).toBe(1);expect(sameId.events).toEqual([]);expect(sameId.orders.total).toBe(0);
    for(const [account,campaign,ad,since] of [[config.customerId,'11','22:55','2026-09-25'],
      [config.customerId,'44','22:55','2026-09-25'],['9999999999','11','22:33','2026-09-25'],
      [config.customerId,'11','22:33','2026-10-01']]) {
      const empty=await adActivity(account,campaign,ad,since,'2026-10-01',1,1,db.pool);
      expect(empty.orders.total).toBe(0);expect(empty.conversations.total).toBe(0);expect(empty.events).toEqual([]);
    }
    await db.pool.query(`UPDATE marketing.google_campaigns SET owned=true WHERE environment='test' AND campaign_id='44'`);
    const partner=await adActivity(config.customerId,'44','22:55','2026-09-25','2026-10-01',1,1,db.pool);
    expect(partner.orders.total).toBe(1);expect(Number(partner.orders.rows[0]?.partner_payout)).toBe(90);
    expect(partner.events).toHaveLength(1);expect(partner.events[0]?.status).toBe('pending');
    const report=await results(config.customerId,'2026-09-25','2026-10-01',db.pool);
    expect(report.ad_pipelines['22:33']).toMatchObject({review:1,pending:0});
    expect(report.ad_pipelines['22:55']).toMatchObject({review:0,pending:1,failed:0});
    expect(report.ad_pipelines['23:33']).toBeUndefined();
    expect(report.pipeline).toMatchObject({review:1,pending:1,failed:0});
    const otherAction=(await db.pool.query(`SELECT id FROM marketing.google_conversion_outbox WHERE environment='test' AND action_id='999'`)).rows[0].id;
    const {reviewGoogleConversion:review}=await import('../../src/marketing/google-conversion-review.js');
    await expect(review({id:otherAction,action:'close',reason:'Outro destino não pode ser alterado',actor:'test',idempotencyKey:'foreign-action'},
      {dbPool:db.pool,transport:{status:vi.fn()}})).rejects.toThrow('google_conversion_not_found');
  });
});
function processEnv(){return globalThis.process.env;}
