import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { MatrizFinancialTruth } from './queries-financeiro-verdade.js';
import { MATRIZ_LEDGER_FINANCIAL_SQL } from './matriz-ledger-financial-read.sql.js';
import type { LedgerTruthRow } from './matriz-ledger-financial-read.types.js';
const cents = (value: string | number): number => Math.round(Number(value || 0) * 100); const money = (value: number): string => (value / 100).toFixed(2);
export async function getMatrizCentralLedgerFinancialTruth(environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool, selectedMonth?: string): Promise<MatrizFinancialTruth> {
  const result = await dbPool.query<LedgerTruthRow>(
    MATRIZ_LEDGER_FINANCIAL_SQL,
    [environment, env.MARKETING_SCOPE_ENFORCEMENT_ENABLED, selectedMonth ?? null],
  );
  const row = result.rows[0]!;
  const originPairs: Array<[MatrizFinancialTruth['conciliacao']['origens'][number]['origem'], number, number]> = [
    ['atacado', cents(row.source_wholesale), cents(row.ledger_wholesale)],
    ['varejo', cents(row.source_retail), cents(row.ledger_retail)],
    ['frete', cents(row.source_freight), cents(row.source_freight)],
    ['comissao', cents(row.source_commission), cents(row.ledger_commission)],
    ['mensalidades', cents(row.source_monthly), cents(row.ledger_monthly)],
    ['despesas', cents(row.source_expenses), cents(row.ledger_expenses)],
    ['marketing', cents(row.source_marketing), cents(row.ledger_marketing)],
    ['compras', cents(row.source_purchases), cents(row.ledger_purchases)],
    ['estoque', cents(row.source_inventory), cents(row.ledger_inventory)],
  ];
  const origins = originPairs.map(([origem, source, accounted]) => ({
    origem, origem_total: money(source), contabilizado: money(accounted),
    diferenca: money(source - accounted),
  }));
  const difference = origins.reduce((sum, origin) =>
    sum + Math.abs(cents(origin.diferenca)), 0);
  const revenue = cents(row.revenue); const cost = cents(row.known_cost);
  const expenses = cents(row.operating_expenses);
  const gain = cents(row.inventory_gain); const loss = cents(row.inventory_loss);
  const pending = cents(row.pending_revenue);
  const competenceStatus = difference > 0 ? 'divergente'
    : pending > 0 ? 'custo_pendente' : 'confirmado';
  const cashIn = cents(row.cash_in); const cashOut = cents(row.cash_out);
  const cashOpening = cents(row.cash_opening);
  return {
    competencia: {
      receita_total: money(revenue),
      receita_custo_conhecido: money(Math.max(0, revenue - pending)),
      receita_custo_pendente: money(pending),
      custo_conhecido: money(cost),
      despesas: money(expenses + loss),
      ajustes_estoque: {
        ganhos: money(gain), perdas: money(loss), efeito_liquido: money(gain - loss),
      },
      lucro_confirmado: money(revenue - pending - cost - expenses - loss + gain),
      status: competenceStatus,
    },
    caixa: {
      saldo_anterior: money(cashOpening),
      entradas_registradas: money(cashIn), saidas_registradas: money(cashOut),
      movimento_liquido: money(cashIn - cashOut),
      saldo_atual: money(cashOpening + cashIn - cashOut),
      recebimento_pendente: money(Math.max(0, cents(row.retail_receivable))),
      recebimentos: {
        varejo: money(cents(row.cash_retail)),
        atacado: money(cents(row.cash_wholesale)),
        comissao: money(cents(row.cash_network)),
        mensalidades: money(cents(row.cash_monthly)),
      },
      pagamentos: {
        compras: money(cents(row.cash_purchases)),
        despesas: money(cents(row.cash_expenses)),
        devolucoes_comissao: money(cents(row.cash_commission_refund)),
      },
    },
    posicao: {
      a_receber: money(Math.max(0, cents(row.receivables))),
      a_pagar: money(Math.max(0, cents(row.payables))),
      varejo_a_receber_sem_baixa: money(Math.max(0, cents(row.retail_receivable))),
    },
    conciliacao: {
      status: difference > 0 ? 'divergente' : pending > 0 ? 'custo_pendente' : 'ok',
      diferenca_total: money(difference), origens: origins,
      custo_pendente: {
        receita: money(pending), itens: row.pending_items, pedidos: row.pending_orders,
      },
      cancelamentos: {
        varejo: row.cancelled_retail, atacado: row.cancelled_wholesale,
        compras: row.cancelled_purchases, comissoes: row.reversed_commissions,
        despesas: row.deleted_expenses,
      },
      qualidade: {
        datas_caixa_inferidas: 0,
        comissoes_estornadas_apos_quitacao: row.reversed_after_settlement,
        registros_teste_suspeitos: row.suspected_test_rows,
      },
    },
  };
}
