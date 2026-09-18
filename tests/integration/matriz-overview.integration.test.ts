import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
let db:IntegrationDb,unit:string,contact:string,conversation:string;
let read:typeof import('../../src/admin/painel/matriz-overview.js').getMatrizOverview;
let period:ReturnType<typeof import('../../src/admin/painel/matriz-overview.js').overviewPeriod>;
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
    CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',WHOLESALE_FINANCE:'true',
    MATRIZ_CENTRAL_LEDGER:'true',MATRIZ_CENTRAL_LEDGER_READ:'true',LOG_LEVEL:'error'});
  vi.resetModules();db=await startPostgres();
  const mod=await import('../../src/admin/painel/matriz-overview.js');read=mod.getMatrizOverview;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
  period=mod.overviewPeriod('month',today.slice(0,7));
  unit=(await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz')
    ON CONFLICT(environment,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id;
  contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name) VALUES('test',99112,'Cliente resumo') RETURNING id`)).rows[0].id;
  conversation=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_account_id,chatwoot_conversation_id,contact_id,channel_type,current_status,started_at,last_activity_at)
    VALUES('test',2,99112,$1,'whatsapp','open',now()-interval '90 days',now()) RETURNING id`,[contact])).rows[0].id;
},180000);
afterAll(async()=>{if(db)await stopPostgres(db);});
it('consulta todos os blocos no schema migrado; zeros são reais e financeiro respeita o acesso',async()=>{
  const data=await read(period,true,db.pool,'test');
  expect(data.sales.summary.orders).toBe(0);expect(data.bot.estimated_cents).toBe(0);
  expect(data.finance?.cash_cents).toBe(0);expect(data.leads).toEqual([]);
  expect((await read(period,false,db.pool,'test')).finance).toBeNull();
});
it('custo acompanha a data do uso, mesmo em uma conversa antiga, e exclui outro período',async()=>{
  await db.pool.query(`INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,context_hash,llm_input_tokens,llm_output_tokens,created_at)
    VALUES('test',$1,$2,'v2','qa',100000,100000,now()),('test',$1,$3,'v2','qa',9000000,0,now()-interval '90 days')`,[conversation,randomUUID(),randomUUID()]);
  expect((await read(period,false,db.pool,'test')).bot).toMatchObject({estimated_cents:null,tokens:200000,calls:1,missing_usage:1});
  expect((await read(period,false,db.pool,'prod')).bot.tokens).toBe(0);
});
it('inclui moto e carro, ignora cancelamento e entrega pendente e não conta serviço como pneu',async()=>{
  const products=[];
  for(const [name,vehicle,kind] of [['Moto','motorcycle','tire'],['Carro','car','tire'],['Serviço',null,'service']]) {
    const id=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,tire_condition)
      VALUES('test',$1,$1,$2,CASE WHEN $2='tire' THEN 'novo' END) RETURNING id`,[name,kind])).rows[0].id;products.push(id);
    if(kind==='tire')await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type) VALUES('test',$1,$2,$3)`,[id,vehicle==='car'?'175/65-14':'90/90-12',vehicle]);
  }
  for(const [status,mode] of [['confirmed','pickup'],['cancelled','pickup'],['open','pickup'],['confirmed','delivery']]) {
    const id=(await db.pool.query(`INSERT INTO commerce.orders(environment,unit_id,contact_id,total_amount,status,fulfillment_mode,delivery_address)
      VALUES('test',$1,$2,310,$3,$4,CASE WHEN $4='delivery' THEN 'Rua de teste' END) RETURNING id`,[unit,contact,status,mode])).rows[0].id;
    for(let i=0;i<products.length;i++)await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,matriz_unit_cost)
      VALUES('test',$1,$2,1,$3,50)`,[id,products[i],i===2?10:150]);
  }
  const {summary}= (await read(period,false,db.pool,'test')).sales;
  expect(summary).toMatchObject({orders:1,revenue:31000,tires:2,moto:1,car:1,lots:0,unclassified:0});
  expect((await read(period,false,db.pool,'prod')).sales.summary.orders).toBe(0);
});
it('venda de lote usa o total negociado, custo e financeiro reais; cancelar retira do resumo',async()=>{
  const {registerWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const {registerLotSale}=await import('../../src/admin/painel/register-lot-sale.js');
  const {cancelWholesaleSale}=await import('../../src/admin/painel/queries-atacado-cancelar.js');
  const supplier=(await db.pool.query(`INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES('test','Resumo fornecedor') RETURNING id`)).rows[0].id;
  const buy=await registerWholesalePurchase({environment:'test',supplier_id:supplier,items:[],
    lot:{description:'Pneus de lote',quantity:10,total_cost:50},payment_status:'paid',payment_method:'Pix',
    receipt_status:'received',created_by:'owner:qa',idempotency_key:randomUUID()},db.pool);
  const sale=await registerLotSale({new_customer:{name:'Resumo borracharia'},description:'Pneus de lote',amount:100,discount:10,
    expected_cost:30,sold_on:period.today,payment_status:'pending',due_date:period.today,notes:'',idempotency_key:randomUUID(),
    allocations:[{lot_id:buy.lot_id!,quantity:6}]},'owner:qa',null,db.pool);
  const summary=(await read(period,true,db.pool,'test'));
  expect(summary.sales.summary).toMatchObject({orders:2,tires:8,lots:6,revenue:40000,atacado:9000});
  expect(summary.finance).toMatchObject({cash_cents:-5000,receivable_today_cents:9000});
  await cancelWholesaleSale({environment:'test',order_id:sale.order_id,cancelled_by:'owner:qa',reason:'Teste cancelamento',idempotency_key:randomUUID()},db.pool);
  const after=await read(period,true,db.pool,'test');
  expect(after.sales.summary).toMatchObject({orders:1,lots:0,revenue:31000});
  expect(after.finance?.receivable_today_cents).toBe(0);
});
it('reposição soma marcas da mesma medida, usa o mínimo cadastrado e inclui medida sem saldo',async()=>{
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,min_quantity)
    VALUES('test','298/98-28','Marca A','novo',6,10),('test','298/98-28','Marca B','novo',6,10)`);
  expect((await read(period,false,db.pool,'test')).attention.low_stock).toBe(0);
  await db.pool.query(`INSERT INTO commerce.wholesale_replenishment_policies(environment,measure,tire_condition,min_quantity)
    VALUES('test','298/98-28','novo',20),('test','299/99-28','novo',5)`);
  expect((await read(period,false,db.pool,'test')).attention.low_stock).toBe(2);
});
it('retomada mantém duas medidas e só mostra conversa com cotação sem resposta e sem pedido',async()=>{
  await db.pool.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,sent_at)
    VALUES('test',99112,$1,99112,'agent_bot',1,now()-interval '2 hours')`,[conversation]);
  for(const [key,value,version] of [['preco_cotado','89','qa'],['medida_consultada','130/70-13','qa1'],['medida_consultada','110/70-13','qa2']]) {
    await db.pool.query(`INSERT INTO analytics.conversation_facts(environment,conversation_id,fact_key,fact_value,truth_type,source,extractor_version)
      VALUES('test',$1,$2,$3,'observed','qa',$4)`,[conversation,key,JSON.stringify(value),version]);
  }
  const before=await read(period,false,db.pool,'test');
  expect(before.leads).toHaveLength(1);expect(before.leads[0].interest).toContain('130/70-13');expect(before.leads[0].interest).toContain('110/70-13');
  await db.pool.query(`INSERT INTO ops.customer_lead_board_state(environment,conversation_id,archived_at,archived_by,archive_reason,updated_by)
    VALUES('test',$1,now(),'qa','Teste de arquivamento','qa')`,[conversation]);
  expect((await read(period,false,db.pool,'test')).leads).toEqual([]);
  await db.pool.query(`UPDATE ops.customer_lead_board_state SET archived_at=NULL,archived_by=NULL,archive_reason=NULL WHERE environment='test' AND conversation_id=$1`,[conversation]);
  await db.pool.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,sent_at)
    VALUES('test',99113,$1,99112,'contact',0,now()-interval '1 hour')`,[conversation]);
  expect((await read(period,false,db.pool,'test')).leads).toEqual([]);
});
