import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
let db:IntegrationDb;
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
    CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-token',MATRIZ_CENTRAL_LEDGER:'true',MATRIZ_CENTRAL_LEDGER_READ:'true',WHOLESALE_FINANCE:'true'});
  db=await startPostgres();
},180000);
afterAll(async()=>{if(db)await stopPostgres(db);});
it('divide compra e vendas anteriores, mantém o custo de estoque e concilia dinheiro e reembolso na data real',async()=>{
  const {registerWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const {registerLotSale}=await import('../../src/admin/painel/register-lot-sale.js');
  const {readPurchaseSharing}=await import('../../src/admin/painel/purchase-sharing-read.js');
  const {writePurchaseSharing}=await import('../../src/admin/painel/purchase-sharing-write.js');
  const {getMatrizLedgerStatement}=await import('../../src/admin/painel/matriz-ledger-statement.js');
  const {businessDateSaoPaulo}=await import('../../src/shared/business-time.js');
  const today=businessDateSaoPaulo(new Date()),actor='owner:qa';
  const supplier=(await db.pool.query("INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES('test','Fornecedor divisão') RETURNING id")).rows[0].id;
  const purchase=await registerWholesalePurchase({environment:'test',supplier_id:supplier,items:[],lot:{description:'Pneus mistos',quantity:250,total_cost:3200},
    freight_amount:1600,payment_status:'paid',payment_method:'Pix',receipt_status:'received',created_by:actor,idempotency_key:randomUUID()},db.pool);
  const sale=await registerLotSale({new_customer:{name:'Comprador teste'},description:'Pneus da viagem',amount:1000,discount:0,
    expected_cost:192,sold_on:today,payment_status:'paid',payment_method:'Pix',idempotency_key:randomUUID(),
    allocations:[{lot_id:purchase.lot_id!,quantity:10}]},actor,null,db.pool);
  const id=purchase.purchase_id,person=randomUUID();
  const read=()=>readPurchaseSharing(db.pool,'test',id);
  const change=(data:Parameters<typeof writePurchaseSharing>[1])=>writePurchaseSharing(id,data,actor,'test',db.pool);
  const original=await read(),supplierTx=original.flows.find(f=>f.kind==='supplier')!.id;
  const saleTx=original.flows.find(f=>f.order_id===sale.order_id)!.id;
  expect(original.supplier_cash).toBe(4800);expect(original.quantity_on_hand).toBe(240);
  await change({kind:'agreement',revision:0,key:randomUUID(),participants:[{id:person,name:'Participante',mode:'percent',value:50}]});
  let state=await read();expect(state.store_cost).toBe(2400);expect(state.supplier_cash).toBe(4800);
  const direct={kind:'cash' as const,revision:1,key:randomUUID(),transaction_id:supplierTx,allocations:[{id:person,value:2400}]};
  await Promise.all([change(direct),change(direct)]);expect((await read()).revision).toBe(2);
  await expect(change({...direct,key:randomUUID()})).rejects.toThrow(/mudou/);
  await expect(change({...direct,revision:2,key:randomUUID(),allocations:[{id:person,value:4900}]})).rejects.toThrow(/ultrapassam/);
  await change({...direct,revision:2,key:randomUUID(),transaction_id:saleTx,allocations:[{id:person,value:300}]});
  state=await read();expect(state.supplier_cash).toBe(2400);expect(state.participants[0]).toMatchObject({remaining_contribution:0,received_sales:300});
  const statement=()=>getMatrizLedgerStatement({environment:'test',basis:'caixa',period:today.slice(0,7)},db.pool);
  const ledger=await statement();
  expect(Number(ledger.rows.find(r=>r.id===supplierTx)?.amount)).toBe(2400);
  expect(Number(ledger.rows.find(r=>r.id===saleTx)?.amount)).toBe(700);
  expect(ledger.summary).toMatchObject({entradas:'700.00',saidas:'2400.00'});
  const receipt=state.movements.find(m=>m.source==='purchase_receipt')!,sold=state.movements.find(m=>m.source==='sale')!;
  await change({kind:'stock',revision:3,key:randomUUID(),movement_id:receipt.id,allocations:[{id:person,value:125}]});
  await change({kind:'stock',revision:4,key:randomUUID(),movement_id:sold.id,allocations:[{id:person,value:3}]});
  await change({...direct,key:randomUUID(),revision:5,allocations:[]});
  const settlement={kind:'settlement' as const,revision:6,key:randomUUID(),participant_id:person,direction:'in' as const,amount:2400,
    day:today,account:'Conta principal',method:'Pix'};
  await change(settlement);await change(settlement);
  state=await read();expect(state.participants[0]?.remaining_contribution).toBe(0);
  expect((await statement()).summary).toMatchObject({entradas:'3100.00',saidas:'4800.00'});
  await change({kind:'undo',revision:7,key:randomUUID(),transaction_id:state.settlements[0]!.id,reason:'Informado por engano'});
  expect((await statement()).summary).toMatchObject({entradas:'700.00',saidas:'4800.00'});
  await expect(readPurchaseSharing(db.pool,'prod',id)).rejects.toThrow(/não encontrada/);
  expect((await db.pool.query('SELECT allocated_cost,remaining_cost,quantity_on_hand FROM commerce.tire_lots WHERE id=$1',[purchase.lot_id])).rows[0])
    .toEqual({allocated_cost:'4800.00',remaining_cost:'4608.00',quantity_on_hand:240});
  expect((await db.pool.query('SELECT count(*)::int n FROM audit.events WHERE entity_id=$1 AND domain=$2',[id,'purchase.sharing'])).rows[0].n).toBe(8);
},60000);

it('só permite dividir valores realizados de uma compra a prazo e de uma venda parcelada',async()=>{
  const {registerWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const {registerLotSale}=await import('../../src/admin/painel/register-lot-sale.js');
  const {readPurchaseSharing}=await import('../../src/admin/painel/purchase-sharing-read.js');
  const {writePurchaseSharing}=await import('../../src/admin/painel/purchase-sharing-write.js');
  const {settleMatrizLedgerOpenItem}=await import('../../src/admin/painel/matriz-ledger-settlement.js');
  const {businessDateSaoPaulo}=await import('../../src/shared/business-time.js');
  const today=businessDateSaoPaulo(new Date()),actor='owner:parcelas',person=randomUUID();
  const supplier=(await db.pool.query("INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES('test','Fornecedor a prazo') RETURNING id")).rows[0].id;
  const buy=await registerWholesalePurchase({environment:'test',supplier_id:supplier,items:[],lot:{description:'Compra a prazo',quantity:10,total_cost:500},
    payment_status:'pending',due_date:today,receipt_status:'received',created_by:actor,idempotency_key:randomUUID()},db.pool);
  const read=()=>readPurchaseSharing(db.pool,'test',buy.purchase_id);
  const change=(data:Parameters<typeof writePurchaseSharing>[1])=>writePurchaseSharing(buy.purchase_id,data,actor,'test',db.pool);
  await change({kind:'agreement',revision:0,key:randomUUID(),participants:[{id:person,name:'Participante',mode:'amount',value:250}]});
  expect((await read()).flows).toHaveLength(0);
  const obligation=(await db.pool.query("SELECT id FROM finance.matriz_ledger_transactions WHERE source_id=$1 AND transaction_kind='purchase_payable'",[buy.purchase_id])).rows[0].id;
  await settleMatrizLedgerOpenItem({environment:'test',obligation_id:obligation,amount:200,payment_method:'Pix',idempotency_key:randomUUID(),actor_label:actor},db.pool);
  const supplierFlow=(await read()).flows[0]!;
  await change({kind:'cash',revision:1,key:randomUUID(),transaction_id:supplierFlow.id,allocations:[{id:person,value:100}]});
  const sale=await registerLotSale({new_customer:{name:'Comprador a prazo'},description:'Venda parcelada',amount:600,discount:0,expected_cost:100,
    sold_on:today,payment_status:'pending',due_date:today,payment_plan:{received:150,method:'Pix',installments:[{due_date:today,amount:450}]},
    idempotency_key:randomUUID(),allocations:[{lot_id:buy.lot_id!,quantity:2}]},actor,null,db.pool);
  const state=await read(),entry=state.flows.find(f=>f.order_id===sale.order_id)!;
  expect(Number(entry.gross)).toBe(150);expect(state.supplier_cash).toBe(100);
  await expect(change({kind:'cash',revision:2,key:randomUUID(),transaction_id:entry.id,allocations:[{id:person,value:151}]})).rejects.toThrow(/ultrapassam/);
  await change({kind:'cash',revision:2,key:randomUUID(),transaction_id:entry.id,allocations:[{id:person,value:50}]});
  await change({kind:'settlement',revision:3,key:randomUUID(),participant_id:person,amount:20,day:today,
    direction:'out',purpose:'sale',account:'Principal',method:'Pix'});
  expect((await read()).participants[0]).toMatchObject({cost:250,remaining_contribution:150,received_sales:50});
  const reversed=(await db.pool.query(`SELECT finance.reverse_matriz_ledger_transaction('test',$1,'finance.test_share.reversal',$2,$3::date,
    'Estorno em teste','owner:qa',$3::date,'{}'::jsonb) id`,[entry.id,randomUUID(),today])).rows[0].id;
  const reversal=await db.pool.query("SELECT amount::float8 FROM finance.matriz_reporting_entries WHERE transaction_id=$1 AND account_code='cash' AND side='credit'",[reversed]);
  expect(reversal.rows[0]?.amount).toBe(100);
},60000);
