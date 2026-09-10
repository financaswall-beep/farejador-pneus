import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('relatório de compras contra Postgres com operações reais', () => {
  let db: IntegrationDb, supplier: string, partialId: string;
  let read: typeof import('../../src/admin/painel/queries-purchase-report.js').getPurchaseReport;
  let parse: typeof import('../../src/admin/painel/purchase-report-period.js').purchaseReportQuery;
  let register: typeof import('../../src/admin/painel/queries-fornecedores-registro.js').registerWholesalePurchase;
  const measure='298/98-28', other='297/98-28';
  beforeAll(async () => {
    Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test-secret',
      ADMIN_AUTH_TOKEN:'test',WHOLESALE_FINANCE:'true',MATRIZ_CENTRAL_LEDGER:'true'});
    vi.resetModules();db=await startPostgres();
    ({getPurchaseReport:read}=await import('../../src/admin/painel/queries-purchase-report.js'));
    ({purchaseReportQuery:parse}=await import('../../src/admin/painel/purchase-report-period.js'));
    const registration=await import('../../src/admin/painel/queries-fornecedores-registro.js');register=registration.registerWholesalePurchase;
    for(const [i,size] of [measure,other].entries()){
      const product=await db.pool.query<{id:string}>(`INSERT INTO commerce.products
        (environment,product_code,product_name,product_type,brand,tire_condition)
        VALUES ('test',$1,'Pneu relatório','tire','Pirelli','novo') RETURNING id`,['REPORT-PURCHASE-'+i]);
      const id=product.rows[0]!.id;
      await db.pool.query(`INSERT INTO commerce.tire_specs (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
        VALUES ('test',$1,$2,$3,98,28)`,[id,size,298-i]);
      await db.pool.query(`INSERT INTO commerce.matriz_product_prices (environment,product_id,price_amount,currency,valid_from)
        VALUES ('test',$1,200,'BRL','2026-01-01T00:00:00Z')`,[id]);
    }
    supplier=(await db.pool.query<{id:string}>(`INSERT INTO commerce.wholesale_suppliers(environment,name)
      VALUES('test','Fornecedor Relatório') RETURNING id`)).rows[0]!.id;
    const create=(date:string,quantity:number,cost:number,receipt:'pending'|'received'='pending',items?:Array<{measure:string;quantity:number;unit_cost:number;brand:string;tire_condition:'novo'}>)=>register({
      environment:'test',supplier_id:supplier,created_by:'owner:report-test',purchased_at:date,payment_status:'pending',
      due_date:'2026-10-01',receipt_status:receipt,idempotency_key:randomUUID(),
      items:items??[{measure,quantity,unit_cost:cost,brand:'Pirelli',tire_condition:'novo'}],
    },db.pool);
    // A compra das 02:59Z ainda pertence a agosto em São Paulo.
    await create('2026-09-01T02:59:00Z',1,999);
    await create('2026-08-01T12:00:00-03:00',2,80,'received');
    const partial=await register({environment:'test',supplier_id:supplier,created_by:'owner:report-test',
      purchased_at:'2026-09-01T03:00:00Z',payment_status:'pending',due_date:'2026-10-01',receipt_status:'pending',
      freight_amount:30,discount_amount:10,idempotency_key:randomUUID(),
      items:[{measure,quantity:3,unit_cost:100,brand:'Pirelli',tire_condition:'novo'}]},db.pool);
    partialId=partial.purchase_id;
    const item=(await db.pool.query<{id:string}>(`SELECT id FROM commerce.wholesale_purchase_items WHERE environment='test' AND purchase_id=$1`,[partialId])).rows[0]!.id;
    await registration.confirmWholesalePurchase({environment:'test',purchase_id:partialId,confirmed_by:'owner:report-test',
      idempotency_key:randomUUID(),items:[{item_id:item,accepted_quantity:2}]},db.pool);
    const obligation=(await db.pool.query<{id:string}>(`SELECT id FROM finance.matriz_ledger_transactions
      WHERE environment='test' AND source_type='commerce.wholesale_purchase.accrual' AND source_id=$1`,[partialId])).rows[0]!.id;
    const {settleMatrizLedgerOpenItem}=await import('../../src/admin/painel/matriz-ledger-settlement.js');
    await settleMatrizLedgerOpenItem({environment:'test',obligation_id:obligation,amount:50,paid_at:'2026-09-02T12:00:00-03:00',
      payment_method:'pix',cash_account:'Caixa principal',actor_label:'owner:report-test',idempotency_key:randomUUID()},db.pool);
    await create('2026-09-03T12:00:00-03:00',1,100,'pending',[
      {measure,quantity:1,unit_cost:100,brand:'Pirelli',tire_condition:'novo'},
      {measure:other,quantity:2,unit_cost:50,brand:'Pirelli',tire_condition:'novo'},
    ]);
    const cancelled=await create('2026-09-04T12:00:00-03:00',9,999);
    const {cancelWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-cancel.js');
    await cancelWholesalePurchase({environment:'test',purchase_id:cancelled.purchase_id,cancelled_by:'owner:report-test',
      reason:'Compra cancelada na validação',idempotency_key:randomUUID()},db.pool);
    // O ambiente prod abaixo existe somente dentro deste container descartável.
    const isolated=(await db.pool.query<{id:string}>(`INSERT INTO commerce.products
      (environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES ('prod','REPORT-ISOLATION','Pneu isolado','tire','Pirelli','novo') RETURNING id`)).rows[0]!.id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
      VALUES('prod',$1,$2,298,98,28)`,[isolated,measure]);
    await register({environment:'prod',new_supplier:{name:'Outro ambiente'},created_by:'owner:report-test',
      purchased_at:'2026-09-02T12:00:00-03:00',payment_status:'pending',due_date:'2026-10-01',receipt_status:'pending',idempotency_key:randomUUID(),
      items:[{measure,quantity:90,unit_cost:100,brand:'Pirelli',tire_condition:'novo'}]},db.pool);
  },180_000);
  afterAll(async()=>{if(db)await stopPostgres(db);process.env.MATRIZ_CENTRAL_LEDGER='false';});

  it('bate com conferência parcial, rateio, saldo de obrigação, período local e ambiente',async()=>{
    const report=await read(parse.parse({from:'2026-09-01',to:'2026-09-10'}),true,'test',db.pool);
    expect(report.summary).toMatchObject({value:420,quantity:5,ordered:6,received:2,transit:3,purchases:2,suppliers:1,
      full_total:420,paid:50,open:370,average_cost:84});
    expect(report.previous).toMatchObject({value:160,quantity:2});
    expect(report.purchases.rows.find(row=>row.id===partialId)).toMatchObject({value:220,paid:50,open:170,status:'confirmed'});
    expect(report.products.find(row=>row.measure===measure)).toMatchObject({value:320,quantity:3,average_cost:106.67,previous_average:80});
    expect(report.products.find(row=>row.measure===other)).toMatchObject({previous_average:null,change_pct:null});
  });
  it('filtros e exportação preservam custos dos itens e pagamentos integrais, sem vazar outro ambiente',async()=>{
    const filter=parse.parse({from:'2026-09-01',to:'2026-09-10',measure:other,exact:'true'});
    const report=await read(filter,true,'test',db.pool);
    expect(report.summary).toMatchObject({value:100,quantity:2,full_total:200,open:200,paid:0,purchases:1});
    expect(report.purchases.rows[0]!.items).toHaveLength(1);
    expect((await read({...filter,measure:'',receipt:'received'},false,'test',db.pool)).summary).toMatchObject({value:220,quantity:2,open:null,paid:null});
    expect((await read({...filter,measure:'',compare:'false'},true,'prod',db.pool)).summary.quantity).toBe(90);
    // Outra entrada muda o custo do estoque, mas não o histórico desta compra.
    await register({environment:'test',supplier_id:supplier,created_by:'owner:report-test',purchased_at:'2026-08-20T12:00:00-03:00',
      payment_status:'paid',receipt_status:'received',idempotency_key:randomUUID(),items:[{measure:other,quantity:1,unit_cost:900,brand:'Pirelli',tire_condition:'novo'}]},db.pool);
    expect((await read(filter,true,'test',db.pool)).summary.value).toBe(100);
  });
});
