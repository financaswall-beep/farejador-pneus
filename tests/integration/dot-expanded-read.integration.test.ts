import { beforeAll,afterAll,expect,it,vi } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
import { randomUUID } from 'node:crypto';

let db:IntegrationDb;
let consultations:typeof import('../../src/admin/dot/consultations.js');
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',DATABASE_SSL:'false',
    CHATWOOT_HMAC_SECRET:'test-secret',CHATWOOT_ACCOUNT_ID:'1',ADMIN_AUTH_TOKEN:'test-emergency',DOT_MCP_ENABLED:'false',
    MATRIZ_CENTRAL_LEDGER:'true',MATRIZ_CENTRAL_LEDGER_READ:'true',MATRIZ_LOGISTICS:'true',WHOLESALE_FINANCE:'true',
    MARKETING_META_ENABLED:'true',MARKETING_ATTRIBUTION:'true',GOOGLE_ADS_ENABLED:'true',BOT_OUTBOX:'true'});
  db=await startPostgres();process.env.DATABASE_URL=db.connectionString;vi.resetModules();
  consultations=await import('../../src/admin/dot/consultations.js');
},240000);
afterAll(async()=>{
  const {pool}=await import('../../src/persistence/db.js');await pool.end();
  if(db)await stopPostgres(db);
});

const cases={consultar_varejo_matriz:[''],consultar_atacado_matriz:['vendas','compradores','medidas','inativos'],
  consultar_movimentos_estoque_matriz:[''],consultar_lotes_matriz:['lotes','movimentos','vendas'],
  consultar_catalogo_matriz:['produtos','compatibilidade','historico_precos'],
  consultar_compras_matriz:['compras','pedidos','fornecedores','precos'],
  consultar_despesas_matriz:['despesas','comprovantes','categorias'],consultar_rotas_matriz:[''],consultar_retiradas_matriz:[''],
  consultar_rede_matriz:['lojas','comissoes','mensalidades','funil'],consultar_candidaturas_matriz:[''],
  consultar_clientes_matriz:['compras','etapas','oportunidades'],consultar_bot_matriz:['conversao','demanda','faltas','espera'],
  consultar_marketing_matriz:['campanhas','anuncios','google','publicacoes','regioes','atribuicao'],
  consultar_equipe_matriz:[''],consultar_notificacoes_matriz:[''],consultar_saude_matriz:['']};
for(const [name,views] of Object.entries(cases))for(const view of views)it(`${name} ${view}: consulta o schema completo sem erro nem escrita`,async()=>{
  const result=await consultations.runDotConsultation(name as keyof typeof consultations.dotSchemas,
    {periodo:'30dias',...(view?{visao:view}:{})});
  expect(result).toMatchObject({environment:'test',read_only:true,scope:'matriz',currency:'BRL',timezone:'America/Sao_Paulo'});
  expect(JSON.stringify(result)).not.toMatch(/password_hash|phone_e164|customer_name|responsible_name|created_by|original_path|ai_summary/);
});
it('as visões financeiras de contas preservam a fonte conciliada e a paginação',async()=>{
  for(const visao of ['a_receber','a_pagar']) {
    const result=await consultations.runDotConsultation('consultar_financeiro_matriz',{visao});
    expect(result).toMatchObject({available:true,source:'central_ledger',page_size:50,rows:[]});
  }
});

it('paginação e isolamento de ambiente não permitem vazar descrições pessoais',async()=>{
  await db.pool.query(`INSERT INTO commerce.matriz_expenses(environment,category,description,amount,occurred_at,payment_status,paid_at)
    SELECT 'test','outros','PII-SENTINEL',i,now(),'paid',now() FROM generate_series(1,55) i;
    INSERT INTO commerce.matriz_expenses(environment,category,description,amount,occurred_at,payment_status,paid_at)
    VALUES('prod','outros','PRIVATE-PROD',999999,now(),'paid',now());`);
  const before=(await db.pool.query(`SELECT md5(string_agg(to_jsonb(e)::text,'' ORDER BY id)) digest FROM commerce.matriz_expenses e`)).rows[0];
  const first=await consultations.runDotConsultation('consultar_despesas_matriz',{periodo:'30dias'});
  const second=await consultations.runDotConsultation('consultar_despesas_matriz',{periodo:'30dias',pagina:2});
  expect(first).toMatchObject({total:55,page:1,truncated:true});expect(first.rows).toHaveLength(50);
  expect(second).toMatchObject({total:55,page:2,truncated:false});expect(second.rows).toHaveLength(5);
  expect(new Set([...(first.rows as {id:string}[]),...(second.rows as {id:string}[])].map(row=>row.id)).size).toBe(55);
  expect(JSON.stringify([first,second])).not.toMatch(/PII-SENTINEL|PRIVATE-PROD|999999/);
  expect((await db.pool.query(`SELECT md5(string_agg(to_jsonb(e)::text,'' ORDER BY id)) digest FROM commerce.matriz_expenses e`)).rows[0]).toEqual(before);
});

