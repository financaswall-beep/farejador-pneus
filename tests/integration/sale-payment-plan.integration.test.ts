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

it('atacado separa entrada e parcelas, aceita baixa fora de ordem e quita apenas o saldo', async () => {
  const { registerWholesaleSale } = await import('../../src/admin/painel/queries-atacado-vendas.js');
  const { settleMatrizLedgerOpenItem } = await import('../../src/admin/painel/matriz-ledger-settlement.js');
  const { settleWholesaleOrderPayment } = await import('../../src/admin/painel/queries-financeiro-integridade.js');
  const { getWholesaleFinance } = await import('../../src/admin/painel/queries-fiado-despesas.js');
  const { listWholesaleSales } = await import('../../src/admin/painel/queries-atacado-cancelar.js');
  const input = { ...sale(), new_customer: { name: 'Borracharia parcelas' }, payment_plan: plan };
  await expect(registerWholesaleSale({ ...input, payment_plan: { ...plan, received: 20 } },db.pool)).rejects.toThrow('sale_plan_total_mismatch');
  const result = await registerWholesaleSale(input,db.pool);
  expect(await registerWholesaleSale(input,db.pool)).toEqual(result);
  const id = result.order_id;
  const { getMatrizFinanceiroVisao } = await import('../../src/admin/painel/queries-financeiro-visao.js');
  const { getMatrizNotificacoes } = await import('../../src/admin/painel/queries-notificacoes.js');
  const overview = await getMatrizFinanceiroVisao('test',db.pool);
  expect(Number(overview.a_receber.total)).toBe(79.99);
  expect(overview.indicadores.fiado_aberto_pct).toBeCloseTo(80,0);
  expect((await getMatrizNotificacoes('test',db.pool)).fiado_vencido.count).toBe(0);
  const rows = await openParts(id);
  expect(rows.map(row => row.valor)).toEqual(['30.00','49.99']);
  const baixa = { environment: 'test' as const, obligation_id: rows[1]!.obligation_id!,
    sale_installment: { order_id:id, number:2 }, amount:49.99, payment_method:'Pix', idempotency_key:randomUUID() };
  const paid = await settleMatrizLedgerOpenItem(baixa,db.pool);
  expect(await settleMatrizLedgerOpenItem(baixa,db.pool)).toEqual(paid);
  await expect(settleMatrizLedgerOpenItem({...baixa,idempotency_key:randomUUID()},db.pool)).rejects.toThrow('sale_installment_changed');
  expect((await openParts(id)).map(row=>row.valor)).toEqual(['30.00']);
  expect(Number((await getWholesaleFinance('test',db.pool)).receivables.find(row=>row.id===id)?.total_amount)).toBe(30);
  await settleWholesaleOrderPayment(id,'test',db.pool,{idempotency_key:randomUUID(),payment_method:'Pix'});
  expect((await listWholesaleSales('test',db.pool)).find(row=>row.id===id)).toMatchObject({
    payment_status:'paid',sale_plan:{received:100,balance:0} });
  expect(await openParts(id)).toEqual([]);
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
  await cancelWholesaleSale({order_id:sale.order_id,reason:'Desistência da compra',cancelled_by:actor,idempotency_key:randomUUID()},db.pool);
  expect(await openParts(sale.order_id)).toEqual([]);
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
  const {settleMatrizLedgerOpenItem}=await import('../../src/admin/painel/matriz-ledger-settlement.js');
  await settleMatrizLedgerOpenItem({environment:'test', obligation_id:parts[0]!.obligation_id!,
    sale_installment:{order_id:original.order_id,number:1}, payment_method:'Pix',idempotency_key:randomUUID()},db.pool);
  const due=await db.pool.query('SELECT due_date::text FROM finance.partner_payables WHERE source_purchase_id=$1',[original.linked_partner_purchase_id]);
  expect(due.rows[0].due_date).toBe('2099-01-01');
  const mirrored=await db.pool.query(`SELECT e.amount FROM finance.partner_payable_events e
    JOIN finance.partner_payables p ON p.id=e.payable_id WHERE p.source_purchase_id=$1`,[original.linked_partner_purchase_id]);
  expect(mirrored.rows.map(row=>Number(row.amount)).sort((a,b)=>a-b)).toEqual([10,20.01]);
});
