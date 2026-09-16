import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { businessDateSaoPaulo } from '../../shared/business-time.js';
import { getMatrizCentralLedgerFinancialTruth } from './matriz-ledger-financial-read.js';
import { getMatrizLedgerOpenItems } from './matriz-ledger-open-items.js';
import { readOverviewSales, readOverviewBotCost } from './matriz-overview-sales.js';
import { readOverviewAttention, readOverviewLeads } from './matriz-overview-operations.js';
import { reportAddDays } from './report-period.js';

export function overviewPeriod(period:'today'|'7d'|'month',month:string,now=new Date()) {
  const today=businessDateSaoPaulo(now);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<'2000-01'||month>today.slice(0,7)) throw new Error('invalid_month');
  const last=new Date(`${month}-01T12:00:00Z`);last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);
  const to=period==='month' ? [last.toISOString().slice(0,10),today].sort()[0]! : today;
  return {from:period==='today'?today:period==='7d'?reportAddDays(today,-6):`${month}-01`,to,
    month:period==='month'?month:today.slice(0,7),today};
}

async function readFinance(db:Pool,environment:'prod'|'test',month:string,today:string) {
  if(!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) return null;
  const [truth,open,cash]=await Promise.all([
    getMatrizCentralLedgerFinancialTruth(environment,db,month),getMatrizLedgerOpenItems(environment,db),
    db.query(`SELECT COALESCE(sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END),0)::text balance
      FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e
        ON e.transaction_id=t.id AND e.environment=t.environment
      WHERE t.environment=$1 AND e.account_code='cash' AND t.cash_on<=$2::date`,[environment,today]),
  ]);
  const cents=(n:string)=>Math.round(Number(n)*100);
  const sum=(items:{valor:string}[])=>items.reduce((total,item)=>total+cents(item.valor),0);
  return {month,result_cents:cents(truth.competencia.lucro_confirmado),status:truth.competencia.status,
    revenue_cents:cents(truth.competencia.receita_total),cash_cents:cents(cash.rows[0].balance),
    receivable_today_cents:sum(open.a_receber.itens.filter(item=>item.due_date===today)),
    payable_today_cents:sum(open.a_pagar.itens.filter(item=>item.due_date===today)),
    network_cents:sum(open.a_receber.itens.filter(item=>['comissao','mensalidade'].includes(item.tipo))),
    overdue:open.a_receber.vencidos_count+open.a_pagar.vencidos_count};
}

export async function getMatrizOverview(period:ReturnType<typeof overviewPeriod>,financeAllowed:boolean,
  db:Pool=pool,environment:'prod'|'test'=env.FAREJADOR_ENV) {
  const [sales,bot,attention,leads,finance]=await Promise.all([
    readOverviewSales(db,environment,period.from,period.to),
    readOverviewBotCost(db,environment,period.from,period.to),
    readOverviewAttention(db,environment),readOverviewLeads(db,environment),
    financeAllowed?readFinance(db,environment,period.month,period.today):Promise.resolve(null),
  ]);
  return {period,sales,bot,attention,leads,finance,updated_at:new Date().toISOString()};
}