it('relatórios reutilizam as consultas e mantêm o financeiro mensal',async()=>{
  for(const area of ['varejo','atacado','compras','estoque','financeiro','demanda','rede','logistica']) {
    const result=await consultations.runDotConsultation('consultar_relatorios_matriz',{area,periodo:'mes'});
    expect(result).toMatchObject({report:area,export_format:'json',read_only:true});
  }
  await expect(consultations.runDotConsultation('consultar_relatorios_matriz',{area:'financeiro'})).rejects.toThrow('finance_report_requires_month');
});

it('conversa de outra conta e dados pessoais não entram nas classificações/demanda',async()=>{
  const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
    VALUES('test',90701,'PII-SENTINEL') RETURNING id`)).rows[0].id;
  for(const [account,number,measure,value] of [[1,90701,'110/90-17','recebeu_cotacao'],[1,90702,'21999999999','PII-SENTINEL'],
    [2,90703,'999/99-99','fechou']] as const) {
    const conversation=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_account_id,chatwoot_conversation_id,
      contact_id,channel_type,current_status,started_at,last_activity_at)
      VALUES('test',$1,$2,$3,'whatsapp','open',now(),now()) RETURNING id`,[account,number,contact])).rows[0].id;
    await db.pool.query(`INSERT INTO analytics.conversation_classifications(environment,conversation_id,dimension,value,truth_type,source,extractor_version)
      VALUES('test',$1,'stage_reached',$2,'observed','qa','qa')`,[conversation,value]);
    await db.pool.query(`INSERT INTO analytics.conversation_facts(environment,conversation_id,fact_key,fact_value,truth_type,source,extractor_version)
      VALUES('test',$1,'medida_consultada',$2,'observed','qa','qa')`,[conversation,JSON.stringify(measure)]);
  }
  const stages=await consultations.runDotConsultation('consultar_clientes_matriz',{visao:'etapas',periodo:'30dias'});
  expect(stages.rows).toEqual(expect.arrayContaining([expect.objectContaining({value:'recebeu_cotacao'}),expect.objectContaining({value:'outros'})]));
  expect(JSON.stringify(stages)).not.toMatch(/PII-SENTINEL|fechou/);
  const demand=await consultations.runDotConsultation('consultar_bot_matriz',{visao:'demanda',periodo:'30dias'});
  expect(demand.rows).toEqual([expect.objectContaining({measure:'110/90-17',conversations:1})]);
  expect(JSON.stringify(demand)).not.toMatch(/21999999999|999\/99-99|PII-SENTINEL/);
});

