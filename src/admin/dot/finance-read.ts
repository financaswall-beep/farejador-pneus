import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { businessDateSaoPaulo } from '../../shared/business-time.js';
import { getMatrizFinancialRead, MatrizCentralLedgerUnavailableError } from '../painel/queries-financeiro-read-switch.js';
import { getMatrizLedgerOpenItems } from '../painel/matriz-ledger-open-items.js';

export async function readDotFinance(db: Pool, month: string) {
  try {
    const read = await getMatrizFinancialRead(env.FAREJADOR_ENV,db,month);
    const open = await getMatrizLedgerOpenItems(env.FAREJADOR_ENV,db);
    const truth = read.truth, today = businessDateSaoPaulo(new Date());
    const agenda = (items: {valor:string;due_date:string|null;overdue:boolean}[]) => ({
      total_brl:(items.reduce((n,item)=>n+Math.round(Number(item.valor)*100),0)/100).toFixed(2),
      count:items.length,overdue_count:items.filter(item=>item.overdue).length,
      due_today_count:items.filter(item=>item.due_date===today).length,
      due_today_brl:(items.filter(item=>item.due_date===today).reduce((n,item)=>n+Math.round(Number(item.valor)*100),0)/100).toFixed(2),
      without_due_date_count:items.filter(item=>!item.due_date).length,
    });
    // Never project names, phones, free descriptions or bank/account details.
    return {available:true,month,source:read.source,integration_status:read.integration_status,
      competence:{revenue_brl:truth.competencia.receita_total,known_cost_brl:truth.competencia.custo_conhecido,
        pending_cost_revenue_brl:truth.competencia.receita_custo_pendente,expenses_brl:truth.competencia.despesas,
        confirmed_profit_brl:truth.competencia.lucro_confirmado,status:truth.competencia.status},
      cash:{opening_brl:truth.caixa.saldo_anterior,receipts_brl:truth.caixa.entradas_registradas,
        payments_brl:truth.caixa.saidas_registradas,net_brl:truth.caixa.movimento_liquido,
        closing_brl:truth.caixa.saldo_atual,pending_receipts_brl:truth.caixa.recebimento_pendente},
      position_as_of:today,receivable:agenda(open.a_receber.itens),payable:agenda(open.a_pagar.itens),
      reconciliation:{status:truth.conciliacao.status,difference_brl:truth.conciliacao.diferenca_total,
        pending_cost_items:truth.conciliacao.custo_pendente.itens,
        suspected_test_records:truth.conciliacao.qualidade.registros_teste_suspeitos},
      warning:'Vendas, recebimentos e lucro são conceitos distintos. Respeite o status de conciliação e o custo pendente.'};
  } catch(error) {
    if (error instanceof MatrizCentralLedgerUnavailableError) return {available:false,reason:error.message,
      warning:'Financeiro indisponível ou não conciliado. Não interprete como saldo zero.'};
    throw error;
  }
}
