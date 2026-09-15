import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it} from 'vitest';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
let db:IntegrationDb;
beforeAll(async()=>{Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
  CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-token',LOG_LEVEL:'error',WHOLESALE_FINANCE:'true',MATRIZ_CENTRAL_LEDGER:'true'});
  db=await startPostgres();},180000);
afterAll(async()=>{if(db)await stopPostgres(db);});
it('vende parcialmente dois lotes, integra custo e fiado, repete sem duplicar e cancela devolvendo os saldos',async()=>{
  const {registerWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const {registerLotSale}=await import('../../src/admin/painel/register-lot-sale.js');
  const {cancelWholesaleSale}=await import('../../src/admin/painel/queries-atacado-cancelar.js');
  const {getWholesaleResumo}=await import('../../src/admin/painel/queries-galpao.js');
  const {getStockCosts}=await import('../../src/admin/painel/queries-stock-costs.js');
  const {listLotSales}=await import('../../src/admin/painel/queries-lot-sales.js');
  const query=async(sql:string,args:unknown[]=[]) => (await db.pool.query(sql,args)).rows;
  const supplier=(await query(`INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES('test','QA Lotes vendas') RETURNING id`))[0];
  const buy=(quantity:number,total_cost:number)=>registerWholesalePurchase({environment:'test',supplier_id:supplier.id,items:[],
    lot:{description:'Pneus para borracharia',quantity,total_cost},payment_status:'paid',payment_method:'Pix',receipt_status:'received',
    created_by:'owner:qa',idempotency_key:randomUUID()},db.pool);
  const first=await buy(100,500),second=await buy(80,480);
  const sold_on=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const input={new_customer:{name:'Borracharia QA'},description:'Pneus para borracharia',amount:1000,discount:0,expected_cost:540,
    sold_on,payment_status:'pending' as const,due_date:sold_on,notes:'QA',idempotency_key:randomUUID(),
    allocations:[{lot_id:first.lot_id!,quantity:60},{lot_id:second.lot_id!,quantity:40}]};
  await registerLotSale({...input,idempotency_key:randomUUID(),amount:400,expected_cost:200,
    allocations:[{lot_id:first.lot_id!,quantity:40}]},'owner:qa',null,db.pool);
  const sale=await registerLotSale(input,'owner:qa',null,db.pool);
  assert.equal(sale.total_amount,1000);assert.equal(sale.cost,540);
  assert.deepEqual(await registerLotSale(input,'owner:qa',null,db.pool),sale);
  const stock=await getStockCosts(db.pool);assert.equal(stock.summary.lot_quantity,40);assert.equal(stock.summary.lot_capital,240);
  assert.equal(stock.summary.catalog_quantity,0,'lot sale never creates catalog inventory');
  const history=await listLotSales(1,db.pool);assert.equal(history.total,2);assert.equal(history.rows[0].quantity,100);assert.equal(history.rows[0].cost,540);
  const summary=await getWholesaleResumo('test',db.pool,'tudo');assert.equal(Number(summary.faturamento),1400);assert.equal(Number(summary.custo_total),740);
  const entries=await query(`SELECT transaction_kind kind,amount FROM finance.matriz_ledger_transactions WHERE environment='test' AND source_id=$1 ORDER BY transaction_kind`,[sale.order_id]);
  assert.equal(entries.length,2);assert.equal(Number(entries.find(row=>row.kind==='cost_of_goods_sold').amount),540);
  assert.equal(Number(entries.find(row=>row.kind==='sale_receivable').amount),1000);
  await assert.rejects(()=>registerLotSale({...input,idempotency_key:randomUUID()},'owner:qa',null,db.pool),/lot_sale_stock_changed/);
  await assert.rejects(()=>registerLotSale({...input,amount:999},'owner:qa',null,db.pool),/idempotency_conflict/);
  await assert.rejects(()=>query(`UPDATE commerce.wholesale_order_items SET quantity=1 WHERE order_id=$1`,[sale.order_id]),/lot_sale_item_immutable/);
  await assert.rejects(()=>query(`DELETE FROM commerce.wholesale_order_items WHERE order_id=$1`,[sale.order_id]),/lot_sale_item_immutable/);
  const cancellation={order_id:sale.order_id,cancelled_by:'owner:qa',reason:'Cliente desistiu da venda',idempotency_key:randomUUID()};
  await cancelWholesaleSale(cancellation,db.pool);await cancelWholesaleSale(cancellation,db.pool);
  const restored=await getStockCosts(db.pool);assert.equal(restored.summary.lot_quantity,140);assert.equal(restored.summary.lot_capital,780);
  assert.equal(Number((await getWholesaleResumo('test',db.pool,'tudo')).faturamento),400);
  const movements=await query(`SELECT source,count(*)::int n FROM commerce.tire_lot_movements WHERE order_id=$1 GROUP BY source`,[sale.order_id]);
  assert.equal(movements.find(row=>row.source==='sale').n,2);assert.equal(movements.find(row=>row.source==='sale_cancel').n,2);
  const fractional=await buy(3,1);
  const fractionalSale=await registerLotSale({...input,new_customer:{name:'Cliente centavos'},idempotency_key:randomUUID(),payment_status:'paid',payment_method:'Pix',
    amount:5,discount:0.01,expected_cost:0.67,allocations:[{lot_id:fractional.lot_id!,quantity:2}]},'owner:qa',null,db.pool);
  assert.equal(fractionalSale.total_amount,4.99);assert.equal(fractionalSale.cost,0.67);
  assert.equal(Number((await query(`SELECT remaining_cost FROM commerce.tire_lots WHERE id=$1`,[fractional.lot_id]))[0].remaining_cost),0.33);
  const paidCancel={...cancellation,order_id:fractionalSale.order_id,idempotency_key:randomUUID()};await cancelWholesaleSale(paidCancel,db.pool);
  const refund=(await query(`SELECT amount FROM finance.matriz_ledger_transactions WHERE source_id=$1 AND transaction_kind='customer_refund_payable'`,[fractionalSale.order_id]))[0];
  assert.equal(Number(refund.amount),4.99,'paid sale cancellation creates refund payable, without claiming cash was refunded');
},60000);
it('bloqueia saldo reservado, custo desatualizado, compra pendente, outra origem e baixa o fiado no financeiro existente',async()=>{
  const {registerWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const {registerLotSale}=await import('../../src/admin/painel/register-lot-sale.js');
  const {cancelWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-cancel.js');
  const {settleWholesaleOrderPayment}=await import('../../src/admin/painel/queries-financeiro-integridade.js');
  const {resolveAdditionBuyer}=await import('../../src/admin/painel/queries-atacado-sale-buyer.js');
  const {listSaleLots}=await import('../../src/admin/painel/queries-lot-sales.js');
  const q=async(sql:string,args:unknown[]=[]) => (await db.pool.query(sql,args)).rows;
  const supplier=(await q(`INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES('test','Fornecedor QA controles') RETURNING id`))[0];
  const purchase={environment:'test' as const,supplier_id:supplier.id,items:[],lot:{description:'Lote controlado',quantity:10,total_cost:100},payment_status:'paid' as const,payment_method:'Pix',receipt_status:'received' as const,created_by:'owner:qa',idempotency_key:randomUUID()};
  const received=await registerWholesalePurchase(purchase,db.pool);
  const pending=await registerWholesalePurchase({...purchase,receipt_status:'pending',idempotency_key:randomUUID()},db.pool);
  const otherSupplier=(await q(`INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES('prod','Fornecedor local isolado') RETURNING id`))[0];
  const other=await registerWholesalePurchase({...purchase,environment:'prod',supplier_id:otherSupplier.id,idempotency_key:randomUUID()},db.pool);
  const sold_on=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const input={new_customer:{name:'Cliente controles'},description:'Pneus para borracharia',sold_on,amount:100,discount:0,expected_cost:60,payment_status:'pending' as const,due_date:sold_on,idempotency_key:randomUUID(),allocations:[{lot_id:received.lot_id!,quantity:6}]};
  await q(`UPDATE commerce.tire_lots SET quantity_reserved=5 WHERE id=$1`,[received.lot_id]);
  await assert.rejects(()=>registerLotSale(input,'owner:qa',null,db.pool),/lot_sale_stock_changed/);
  await q(`UPDATE commerce.tire_lots SET quantity_reserved=0 WHERE id=$1`,[received.lot_id]);
  await assert.rejects(()=>registerLotSale({...input,expected_cost:1},'owner:qa',null,db.pool),/lot_sale_cost_changed/);
  await assert.rejects(()=>registerLotSale({...input,allocations:[{lot_id:pending.lot_id!,quantity:6}]},'owner:qa',null,db.pool),/lot_sale_lot_unavailable/);
  await assert.rejects(()=>registerLotSale({...input,allocations:[{lot_id:other.lot_id!,quantity:6}]},'owner:qa',null,db.pool),/lot_sale_lot_unavailable/);
  await assert.rejects(()=>registerLotSale({...input,sold_on:'2000-01-01'},'owner:qa',null,db.pool),/lot_sale_before_receipt/);
  const available=await listSaleLots(db.pool);assert(!available.some((row:any)=>[pending.lot_id,other.lot_id].includes(row.id)));
  const sale=await registerLotSale(input,'owner:qa',null,db.pool);
  const client=await db.pool.connect();await assert.rejects(()=>resolveAdditionBuyer(client,'test',sale.order_id),/wholesale_parent_order_not_open_root/);client.release();
  await assert.rejects(()=>cancelWholesalePurchase({purchase_id:received.purchase_id,cancelled_by:'owner:qa',reason:'Tentar cancelar compra consumida',idempotency_key:randomUUID()},db.pool),/lot.*consumed|purchase_stock_consumed/);
  const payment={idempotency_key:randomUUID(),actor_label:'owner:qa',payment_method:'Pix'};
  await settleWholesaleOrderPayment(sale.order_id,'test',db.pool,payment);await settleWholesaleOrderPayment(sale.order_id,'test',db.pool,payment);
  const updated=(await q(`SELECT payment_status,payment_method FROM commerce.wholesale_orders WHERE id=$1`,[sale.order_id]))[0];assert.equal(updated.payment_status,'paid');assert.equal(updated.payment_method,'Pix');
  assert.equal((await q(`SELECT id FROM finance.matriz_ledger_transactions WHERE source_id=$1 AND transaction_kind='payment'`,[sale.order_id])).length,1);
  assert.equal(Number((await q(`SELECT quantity_on_hand FROM commerce.tire_lots WHERE id=$1`,[other.lot_id]))[0].quantity_on_hand),10);
},60000);
