import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { getMatrizLedgerOpenItems } from '../painel/matriz-ledger-open-items.js';
import { readDotFinance } from './finance-read.js';
import { pageRows,project } from './read-model.js';

export async function readDotFinanceDetails(db:Pool,month:string,view:'resumo'|'a_receber'|'a_pagar',page:number) {
  const finance=await readDotFinance(db,month);
  if(view==='resumo'||!finance.available)return finance;
  const open=await getMatrizLedgerOpenItems(env.FAREJADOR_ENV,db);
  const source=view==='a_receber'?open.a_receber.itens:open.a_pagar.itens;
  const rows=source.filter(row=>row.tipo!=='folha'&&row.categoria!=='funcionario')
    .map(row=>project(row,['id','tipo','valor','due_date','overdue','count']))
    .sort((a,b)=>String(a.due_date??'9999').localeCompare(String(b.due_date??'9999'))||String(a.id).localeCompare(String(b.id)));
  return {available:true,month,view,position_as_of:finance.position_as_of,source:finance.source,
    monetary_unit:'BRL',reconciliation:finance.reconciliation,...pageRows(rows,page),
    warning:'Posição atual das contas em aberto, incluindo parcelas e saldos após pagamentos parciais. Sem nomes, contatos, dados bancários ou valores individuais da folha. Os totais consolidados ficam na visão resumo.'};
}
