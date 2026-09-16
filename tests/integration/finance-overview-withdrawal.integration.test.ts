import {beforeAll,afterAll,describe,expect,it,vi} from 'vitest';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
describe('visão financeira e retiradas no livro real',()=>{
  let db:IntegrationDb,read:typeof import('../../src/admin/painel/matriz-finance-overview.js').getMatrizFinanceOverview;
  let withdraw:typeof import('../../src/admin/painel/matriz-owner-withdrawal.js');
  let truth:typeof import('../../src/admin/painel/matriz-ledger-financial-read.js').getMatrizCentralLedgerFinancialTruth;
  let statement:typeof import('../../src/admin/painel/matriz-ledger-statement.js').getMatrizLedgerStatement;
  let saleId:string;
  const input={amount:100,occurred_at:'2026-09-02T15:00:00Z',reason:'Uso pessoal',payment_method:'dinheiro',cash_account:'Caixa principal',idempotency_key:'owner-withdrawal-01'};
  beforeAll(async()=>{
    Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-token',MATRIZ_CENTRAL_LEDGER:'true',MATRIZ_CENTRAL_LEDGER_READ:'true'});
    vi.resetModules();db=await startPostgres();
    ({getMatrizFinanceOverview:read}=await import('../../src/admin/painel/matriz-finance-overview.js'));
    withdraw=await import('../../src/admin/painel/matriz-owner-withdrawal.js');
    ({getMatrizCentralLedgerFinancialTruth:truth}=await import('../../src/admin/painel/matriz-ledger-financial-read.js'));
    ({getMatrizLedgerStatement:statement}=await import('../../src/admin/painel/matriz-ledger-statement.js'));
    async function post(key:string,amount:number,debit:string,dc:string,credit:string,cc:string,date:string,cash:string|null=date,environment='test'){
      return (await db.pool.query(`SELECT finance.post_matriz_ledger_transaction($1::env_t,'finance.overview.test',$2,'recognition',$3,$4::date,$2,'owner:test',$5::jsonb,NULL,$6::date,'{}') id`,[environment,key,amount,date,JSON.stringify([{account_code:debit,account_class:dc,side:'debit',amount},{account_code:credit,account_class:cc,side:'credit',amount}]),cash])).rows[0]!.id;
    }
    await post('opening',1000,'cash','asset','opening_equity','equity','2026-08-31');
    saleId=await post('sale',200,'cash','asset','sales_revenue','revenue','2026-09-01');
    await post('cost',80,'cost_of_goods_sold','expense','inventory','asset','2026-09-01',null);
    await post('expense',30,'expense_aluguel','expense','cash','asset','2026-09-01');
    await post('prod-only',9000,'cash','asset','sales_revenue','revenue','2026-09-01','2026-09-01','prod');
    for(let i=0;i<205;i++)await post('cent-'+i,.01,'cash','asset','owner_equity','equity','2026-09-01');
  },180000);
  afterAll(async()=>{if(db)await stopPostgres(db);vi.resetModules();});
  it('agrega mais de 200 lançamentos e preserva saldo anterior e ambiente',async()=>{
    const data=await read('2026-09','test',db.pool);
    expect(Number(data.opening)).toBe(1000);expect(Number(data.days[0]!.incoming)).toBe(202.05);expect(Number(data.days[0]!.outgoing)).toBe(30);
    expect(data.expenses).toEqual([{account:'expense_aluguel',label:'Aluguel/galpão',amount:'30.00'}]);
    const counts=await db.pool.query('SELECT count(*)::int count FROM finance.matriz_ledger_transactions');
    const prod=await read('2026-09','prod',db.pool);expect(Number(prod.days[0]!.incoming)).toBe(9000);
    expect((await db.pool.query('SELECT count(*)::int count FROM finance.matriz_ledger_transactions')).rows).toEqual(counts.rows);
  });
  it('reduz somente caixa, protege repetição e permite estorno auditável',async()=>{
    const before=await truth('test',db.pool,'2026-09');
    const first=await withdraw.createOwnerWithdrawal(input,'owner:test','test',db.pool);
    expect(await withdraw.createOwnerWithdrawal(input,'owner:test','test',db.pool)).toEqual(first);
    await expect(withdraw.createOwnerWithdrawal({...input,amount:110},'owner:test','test',db.pool)).rejects.toThrow('idempotency_conflict');
    const after=await truth('test',db.pool,'2026-09');expect(after.competencia).toEqual(before.competencia);
    expect(Number(after.caixa.saldo_atual)).toBeCloseTo(Number(before.caixa.saldo_atual)-100,2);
    const rows=await statement({period:'2026-09',basis:'caixa',environment:'test'},db.pool);
    expect(rows.rows.find(r=>r.id===first.id)).toMatchObject({origin:'Retirada do dono',direction:'saida'});
    const correction={reason:'Registro por engano',occurred_at:'2026-09-03T15:00:00Z',idempotency_key:'withdrawal-reversal-01'};
    await expect(withdraw.reverseOwnerWithdrawal(saleId,correction,'owner:test','test',db.pool)).rejects.toThrow('withdrawal_not_found');
    await expect(withdraw.reverseOwnerWithdrawal(first.id,correction,'owner:test','prod',db.pool)).rejects.toThrow('withdrawal_not_found');
    const reversal=await withdraw.reverseOwnerWithdrawal(first.id,correction,'owner:test','test',db.pool);
    expect(await withdraw.reverseOwnerWithdrawal(first.id,correction,'owner:test','test',db.pool)).toEqual(reversal);
    const final=await truth('test',db.pool,'2026-09');expect(final.caixa.saldo_atual).toBe(before.caixa.saldo_atual);expect(final.competencia).toEqual(before.competencia);
    expect((await statement({period:'2026-09',basis:'caixa',environment:'test'},db.pool)).rows.find(r=>r.id===first.id)?.reversed).toBe(true);
    await expect(db.pool.query('UPDATE finance.matriz_ledger_transactions SET amount=1 WHERE id=$1',[first.id])).rejects.toThrow();
  });
});