it('balcão confirmado sem retrieved_at conta no histórico; pagamento livre não é devolvido',async()=>{
  const unit=(await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz')
    ON CONFLICT(environment,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id;
  const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
    VALUES('test',90704,'PII-SENTINEL') RETURNING id`)).rows[0].id;
  const order=(await db.pool.query(`INSERT INTO commerce.orders(environment,unit_id,contact_id,total_amount,status,
    fulfillment_mode,payment_method,closed_at) VALUES('test',$1,$2,125,'confirmed','pickup','PII-SENTINEL',now()) RETURNING id`,[unit,contact])).rows[0].id;
  const history=await consultations.runDotConsultation('consultar_clientes_matriz',{periodo:'30dias'});
  expect(history.rows).toEqual([expect.objectContaining({id:contact,purchases:1,revenue_brl:'125.00'})]);
  const retail=await consultations.runDotConsultation('consultar_varejo_matriz',{periodo:'30dias',referencia:order});
  expect(retail.rows).toEqual([expect.objectContaining({id:order,payment_method:null})]);
  expect(JSON.stringify(retail)).not.toContain('PII-SENTINEL');
});

it('Meta legada sem identidade fica indisponível; campanha mista revela só o anúncio próprio',async()=>{
  await db.pool.query(`INSERT INTO marketing.campaign_scopes(environment,ad_account_id,campaign_id,scope,classification_reason,classified_by,classified_at)
    VALUES('test','legacy','10','matrix','Verificação QA','qa',now());
    INSERT INTO marketing.meta_insights_daily(environment,ad_account_id,api_version,account_currency,entity_level,entity_id,campaign_id,metric_date,spend)
    VALUES('test','legacy','v26.0','BRL','ad','legacy-external','10',(now() AT TIME ZONE 'America/Sao_Paulo')::date,987654);`);
  expect(await consultations.runDotConsultation('consultar_marketing_matriz',{periodo:'30dias'}))
    .toMatchObject({available:false,reason:'meta_identity_not_verified'});
  const sync=(await db.pool.query(`INSERT INTO marketing.meta_sync_runs(environment,trigger_type,status,window_since,window_until,finished_at)
    VALUES('test','manual','succeeded',current_date,current_date,now()) RETURNING id`)).rows[0].id;
  await db.pool.query(`INSERT INTO marketing.meta_identity_accounts(environment,ad_account_id,sync_run_id) VALUES('test','verified',$1)`,[sync]);
  await db.pool.query(`INSERT INTO marketing.campaign_scopes(environment,ad_account_id,campaign_id,scope,classification_reason,classified_by,classified_at)
    VALUES('test','verified','11','matrix','Verificação QA','qa',now());
    INSERT INTO marketing.meta_ad_identities(environment,ad_account_id,ad_id,campaign_id,scope)
    VALUES('test','verified','own','11','matrix'),('test','verified','external','11','external');
    INSERT INTO marketing.meta_insights_daily(environment,ad_account_id,api_version,account_currency,entity_level,entity_id,campaign_id,metric_date,spend)
    VALUES('test','verified','v26.0','BRL','ad','own','11',(now() AT TIME ZONE 'America/Sao_Paulo')::date,25),
      ('test','verified','v26.0','BRL','ad','external','11',(now() AT TIME ZONE 'America/Sao_Paulo')::date,876543);`);
  const ads=await consultations.runDotConsultation('consultar_marketing_matriz',{visao:'anuncios',periodo:'30dias'});
  expect(ads.rows).toEqual([expect.objectContaining({id:'own',spend:25})]);
  expect(JSON.stringify(ads)).not.toMatch(/external|987654|876543/);
});

it('lote negociado mantém desconto e custo congelado sem duplicar entrada ou livro ao consultar',async()=>{
  const {registerWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const {registerLotSale}=await import('../../src/admin/painel/register-lot-sale.js');
  const supplier=(await db.pool.query(`INSERT INTO commerce.wholesale_suppliers(environment,name,phone,document)
    VALUES('test','PII-SENTINEL','PII-SENTINEL','PII-SENTINEL') RETURNING id`)).rows[0].id;
  const purchase=await registerWholesalePurchase({environment:'test',supplier_id:supplier,items:[],
    lot:{description:'PII-SENTINEL',quantity:10,total_cost:50},payment_status:'paid',payment_method:'Pix',
    receipt_status:'received',created_by:'PII-SENTINEL',idempotency_key:randomUUID()},db.pool);
  const today=(await db.pool.query(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text today`)).rows[0].today;
  const sale=await registerLotSale({new_customer:{name:'PII-SENTINEL'},description:'PII-SENTINEL',amount:100,discount:10,
    expected_cost:30,sold_on:today,payment_status:'pending',due_date:today,notes:'PII-SENTINEL',idempotency_key:randomUUID(),
    allocations:[{lot_id:purchase.lot_id!,quantity:6}]},'PII-SENTINEL',null,db.pool);
  const fingerprint=async()=>(await db.pool.query(`SELECT
    (SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) FROM finance.matriz_ledger_transactions t) ledger,
    (SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) FROM commerce.tire_lot_movements t) movements,
    (SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) FROM audit.events t) audit`)).rows[0];
  const before=await fingerprint();
  const wholesale=await consultations.runDotConsultation('consultar_atacado_matriz',{periodo:'30dias',referencia:sale.order_id});
  expect(wholesale.rows).toEqual([expect.objectContaining({total_amount:'90.00'})]);
  const lots=await consultations.runDotConsultation('consultar_lotes_matriz',{referencia:purchase.lot_id});
  expect(lots.rows).toEqual([expect.objectContaining({available:4,remaining_cost:20})]);
  const receipts=await consultations.runDotConsultation('consultar_compras_matriz',{periodo:'30dias',referencia:purchase.purchase_id});
  expect(receipts.rows).toEqual([expect.objectContaining({total_amount:50,items_count:1})]);
  expect(JSON.stringify([wholesale,lots,receipts])).not.toContain('PII-SENTINEL');
  expect(await fingerprint()).toEqual(before);
});
