import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
import type {AdvanceCommand} from '../../src/admin/painel/supplier-advance-schema.js';
let db:IntegrationDb,svc:typeof import('../../src/admin/painel/supplier-advances.js'),
 read:typeof import('../../src/admin/painel/supplier-finance-read.js'), purchase:typeof import('../../src/admin/painel/queries-fornecedores-registro.js');
const day='2026-10-06T15:00:00Z';
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test-secret',
    ADMIN_AUTH_TOKEN:'test-token',MATRIZ_CENTRAL_LEDGER:'true',MATRIZ_CENTRAL_LEDGER_READ:'true',WHOLESALE_FINANCE:'true'});
  db=await startPostgres();process.env.DATABASE_URL=db.connectionString;vi.resetModules();
  svc=await import('../../src/admin/painel/supplier-advances.js');
  read=await import('../../src/admin/painel/supplier-finance-read.js');
  purchase=await import('../../src/admin/painel/queries-fornecedores-registro.js');
},180000);
afterAll(async()=>{if(db){await (await import('../../src/persistence/db.js')).pool.end();await stopPostgres(db);}});
async function run(data:AdvanceCommand){
  const client=await db.pool.connect();
  try{await client.query('BEGIN');const result=await svc.runSupplierAdvance(client,data,'teste','test');await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function supplier(){return (await db.pool.query("INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES('test',$1) RETURNING id",['Teste '+randomUUID()])).rows[0].id as string;}
function base(id:string,amount:number){return {supplier_id:id,occurred_at:day,amount,reason:'Pneus de teste',idempotency_key:randomUUID()};}
const issue=(id:string,amount:number):AdvanceCommand=>({...base(id,amount),action:'issue',payment_method:'pix',cash_account:'Conta da loja'});
async function lot(id:string){
 return purchase.registerWholesalePurchase({environment:'test',supplier_id:id,items:[],lot:{description:'Lote QA',quantity:5,total_cost:1500},
  purchased_at:day,created_by:'teste',payment_status:'pending',receipt_status:'pending',installments:[{amount:750,due_date:'2026-11-01'},{amount:750,due_date:'2026-12-01'}],idempotency_key:randomUUID()},db.pool);
}
async function cash(){return Number((await db.pool.query("SELECT coalesce(sum(CASE WHEN side='credit' THEN amount ELSE -amount END),0) value FROM finance.matriz_ledger_entries WHERE environment='test' AND account_code='cash'")).rows[0].value);}
it('aplica na parcela escolhida, quita o restante e reprocessa duas vezes sem nova saída',async()=>{
 const id=await supplier(),start=await cash(),cmd=issue(id,500),credit=await run(cmd);
 expect(await run(cmd)).toEqual(credit);
 const order=await lot(id);
 const apply:AdvanceCommand={...base(id,500),action:'apply',advance_id:credit.id,purchase_id:order.purchase_id,installment:2};
 const used=await run(apply);expect(await run(apply)).toEqual(used);
 const detail=await read.supplierFinanceDetail(id,db.pool,'test');expect(detail.payables.map(p=>Number(p.balance))).toEqual([750,250]);
 expect(await cash()-start).toBe(500);
 const {settleWholesalePurchasePayment}=await import('../../src/admin/painel/queries-financeiro-integridade.js');
 await settleWholesalePurchasePayment(order.purchase_id,'test',db.pool,{paid_at:day,actor_label:'teste',idempotency_key:randomUUID()});
 expect((await read.supplierFinanceDetail(id,db.pool,'test')).payables).toEqual([]);
 const {runMatrizStage3LedgerBackfill}=await import('../../src/admin/painel/matriz-ledger-stage3-reconciliation.js');
 for(let i=0;i<2;i++)await runMatrizStage3LedgerBackfill({environment:'test'},db.pool);
 expect(await cash()-start).toBe(1500);
});
it('preserva parcela no pagamento pelo contrato web/Caixa',async()=>{
 const id=await supplier(),o=await lot(id),d=await read.supplierFinanceDetail(id,db.pool,'test');
 const {settleFinanceItem,settleFinanceItemSchema}=await import('../../src/admin/painel/finance-settlement-service.js');
 await settleFinanceItem(settleFinanceItemSchema.parse({settlement_mode:'wholesale_purchase',target_id:o.purchase_id+':2',obligation_id:d.payables[1].obligation_id,
  amount:500,paid_at:day,payment_method:'pix',cash_account:'Loja',idempotency_key:randomUUID()}),'teste');
 expect((await read.supplierFinanceDetail(id,db.pool,'test')).payables.map(p=>Number(p.balance))).toEqual([750,250]);
});
it('serializa consumo do mesmo crédito e recompõe parcialmente antes de cancelar',async()=>{
 const id=await supplier(),start=await cash(),credit=await run(issue(id,500)),orders=[await lot(id),await lot(id)];
 const applications=await Promise.allSettled(orders.map(o=>run({...base(id,500),action:'apply',advance_id:credit.id,purchase_id:o.purchase_id,installment:1})));
 expect(applications.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const index=applications.findIndex(r=>r.status==='fulfilled'),app=applications[index]!;
 if(app.status!=='fulfilled')throw Error('aplicação ausente');
 await run({...base(id,200),action:'restore',application_id:app.value.id});
 expect(Number((await read.supplierFinanceDetail(id,db.pool,'test')).credits[0].available)).toBe(200);
 const {cancelWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-cancel.js');
 await cancelWholesalePurchase({environment:'test',purchase_id:orders[index]!.purchase_id,cancelled_by:'teste',idempotency_key:randomUUID(),reason:'Pedido cancelado'},db.pool);
 expect(Number((await read.supplierFinanceDetail(id,db.pool,'test')).credits[0].available)).toBe(500);
 await run({...base(id,200),action:'refund',advance_id:credit.id,payment_method:'pix',cash_account:'Loja'});
 expect(await cash()-start).toBe(300);
});

it('quita só com crédito, preserva o pagador e divide uma única saída entre duas compras',async()=>{
 const id=await supplier(),start=await cash(),orders=[await lot(id),await lot(id)],credit=await run(issue(id,1750));
 const {readPurchaseSharing}=await import('../../src/admin/painel/purchase-sharing-read.js');
 const {writePurchaseSharing}=await import('../../src/admin/painel/purchase-sharing-write.js');
 for(const [index,part,amount] of [[0,1,750],[0,2,750],[1,2,250]] as const)
   await run({...base(id,amount),action:'apply',advance_id:credit.id,purchase_id:orders[index]!.purchase_id,installment:part});
 const partId=randomUUID(),first=orders[0]!.purchase_id;
 await writePurchaseSharing(first,{kind:'agreement',revision:0,key:randomUUID(),participants:[{id:partId,name:'Sócio de teste',mode:'percent',value:50}]},'teste','test',db.pool);
 await writePurchaseSharing(first,{kind:'cash',revision:1,key:randomUUID(),transaction_id:credit.id,allocations:[{id:partId,value:300}]},'teste','test',db.pool);
 const a=await readPurchaseSharing(db.pool,'test',first),b=await readPurchaseSharing(db.pool,'test',orders[1]!.purchase_id);
 expect(a.supplier_cash).toBe(1200);expect(a.participants[0]?.paid_supplier).toBe(300);expect(b.supplier_cash).toBe(250);
 const {runMatrizStage3LedgerBackfill}=await import('../../src/admin/painel/matriz-ledger-stage3-reconciliation.js');
 for(let i=0;i<2;i++)await runMatrizStage3LedgerBackfill({environment:'test'},db.pool);
 expect(await cash()-start).toBe(1750);
 // Reabre toda a primeira compra; o desembolso do sócio continua auditável na origem.
 const allocations=(await read.supplierFinanceDetail(id,db.pool,'test')).movements.filter(m=>m.purchase_id===first && m.source_type.endsWith('.apply'));
 for(const application of allocations)await run({...base(id,Number(application.amount)),action:'restore',application_id:application.id});
 const third=(await lot(id)).purchase_id;
 for(const installment of [1,2])await run({...base(id,750),action:'apply',advance_id:credit.id,purchase_id:third,installment});
 const split=await Promise.all([first,orders[1]!.purchase_id,third].map(p=>readPurchaseSharing(db.pool,'test',p)));
 expect(split.reduce((sum,p)=>sum+p.supplier_cash,0)).toBe(1450);
 expect(split[0]!.participants[0]!.paid_supplier).toBe(300);
 expect((await db.pool.query("SELECT finance.matriz_stage3_ledger_reconciliation('test')->>'purchase_payment_missing' missing")).rows[0].missing).toBe('0');
});
it('recebe 4 de 10 pneus e recompõe apenas o excesso após baixa mista',async()=>{
 const id=await supplier(),start=await cash(),measure='215/50-16';
 const product=(await db.pool.query("INSERT INTO commerce.products(environment,product_code,product_name,product_type) VALUES ('test',$1,'Pneu de teste','tire') RETURNING id",[randomUUID()])).rows[0].id;
 await db.pool.query("INSERT INTO commerce.tire_specs(environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter) VALUES ('test',$1,$2,215,50,16)",[product,measure]);
 const purchaseId=(await purchase.registerWholesalePurchase({environment:'test',supplier_id:id,items:[{measure,quantity:10,unit_cost:150}],
  purchased_at:day,receipt_status:'pending',payment_status:'pending',installments:[{amount:750,due_date:'2026-11-01'},{amount:750,due_date:'2026-12-01'}],
  created_by:'teste',idempotency_key:randomUUID()},db.pool)).purchase_id;
 const credit=await run(issue(id,500));
 await run({...base(id,500),action:'apply',purchase_id:purchaseId,advance_id:credit.id,installment:2});
 const detail=await read.supplierFinanceDetail(id,db.pool,'test');
 const {settleFinanceItem,settleFinanceItemSchema}=await import('../../src/admin/painel/finance-settlement-service.js');
 await settleFinanceItem(settleFinanceItemSchema.parse({settlement_mode:'wholesale_purchase',target_id:purchaseId+':1',obligation_id:detail.payables[0].obligation_id,
   amount:300,paid_at:day,payment_method:'pix',cash_account:'Loja',idempotency_key:randomUUID()}),'teste');
 const item=(await db.pool.query('SELECT id FROM commerce.wholesale_purchase_items WHERE purchase_id=$1',[purchaseId])).rows[0].id;
 await purchase.confirmWholesalePurchase({environment:'test',purchase_id:purchaseId,items:[{item_id:item,accepted_quantity:4}],confirmed_by:'teste',idempotency_key:randomUUID()},db.pool);
 const updated=await read.supplierFinanceDetail(id,db.pool,'test');
 expect(Number(updated.credits[0].available)).toBe(200);expect(updated.payables).toHaveLength(0);
 expect(Number(updated.purchases[0].total_amount)).toBe(600);expect(updated.purchases[0].payment_status).toBe('paid');
 const breakdown=(await db.pool.query("SELECT * FROM finance.matriz_ledger_obligation_breakdown('test',$1)",[detail.payables[0].obligation_id])).rows[0];
 expect(Number(breakdown.cash_paid)).toBe(300);expect(Number(breakdown.open_amount)).toBe(0);
 expect(await cash()-start).toBe(800);
});
it('confere o fornecedor, a data, o arquivamento e o reenvio da correção',async()=>{
 const id=await supplier(),other=await supplier(),a=await run(issue(id,350)),o=await lot(id);
 await expect(run({...base(other,100),action:'apply',advance_id:a.id,purchase_id:o.purchase_id,installment:1})).rejects.toThrow();
 await expect(run({...base(id,100),occurred_at:'2026-10-05T15:00:00Z',action:'refund',advance_id:a.id,cash_account:'Caixa',payment_method:'pix'})).rejects.toThrow();
 await db.pool.query('UPDATE commerce.wholesale_suppliers SET deleted_at=now() WHERE id=$1',[id]);
 await expect(run(issue(id,50))).rejects.toThrow();
 const correction:AdvanceCommand={...base(id,350),action:'void',advance_id:a.id};
 expect(await run(correction)).toEqual(await run(correction));
 expect(Number((await read.supplierFinanceDetail(id,db.pool,'test')).credits[0].available)).toBe(0);
});

it('recompõe em duas etapas pelo identificador original, inclusive após perda da resposta',async()=>{
 const id=await supplier(),credit=await run(issue(id,500)),o=await lot(id);
 const used=await run({...base(id,500),action:'apply',advance_id:credit.id,purchase_id:o.purchase_id,installment:2});
 const restore=(n:number):AdvanceCommand=>({...base(id,n),action:'restore',application_id:used.id});
 const first=restore(200);expect(await run(first)).toEqual(await run(first));
 await expect(run(restore(301))).rejects.toThrow('maior');
 const last=restore(300);expect(await run(last)).toEqual(await run(last));
 expect(Number((await read.supplierFinanceDetail(id,db.pool,'test')).credits[0].available)).toBe(500);
});

it('conserva o Pix estornado e aceita o registro corrigido com a mesma referência bancária',async()=>{
 const id=await supplier(),reference='E-QA-'+randomUUID();
 const body={...base(id,500),action:'issue' as const,cash_account:'Conta da loja',payment_method:'pix' as const,bank_reference:reference};
 const original=await run(body);
 await run({...base(id,500),action:'void',advance_id:original.id});
 const corrected=await run({...body,amount:450,idempotency_key:randomUUID()});
 expect(corrected.id).not.toBe(original.id);
 expect((await run({...body,amount:450,idempotency_key:randomUUID()})).id).toBe(corrected.id);
 const rows=await read.supplierFinanceSummary(db.pool,'test');
 expect(Number(rows.find(s=>s.id===id)!.available)).toBe(450);
});
