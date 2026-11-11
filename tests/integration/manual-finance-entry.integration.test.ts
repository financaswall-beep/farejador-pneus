import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
describe('entradas sem venda — livro central real',()=>{
  let db:IntegrationDb,service:typeof import('../../src/admin/painel/manual-finance-entry.js');
  let truth:typeof import('../../src/admin/painel/matriz-ledger-financial-read.js').getMatrizCentralLedgerFinancialTruth;
  let statement:typeof import('../../src/admin/painel/matriz-ledger-statement.js').getMatrizLedgerStatement;
  let read:typeof import('../../src/admin/painel/financial-report-data.js').readFinancialSnapshot;
  let build:typeof import('../../src/admin/painel/queries-financial-report.js').buildFinancialReport;
  let filter:typeof import('../../src/admin/painel/financial-report-filter.js').financialReportQuery;
  const input=(patch:object={})=>({kind:'income' as const,category:'servicos' as const,amount:100,
    occurred_at:'2026-09-02T12:00:00-03:00',description:'Serviço avulso recebido',payment_method:'pix' as const,
    cash_account:'Caixa principal',idempotency_key:randomUUID(),...patch});
  beforeAll(async()=>{
    db=await startPostgres();Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin',MATRIZ_CENTRAL_LEDGER:'true',MATRIZ_CENTRAL_LEDGER_READ:'true'});
    vi.resetModules();service=await import('../../src/admin/painel/manual-finance-entry.js');
    ({getMatrizCentralLedgerFinancialTruth:truth}=await import('../../src/admin/painel/matriz-ledger-financial-read.js'));
    ({getMatrizLedgerStatement:statement}=await import('../../src/admin/painel/matriz-ledger-statement.js'));
    ({readFinancialSnapshot:read}=await import('../../src/admin/painel/financial-report-data.js'));
    ({buildFinancialReport:build}=await import('../../src/admin/painel/queries-financial-report.js'));
    ({financialReportQuery:filter}=await import('../../src/admin/painel/financial-report-filter.js'));
  });
  afterAll(async()=>{if(db)await stopPostgres(db);});
  it('receita aumenta caixa e resultado sem criar venda, cliente ou movimento de estoque',async()=>{
    const before=await truth('test',db.pool,'2026-09');
    const {id}=await service.createManualFinanceEntry(input(),'owner:test','test',db.pool);
    const after=await truth('test',db.pool,'2026-09');
    expect(Number(after.caixa.saldo_atual)-Number(before.caixa.saldo_atual)).toBe(100);
    expect(Number(after.competencia.receita_total)-Number(before.competencia.receita_total)).toBe(100);
    expect(Number(after.competencia.lucro_confirmado)-Number(before.competencia.lucro_confirmado)).toBe(100);
    const counts=(await db.pool.query(`SELECT (SELECT count(*)::int FROM commerce.orders) orders,
      (SELECT count(*)::int FROM commerce.customers) customers,(SELECT count(*)::int FROM commerce.wholesale_orders) wholesale,
      (SELECT count(*)::int FROM commerce.wholesale_stock_movements) movements`)).rows[0];
    expect(counts).toEqual({orders:0,customers:0,wholesale:0,movements:0});
    const entry=(await statement({period:'2026-09',basis:'caixa',environment:'test'},db.pool)).rows.find(r=>r.id===id)!;
    expect(entry).toMatchObject({origin:'Entrada avulsa / aporte',direction:'entrada',created_by:'owner:test',metadata:{category:'servicos'}});
    expect(entry.entries.find(e=>e.account_code==='other_revenue')).toMatchObject({side:'credit',account_class:'revenue'});
    await expect(db.pool.query('DELETE FROM finance.matriz_ledger_transactions WHERE id=$1',[id])).rejects.toThrow('immutable');
  });
  it('aporte aumenta caixa sem alterar receita, despesas ou lucro',async()=>{
    const before=await truth('test',db.pool,'2026-09');
    const {id}=await service.createManualFinanceEntry(input({kind:'owner_contribution',amount:500}),'owner:test','test',db.pool);
    const after=await truth('test',db.pool,'2026-09');
    expect(Number(after.caixa.saldo_atual)-Number(before.caixa.saldo_atual)).toBe(500);expect(after.competencia).toEqual(before.competencia);
    expect((await db.pool.query(`SELECT metadata FROM finance.matriz_ledger_transactions WHERE id=$1`,[id])).rows[0].metadata)
      .toMatchObject({entry_kind:'owner_contribution',category:'aporte'});
  });
  it('reenvio e cliques concorrentes não duplicam e mudança de valor é recusada',async()=>{
    const data=input({amount:75}),results=await Promise.all(Array.from({length:3},()=>service.createManualFinanceEntry(data,'owner:test','test',db.pool)));
    expect(new Set(results.map(r=>r.id)).size).toBe(1);
    await expect(service.createManualFinanceEntry({...data,amount:76},'owner:test','test',db.pool)).rejects.toThrow('idempotency_conflict');
    expect((await db.pool.query(`SELECT count(*)::int n FROM finance.matriz_ledger_transactions
      WHERE environment='test' AND source_type='finance.manual_entry' AND source_id=$1`,[data.idempotency_key])).rows[0].n).toBe(1);
  });
  it('estorno corrige caixa e receita e não altera o original',async()=>{
    const before=await truth('test',db.pool,'2026-09'),entry=await service.createManualFinanceEntry(input({amount:25}),'owner:test','test',db.pool);
    const correction={reason:'Lançamento duplicado',occurred_at:'2026-09-03T12:00:00-03:00',idempotency_key:randomUUID()};
    const reversed=await service.reverseManualFinanceEntry(entry.id,correction,'owner:test','test',db.pool);
    expect(await service.reverseManualFinanceEntry(entry.id,correction,'owner:test','test',db.pool)).toEqual(reversed);
    const after=await truth('test',db.pool,'2026-09');expect(after.caixa.saldo_atual).toBe(before.caixa.saldo_atual);expect(after.competencia).toEqual(before.competencia);
    const rows=(await statement({period:'2026-09',environment:'test'},db.pool)).rows;
    expect(rows.find(r=>r.id===entry.id)?.status).toBe('estornado');expect(rows.find(r=>r.id===reversed.id)?.status).toBe('estorno');
    await expect(service.reverseManualFinanceEntry(entry.id,{...correction,idempotency_key:randomUUID()},'owner:test','test',db.pool)).rejects.toThrow('already_reversed');
  });
  it('respeita ambiente, tipo de lançamento e data anterior ao recebimento',async()=>{
    const data=input({amount:20}),entry=await service.createManualFinanceEntry(data,'owner:test','test',db.pool);
    const correction={reason:'Correção',occurred_at:'2026-09-01T12:00:00-03:00',idempotency_key:randomUUID()};
    await expect(service.reverseManualFinanceEntry(entry.id,correction,'owner:test','test',db.pool)).rejects.toThrow('not_found_or_date_invalid');
    await expect(service.reverseManualFinanceEntry(entry.id,{...correction,occurred_at:data.occurred_at},'owner:test','prod',db.pool)).rejects.toThrow('not_found_or_date_invalid');
    const {createOwnerWithdrawal}=await import('../../src/admin/painel/matriz-owner-withdrawal.js');
    const withdrawal=await createOwnerWithdrawal({amount:10,occurred_at:data.occurred_at,reason:'Uso pessoal',payment_method:'pix',cash_account:'Caixa',idempotency_key:randomUUID()},'owner:test','test',db.pool);
    await expect(service.reverseManualFinanceEntry(withdrawal.id,{...correction,occurred_at:data.occurred_at},'owner:test','test',db.pool)).rejects.toThrow('not_found');
    expect((await truth('prod',db.pool,'2026-09')).caixa.entradas_registradas).toBe('0.00');
  });
  it('relatório, extrato e verdade financeira usam os mesmos totais',async()=>{
    const f=filter.parse({from:'2026-09-01',to:'2026-09-30'}),report=build(await read(f,'test',db.pool),f);
    const expected=await truth('test',db.pool,'2026-09');
    expect(report.summary.revenue).toBe(Number(expected.competencia.receita_total));
    expect(report.summary.result).toBe(Number(expected.competencia.lucro_confirmado));
    expect(report.summary.incoming).toBe(Number(expected.caixa.entradas_registradas));
    expect(report.cash_rows.some(r=>r.source_type==='finance.manual_entry')).toBe(true);
  });
  it('estorno de aporte não gera despesa nem altera o resultado',async()=>{
    const before=await truth('test',db.pool,'2026-09');
    const entry=await service.createManualFinanceEntry(input({kind:'owner_contribution',amount:80}),'owner:test','test',db.pool);
    await service.reverseManualFinanceEntry(entry.id,{reason:'Aporte duplicado',occurred_at:'2026-09-04T12:00:00-03:00',idempotency_key:randomUUID()},'owner:test','test',db.pool);
    const after=await truth('test',db.pool,'2026-09');expect(after.competencia).toEqual(before.competencia);
    expect(after.caixa.saldo_atual).toBe(before.caixa.saldo_atual);
  });
  it('estorno posterior preserva a receita do mês original e corrige o mês do estorno',async()=>{
    const before=await truth('test',db.pool,'2026-09');
    const entry=await service.createManualFinanceEntry(input({amount:40,occurred_at:'2026-09-30T12:00:00-03:00'}),'owner:test','test',db.pool);
    await service.reverseManualFinanceEntry(entry.id,{reason:'Valor lançado incorretamente',occurred_at:'2026-10-01T12:00:00-03:00',idempotency_key:randomUUID()},'owner:test','test',db.pool);
    const september=await truth('test',db.pool,'2026-09'),october=await truth('test',db.pool,'2026-10');
    expect(Number(september.competencia.receita_total)-Number(before.competencia.receita_total)).toBe(40);
    expect(october.competencia.receita_total).toBe('-40.00');expect(october.caixa.saidas_registradas).toBe('40.00');
  });
});
