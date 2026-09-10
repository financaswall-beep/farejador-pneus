import { randomUUID } from 'node:crypto';
import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';

describe('estoque e reposição: leitura do Postgres real',()=>{
  let db:IntegrationDb,read:typeof import('../../src/admin/painel/queries-stock-report.js').getStockReport;
  let query:typeof import('../../src/admin/painel/stock-report-filter.js').stockReportQuery;
  const measure='296/98-28',policyOnly='295/98-28';
  beforeAll(async()=>{
    Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test',
      ADMIN_AUTH_TOKEN:'test',WHOLESALE_FINANCE:'true',MATRIZ_CENTRAL_LEDGER:'true'});vi.resetModules();db=await startPostgres();
    ({getStockReport:read}=await import('../../src/admin/painel/queries-stock-report.js'));({stockReportQuery:query}=await import('../../src/admin/painel/stock-report-filter.js'));
    const id=(await db.pool.query<{id:string}>(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test','STOCK-REPORT','Pneu relatório estoque','tire','Pirelli','novo') RETURNING id`)).rows[0]!.id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
      VALUES('test',$1,$2,296,98,28)`,[id,measure]);
    await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount,currency,valid_from)
      VALUES('test',$1,200,'BRL','2026-01-01T00:00:00Z')`,[id]);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost,min_quantity)
      VALUES ('test',$1,'Pirelli','novo',4,1,100,20),('test',$1,'Michelin','novo',1,0,90,20),
      ('test',$1,'Pirelli','meia_vida',50,0,20,10),('prod',$1,'Pirelli','novo',999,0,100,999)`,[measure]);
    await db.pool.query(`INSERT INTO commerce.wholesale_replenishment_policies(environment,measure,tire_condition,min_quantity)
      VALUES('test',$1,'novo',20),('test',$2,'novo',12)`,[measure,policyOnly]);
    const supplier=(await db.pool.query<{id:string}>(`INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES('test','Fornecedor fictício') RETURNING id`)).rows[0]!.id;
    const {registerWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-registro.js');
    const register=(qty:number,brand:string)=>registerWholesalePurchase({environment:'test',supplier_id:supplier,
      created_by:'owner:stock-report',receipt_status:'pending',payment_status:'pending',due_date:'2027-01-01',
      idempotency_key:randomUUID(),items:[{measure,brand,tire_condition:'novo',quantity:qty,unit_cost:100}]},db.pool);
    await register(8,'Technic');
    const cancelled=await register(100,'Technic');
    const {cancelWholesalePurchase}=await import('../../src/admin/painel/queries-fornecedores-cancel.js');
    await cancelWholesalePurchase({environment:'test',purchase_id:cancelled.purchase_id,cancelled_by:'owner:test',reason:'Cancelamento de teste',idempotency_key:randomUUID()},db.pool);
    // Historical fixtures only, in the disposable database. Production is never contacted.
    await db.pool.query(`INSERT INTO commerce.wholesale_stock_movements(environment,measure,brand,tire_condition,op,qty_before,qty_after,source,created_at)
      VALUES('test',$1,'Pirelli','novo','update',28,4,'varejo',now()-interval '1 hour'),
      ('test',$1,'Pirelli','novo','update',4,6,'cancelamento_varejo',now()-interval '30 minutes'),
      ('test',$1,'Levorin','novo','update',2,0,'venda_atacado',now()-interval '2 hours'),
      ('test',$1,'Pirelli','novo','update',60,50,'varejo',now()-interval '40 days'),
      ('test',$1,'Pirelli','novo','update',80,70,'varejo',now()-interval '80 days'),
      ('test',$1,'Pirelli','novo','update',50,0,'baixa_manual',now()-interval '5 hours'),
      ('prod',$1,'Pirelli','novo','update',999,0,'varejo',now()-interval '1 hour')`,[measure]);
  },180_000);
  afterAll(async()=>{if(db)await stopPostgres(db);process.env.MATRIZ_CENTRAL_LEDGER='false';});
  it('desconta reservas, mantém mínimo agregado e considera marca nova em trânsito',async()=>{
    const report=await read(query.parse({measure,exact:'true',condition:'novo'}),'test',db.pool);
    expect(report.groups).toHaveLength(1);expect(report.groups[0]).toMatchObject({physical:5,reserved:1,available:4,incoming:8,minimum:20,suggested:8,sold:24,coverage_days:5});
    expect(report.groups[0]?.brands.find(row=>row.brand==='Technic')).toMatchObject({has_stock:false,incoming:8,available:0});
    expect(report.groups[0]?.brands.find(row=>row.brand==='Levorin')).toMatchObject({has_stock:false,sold:2});
  });
  it('muda somente a base do giro e movimentos, preservando o saldo atual e isolando condições',async()=>{
    for(const [days,sold] of [['30',24],['60',34],['90',44]] as const){
      const report=await read(query.parse({days,measure,condition:'novo'}),'test',db.pool);
      expect(report.groups[0]).toMatchObject({sold,available:4,incoming:8,suggested:8});
    }
    const used=await read(query.parse({measure,condition:'meia_vida'}),'test',db.pool);
    expect(used.summary).toMatchObject({available:50,incoming:0,sold:0,replenish:0});
    const onlyPolicy=await read(query.parse({measure:policyOnly}),'test',db.pool);
    expect(onlyPolicy.groups[0]).toMatchObject({minimum:12,available:0,suggested:12});
  });
  it('filtros da trilha não mudam o giro, ambiente prod fica isolado e consulta não altera o banco',async()=>{
    const count=()=>db.pool.query<{n:string}>(`SELECT count(*)::text n FROM commerce.wholesale_stock_movements`);
    const before=await count();
    const report=await read(query.parse({measure,condition:'novo',view:'movements',source:'return'}),'test',db.pool);
    expect(report.summary.sold).toBe(24);expect(report.movements.total).toBe(1);expect(report.movements.rows[0]?.delta).toBe(2);
    const isolated=await read(query.parse({measure,condition:'novo'}),'prod',db.pool);expect(isolated.summary.available).toBe(999);
    expect((await count()).rows).toEqual(before.rows);
  });
});
