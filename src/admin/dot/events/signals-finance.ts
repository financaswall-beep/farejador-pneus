import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import { businessDateSaoPaulo } from '../../../shared/business-time.js';
import { getMatrizLedgerOpenItems } from '../../painel/matriz-ledger-open-items.js';
import { getMatrizLedgerIntegrationHealth } from '../../painel/matriz-ledger-integration-health.js';
import type { DotSettings } from './settings.js';
import { signal,bounded } from './signal-model.js';

export async function financeSignals(db:Pool,settings:DotSettings,now:Date) {
 if(!env.MATRIZ_CENTRAL_LEDGER)throw Error('central_ledger_disabled');
 const [open,health]=await Promise.all([getMatrizLedgerOpenItems(env.FAREJADOR_ENV,db),getMatrizLedgerIntegrationHealth(env.FAREJADOR_ENV,db)]);
 const today=businessDateSaoPaulo(now),limit=businessDateSaoPaulo(new Date(now.getTime()+settings.due_days*86400000));
 const rows=[...open.a_pagar.itens.map(row=>({...row,direction:'payable'})),...open.a_receber.itens.map(row=>({...row,direction:'receivable'}))];
 const result=bounded(rows.filter(row=>row.due_date&&row.due_date<=limit&&Number(row.valor)>0)).map(row=>signal(
  'farejador.financeiro.atencao',`${row.direction}:${row.obligation_id??row.id}:${row.account_code}`,
  row.due_date!<today?'conta_vencida':'vencimento_proximo','finance.matriz_ledger_transactions + finance.matriz_ledger_payments',
  {obligation_id:row.obligation_id??row.id,direction:row.direction,due_date:row.due_date,balance_brl:row.valor,
   currency:'BRL',reconciliation_status:health.status},now,[row.valor,row.due_date,row.due_date!<today]));
 if(health.global.total_error_signals>0)result.push(signal('farejador.financeiro.atencao','reconciliation',
  'conciliacao_requer_conferencia','finance.matriz_ledger_transactions',
  {...health.global,modules:health.modules,interpretation:'Sinais de conferência; duplicidade de origem não prova cobrança duplicada.'},now));
 return result;
}
