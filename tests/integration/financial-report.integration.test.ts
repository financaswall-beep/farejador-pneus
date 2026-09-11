import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
describe('Relatório financeiro — livro central real e somente leitura',()=>{
  let db:IntegrationDb,read:typeof import('../../src/admin/painel/financial-report-data.js').readFinancialSnapshot;
  let build:typeof import('../../src/admin/painel/queries-financial-report.js').buildFinancialReport;
  let query:typeof import('../../src/admin/painel/financial-report-filter.js').financialReportQuery;
  let truth:typeof import('../../src/admin/painel/matriz-ledger-financial-read.js').getMatrizCentralLedgerFinancialTruth;
  beforeAll(async()=>{
    Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-token',MATRIZ_CENTRAL_LEDGER:'true',MATRIZ_CENTRAL_LEDGER_READ:'true'});
    vi.resetModules();db=await startPostgres();
    ({readFinancialSnapshot:read}=await import('../../src/admin/painel/financial-report-data.js'));({buildFinancialReport:build}=await import('../../src/admin/painel/queries-financial-report.js'));
    ({financialReportQuery:query}=await import('../../src/admin/painel/financial-report-filter.js'));({getMatrizCentralLedgerFinancialTruth:truth}=await import('../../src/admin/painel/matriz-ledger-financial-read.js'));
    const post=async(source:string,amount:number,debit:string,debitClass:string,credit:string,creditClass:string,date:string,cash:string|null=null,environment='test',due:string|null=null)=>{
      const r=await db.pool.query(`SELECT finance.post_matriz_ledger_transaction($1::env_t,$2,$3,CASE WHEN $9::date IS NULL THEN 'recognition' ELSE 'payment' END,$4,$5::date,$6,'owner:integration',$7::jsonb,$8::date,$9::date,$10::jsonb) id`,
        [environment,'finance.report.'+source,source,amount,date,'Lançamento '+source,JSON.stringify([{account_code:debit,account_class:debitClass,side:'debit',amount},{account_code:credit,account_class:creditClass,side:'credit',amount}]),due,cash,JSON.stringify({payment_method:cash?'pix':null,cash_account:cash?'Conta informada':null})]);return r.rows[0]!.id;};
    await post('opening',100,'cash','asset','opening_equity','equity','2026-08-31','2026-08-31');
    const sale=await post('sale',200,'accounts_receivable','asset','sales_revenue','revenue','2026-09-02',null,'test','2026-09-20');
    await post('cost',80,'cost_of_goods_sold','expense','inventory','asset','2026-09-02');
    const payment=await post('payment',100,'cash','asset','accounts_receivable','asset','2026-09-05','2026-09-05');
    await db.pool.query("SELECT finance.record_matriz_ledger_payment('test',$1,$2,'2026-09-05T12:00:00Z','owner:integration',NULL)",[sale,payment]);
    const expense=await post('expense',30,'expense_aluguel','expense','accounts_payable','liability','2026-09-03',null,'test','2026-09-09');
    const expensePayment=await post('expense_payment',30,'accounts_payable','liability','cash','asset','2026-09-06','2026-09-06');
    await db.pool.query("SELECT finance.record_matriz_ledger_payment('test',$1,$2,'2026-09-06T12:00:00Z','owner:integration',NULL)",[expense,expensePayment]);
    await post('gain',10,'inventory','asset','inventory_gain','revenue','2026-09-04');
    await post('loss',5,'inventory_internal_use','expense','inventory','asset','2026-09-04');
    await post('sale',900,'accounts_receivable','asset','sales_revenue','revenue','2026-09-02',null,'prod','2026-09-20');
  },180000);
  afterAll(async()=>{if(db)await stopPostgres(db);vi.resetModules();});
  it('relatório coincide com a verdade mensal e separa datas de competência/caixa',async()=>{
    const f=query.parse({from:'2026-09-01',to:'2026-09-10'}),data=await read(f,'test',db.pool),r=build(data,f),monthly=await truth('test',db.pool,'2026-09');
    expect(r.summary).toMatchObject({revenue:200,cost:80,expense:30,result:95,opening:100,incoming:100,outgoing:30,closing:170});
    expect(r.summary.result).toBe(Number(monthly.competencia.lucro_confirmado));expect(r.summary.closing).toBe(Number(monthly.caixa.saldo_atual));
    expect(r.daily.at(-1)?.cumulative).toBe(95);expect(r.cash_rows).toHaveLength(2);expect(r.position.receivable).toBe(100);expect(r.position.payable).toBe(0);
    expect(r.cash_rows.find(row=>row.id===data.movements.find(m=>m.cash_in===100)?.id)?.payment_method).toBe('pix');
    expect(JSON.stringify(r)).not.toMatch(/phone|metadata|cash_account.*note/);
  });
  it('recorte diário preserva saldo anterior e não confunde título atual com venda do período',async()=>{
    const f=query.parse({from:'2026-09-05',to:'2026-09-06'}),r=build(await read(f,'test',db.pool),f);
    expect(r.summary).toMatchObject({revenue:0,result:0,opening:100,incoming:100,outgoing:30,closing:170});expect(r.position.receivable).toBe(100);
  });
  it('isola ambientes, mantém o histórico imutável e não grava durante a consulta',async()=>{
    const counts=()=>db.pool.query("SELECT (SELECT count(*) FROM finance.matriz_ledger_transactions)::int AS transactions,(SELECT count(*) FROM audit.events)::int AS audits");
    const before=(await counts()).rows[0],f=query.parse({from:'2026-09-01',to:'2026-09-10'});
    const prod=build(await read(f,'prod',db.pool),f);expect(prod.summary.revenue).toBe(900);expect(prod.summary.incoming).toBe(0);
    expect((await counts()).rows[0]).toEqual(before);
  });
  it('estorno em outro mês preserva o resultado e o caixa do mês original',async()=>{
    const entries=[{account_code:'cash',account_class:'asset',side:'debit',amount:50},{account_code:'sales_revenue',account_class:'revenue',side:'credit',amount:50}];
    const original=(await db.pool.query(`SELECT finance.post_matriz_ledger_transaction('test','finance.report.refundable','refund-original','sale',50,'2026-08-20','Venda estornada depois','owner:integration',$1::jsonb,NULL,'2026-08-20','{}'::jsonb) id`,[JSON.stringify(entries)])).rows[0]!.id;
    await db.pool.query(`SELECT finance.reverse_matriz_ledger_transaction('test',$1,'finance.report.refund','refund-record','2026-09-05','Estorno no mês seguinte','owner:integration','2026-09-05','{}'::jsonb)`,[original]);
    const august=query.parse({from:'2026-08-01',to:'2026-08-31'}),before=build(await read(august,'test',db.pool),august);
    expect(before.summary).toMatchObject({revenue:50,result:50,incoming:150,outgoing:0,closing:150});
    expect(before.cash_rows.find(row=>row.id===original)?.reversed).toBe(true);
    const september=query.parse({from:'2026-09-01',to:'2026-09-10'}),after=build(await read(september,'test',db.pool),september);
    expect(after.summary).toMatchObject({revenue:150,result:45,opening:150,incoming:100,outgoing:80,closing:170});
    expect(after.cash_rows.find(row=>row.reversal_of===original)?.cash_out).toBe(50);
  });
});
