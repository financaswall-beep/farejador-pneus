import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';
import { businessDateSaoPaulo } from '../../src/shared/business-time.js';

let db: IntegrationDb;
const actor = 'owner:teste';
const today = businessDateSaoPaulo(new Date());
const plan = { received: 20.01, method: 'Pix' as const,
  installments: [{ due_date: today, amount: 30 }, { due_date: '2099-01-01', amount: 49.99 }] };

beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgres://test', FAREJADOR_ENV: 'test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token', WHOLESALE_FINANCE: 'true',
    MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true', WHOLESALE_STOCK_DECREMENT: 'true' });
  db = await startPostgres();
  const product = await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand)
    VALUES ('test','parcelas','Pneu parcelas','tire','Marca') RETURNING id`);
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
    VALUES ('test',$1,'96/90-19',96,90,19)`, [product.rows[0].id]);
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES ('test','96/90-19','Marca','novo',20,10)`);
}, 180000);
afterAll(async () => { if (db) await stopPostgres(db); });

async function openParts(id: string) {
  const { getMatrizLedgerOpenItems } = await import('../../src/admin/painel/matriz-ledger-open-items.js');
  const result = await getMatrizLedgerOpenItems('test',db.pool);
  return result.a_receber.itens.filter(row => row.id.startsWith(id + ':')).sort((a,b) => a.id.localeCompare(b.id));
}
const sale = () => ({ items: [{ measure: '96/90-19', brand: 'Marca', tire_condition: 'novo', quantity: 2, unit_price: 50 }],
  payment_status: 'pending' as const, due_date: today, created_by: actor, idempotency_key: randomUUID() });

async function reschedule(id: string, number: number, oldDate: string, newDate: string, key = randomUUID()) {
  const { changeSaleInstallmentDueDate } = await import('../../src/admin/painel/sale-installment-due-date.js');
  return changeSaleInstallmentDueDate({ order_id:id, number, expected_due_date:oldDate,
    due_date:newDate, idempotency_key:key },actor,db.pool);
}

it('atacado separa entrada e parcelas, aceita baixa fora de ordem e quita apenas o saldo', async () => {
  const { registerWholesaleSale } = await import('../../src/admin/painel/queries-atacado-vendas.js');
  const { settleMatrizLedgerOpenItem } = await import('../../src/admin/painel/matriz-ledger-settlement.js');
  const { settleWholesaleOrderPayment } = await import('../../src/admin/painel/queries-financeiro-integridade.js');
  const { getWholesaleFinance } = await import('../../src/admin/painel/queries-fiado-despesas.js');
  const { listWholesaleSales } = await import('../../src/admin/painel/queries-atacado-cancelar.js');
  const oldDate = '2020-05-02';
  const input = { ...sale(), sold_at:'2020-05-01T15:00:00Z', due_date:oldDate,
    new_customer: { name: 'Borracharia parcelas' },
    payment_plan:{...plan,installments:[{due_date:oldDate,amount:30},plan.installments[1]!]} };
  await expect(registerWholesaleSale({ ...input, payment_plan: { ...input.payment_plan, received: 20 } },db.pool)).rejects.toThrow('sale_plan_total_mismatch');
  const result = await registerWholesaleSale(input,db.pool);
  expect(await registerWholesaleSale(input,db.pool)).toEqual(result);
  const id = result.order_id;
  const { getMatrizFinanceiroVisao } = await import('../../src/admin/painel/queries-financeiro-visao.js');
  const { getMatrizNotificacoes } = await import('../../src/admin/painel/queries-notificacoes.js');
  const overview = await getMatrizFinanceiroVisao('test',db.pool,oldDate.slice(0,7));
  expect(Number(overview.a_receber.total)).toBe(79.99);
  expect(overview.indicadores.fiado_aberto_pct).toBeCloseTo(80,0);
  expect((await getMatrizNotificacoes('test',db.pool)).fiado_vencido.count).toBe(1);
  const rows = await openParts(id);
  expect(rows.map(row => row.valor)).toEqual(['30.00','49.99']);
  const due = '2098-12-05';
  const key = randomUUID();
  const financialState = async () => (await db.pool.query(`SELECT
    (SELECT count(*) FROM finance.matriz_ledger_transactions) txs,
    (SELECT count(*) FROM finance.matriz_ledger_payments) payments,
    (SELECT sum(quantity_on_hand) FROM commerce.wholesale_stock) stock`)).rows[0];
  const before = await financialState();
  const changed = await reschedule(id,1,oldDate,due,key);
  expect(await reschedule(id,1,oldDate,due,key)).toEqual(changed);
  expect((await getMatrizNotificacoes('test',db.pool)).fiado_vencido.count).toBe(0);
  expect(await financialState()).toEqual(before);
  expect((await openParts(id)).map(row => [row.due_date,row.valor])).toEqual([[due,'30.00'],['2099-01-01','49.99']]);
  expect((await listWholesaleSales('test',db.pool)).find(row=>row.id===id)?.sale_plan)
    .toMatchObject({next_due:due,balance:79.99,received:20.01});
  await expect(reschedule(id,1,oldDate,'2098-12-06')).rejects.toThrow('sale_installment_changed');
  await expect(reschedule(id,1,due,'2000-01-01')).rejects.toThrow('installment_before_sale');
  const edits = await db.pool.query(`SELECT payload_before,payload_after,actor_label FROM audit.events
    WHERE entity_id=$1 AND event_type='installment_due_date_changed'`,[id]);
  expect(edits.rows).toEqual([{payload_before:{number:1,due_date:oldDate},payload_after:{number:1,due_date:due},actor_label:actor}]);
  const races = await Promise.allSettled(['2098-12-06','2098-12-07'].map(d => reschedule(id,1,due,d)));
  expect(races.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(races.find(r=>r.status==='rejected')).toMatchObject({reason:{message:'sale_installment_changed'}});
  const baixa = { environment: 'test' as const, obligation_id: rows[1]!.obligation_id!,
    sale_installment: { order_id:id, number:2 }, amount:49.99, payment_method:'Pix', idempotency_key:randomUUID() };
  const paid = await settleMatrizLedgerOpenItem(baixa,db.pool);
  expect(await settleMatrizLedgerOpenItem(baixa,db.pool)).toEqual(paid);
  await expect(settleMatrizLedgerOpenItem({...baixa,idempotency_key:randomUUID()},db.pool)).rejects.toThrow('sale_installment_changed');
  await expect(reschedule(id,2,'2099-01-01',due)).rejects.toThrow('sale_installment_changed');
  expect((await openParts(id)).map(row=>row.valor)).toEqual(['30.00']);
  expect(Number((await getWholesaleFinance('test',db.pool)).receivables.find(row=>row.id===id)?.total_amount)).toBe(30);
  await settleWholesaleOrderPayment(id,'test',db.pool,{idempotency_key:randomUUID(),payment_method:'Pix'});
  expect((await listWholesaleSales('test',db.pool)).find(row=>row.id===id)).toMatchObject({
    payment_status:'paid',sale_plan:{received:100,balance:0} });
  expect(await openParts(id)).toEqual([]);
  await expect(reschedule(id,1,due,'2098-12-08')).rejects.toThrow('sale_installment_changed');
});

it('lote desconta o desconto antes de parcelar e ao cancelar devolve apenas o dinheiro recebido',async () => {
  const {registerWholesalePurchase} = await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const {registerLotSale} = await import('../../src/admin/painel/register-lot-sale.js');
  const {cancelWholesaleSale} = await import('../../src/admin/painel/queries-atacado-cancelar.js');
  const {listLotSales} = await import('../../src/admin/painel/queries-lot-sales.js');
  const supplier=await db.pool.query(`INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES('test','Fornecedor parcelas') RETURNING id`);
  const purchase=await registerWholesalePurchase({supplier_id:supplier.rows[0].id,items:[],lot:{description:'Lote parcelas',quantity:10,total_cost:50},
    receipt_status:'received',payment_status:'paid',payment_method:'Pix',created_by:actor,idempotency_key:randomUUID()},db.pool);
  const input={new_customer:{name:'Cliente lote'},amount:110,discount:10,description:'Pneus lote',sold_on:today,
    expected_cost:10,notes:'',allocations:[{lot_id:purchase.lot_id!,quantity:2}],payment_status:'pending' as const,
    due_date:today,payment_plan:plan,idempotency_key:randomUUID()};
  const sale=await registerLotSale(input,actor,null,db.pool);
  expect(await registerLotSale(input,actor,null,db.pool)).toEqual(sale);
  expect((await listLotSales(1,db.pool)).rows[0]).toMatchObject({sale_plan:{received:20.01,balance:79.99}});
  const { writeOffMatrizCredit } = await import('../../src/admin/painel/matriz-ledger-writeoff.js');
  const parts = await openParts(sale.order_id);
  await writeOffMatrizCredit({ environment:'test', obligation_id:parts[1]!.obligation_id!,
    sale_installment:2, amount:10, reason:'Perda comprovada', idempotency_key:randomUUID() },db.pool);
  expect((await openParts(sale.order_id)).map(p=>p.valor)).toEqual(['30.00','39.99']);
  expect((await listLotSales(1,db.pool)).rows[0].sale_plan.received).toBe(20.01);
  await reschedule(sale.order_id,2,'2099-01-01','2099-02-05');
  const lotPlan = (await listLotSales(1,db.pool)).rows[0].sale_plan;
  expect(lotPlan.installments[1]).toMatchObject({due_date:'2099-02-05',balance:39.99,amount:49.99});
  await cancelWholesaleSale({order_id:sale.order_id,reason:'Desistência da compra',cancelled_by:actor,idempotency_key:randomUUID()},db.pool);
  expect(await openParts(sale.order_id)).toEqual([]);
  await expect(reschedule(sale.order_id,1,today,'2099-02-05')).rejects.toThrow('sale_installment_changed');
  const refund=await db.pool.query(`SELECT e.amount FROM finance.matriz_ledger_transactions t
    JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id WHERE t.source_id=$1 AND e.account_code='customer_refund_payable'`,[sale.order_id]);
  expect(Number(refund.rows[0].amount)).toBe(20.01);
});

it('apura a entrada do parceiro sobre o valor aceito na chegada e espelha a baixa',async()=>{
  const {registerWholesaleSale}=await import('../../src/admin/painel/queries-atacado-vendas.js');
  const {settlePartnerArrival}=await import('../../src/admin/painel/queries-partner-transfer-arrival.js');
  const partner=await createPartnerFixture(db.pool,{slugSuffix:'parcelas'});
  const original=await registerWholesaleSale({...sale(),partner_id:partner.partnerId,partner_unit_id:partner.partnerUnitId},db.pool);
  const item=await db.pool.query('SELECT id FROM commerce.wholesale_order_items WHERE order_id=$1',[original.order_id]);
  const arrival={order_id:original.order_id,items:[{order_item_id:item.rows[0].id,accepted_quantity:1}],
    payment_plan:{...plan,installments:[{due_date:today,amount:10},{due_date:'2099-01-01',amount:19.99}]},actor_label:actor,idempotency_key:randomUUID()};
  await settlePartnerArrival(arrival,db.pool);
  await settlePartnerArrival(arrival,db.pool);
  const parts=await openParts(original.order_id);
  expect(parts.map(row=>row.valor)).toEqual(['10.00','19.99']);
  await reschedule(original.order_id,1,today,'2098-12-05');
  const corrected=await db.pool.query(`SELECT o.due_date::text sale,p.payable_due_date::text purchase,f.due_date::text payable
    FROM commerce.wholesale_orders o JOIN commerce.partner_purchases p ON p.source_wholesale_order_id=o.id
    JOIN finance.partner_payables f ON f.source_purchase_id=p.id WHERE o.id=$1`,[original.order_id]);
  expect(corrected.rows[0]).toEqual({sale:'2098-12-05',purchase:'2098-12-05',payable:'2098-12-05'});
  const {settleMatrizLedgerOpenItem}=await import('../../src/admin/painel/matriz-ledger-settlement.js');
  const baixaParceiro=await settleMatrizLedgerOpenItem({environment:'test', obligation_id:parts[0]!.obligation_id!,
    sale_installment:{order_id:original.order_id,number:1}, payment_method:'Pix',idempotency_key:randomUUID()},db.pool);
  const due=await db.pool.query('SELECT due_date::text FROM finance.partner_payables WHERE source_purchase_id=$1',[original.linked_partner_purchase_id]);
  expect(due.rows[0].due_date).toBe('2099-01-01');
  const mirrored=await db.pool.query(`SELECT e.amount FROM finance.partner_payable_events e
    JOIN finance.partner_payables p ON p.id=e.payable_id WHERE p.source_purchase_id=$1`,[original.linked_partner_purchase_id]);
  expect(mirrored.rows.map(row=>Number(row.amount)).sort((a,b)=>a-b)).toEqual([10,20.01]);
  const { reverseSettlement,renegotiate }=await import('../../src/admin/dot/finance-operations.js');
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');
    await reverseSettlement(client,{pagamento_id:baixaParceiro.payment_ids[0]!,valor_esperado:10,
      ocorrido_em:new Date().toISOString(),motivo:'Parcela errada',idempotency_key:randomUUID()},actor);
    const changed=await renegotiate(client,{obligation_id:parts[0]!.obligation_id!,saldo_esperado:29.99,
      parcelas:[{due_date:'2099-02-01',amount:15},{due_date:'2099-03-01',amount:14.99}],idempotency_key:randomUUID()},actor);
    expect(changed.acordo).toMatchObject({balance:29.99,received:20.01,next_due:'2099-02-01'});
    await client.query('COMMIT');
  } catch(error){ await client.query('ROLLBACK'); throw error; } finally{client.release();}
  const mirrorAfter=await db.pool.query(`SELECT f.status,f.due_date::text due,sum(e.amount)::text paid FROM finance.partner_payables f
    JOIN finance.partner_payable_events e ON e.payable_id=f.id WHERE f.source_purchase_id=$1 GROUP BY f.id`,[original.linked_partner_purchase_id]);
  expect(mirrorAfter.rows[0]).toEqual({status:'open',due:'2099-02-01',paid:'20.01'});
  const cash=await db.pool.query("SELECT id FROM finance.matriz_ledger_transactions WHERE environment='test' AND source_id=$1",[original.order_id+':entrada']);
  const correction=await db.pool.connect();
  try {
    await correction.query('BEGIN');
    const reopened=await reverseSettlement(correction,{pagamento_id:cash.rows[0].id,valor_esperado:20.01,
      ocorrido_em:new Date().toISOString(),motivo:'Entrada da carga informada por engano',
      vencimento_entrada_estornada:'2099-01-20',idempotency_key:randomUUID()},actor);
    expect(reopened).toMatchObject({saldo:'50.00',entrada_reaberta:{amount:20.01,balance:20.01,due_date:'2099-01-20'}});
    await correction.query('COMMIT');
  } catch(error){ await correction.query('ROLLBACK'); throw error; } finally{correction.release();}
  const partnerState=await db.pool.query(`SELECT f.due_date::text due,sum(e.amount)::text paid FROM finance.partner_payables f
    JOIN finance.partner_payable_events e ON e.payable_id=f.id WHERE f.source_purchase_id=$1 GROUP BY f.id`,[original.linked_partner_purchase_id]);
  expect(partnerState.rows[0]).toEqual({due:'2099-01-20',paid:'0.00'});
});
