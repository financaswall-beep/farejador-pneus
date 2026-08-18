import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { MatrizFinancialTruth } from './queries-financeiro-verdade.js';
interface LedgerTruthRow {
  revenue: string; known_cost: string; operating_expenses: string; inventory_gain: string; inventory_loss: string;
  cash_in: string; cash_out: string; cash_retail: string;
  cash_wholesale: string; cash_network: string; cash_monthly: string;
  cash_purchases: string; cash_expenses: string; cash_commission_refund: string;
  pending_revenue: string; pending_items: number; pending_orders: number;
  receivables: string; payables: string; retail_receivable: string;
  cancelled_retail: number; cancelled_wholesale: number; cancelled_purchases: number;
  reversed_commissions: number; deleted_expenses: number;
  reversed_after_settlement: number; suspected_test_rows: number;
  source_wholesale: string; ledger_wholesale: string;
  source_retail: string; ledger_retail: string; source_freight: string;
  source_commission: string; ledger_commission: string;
  source_monthly: string; ledger_monthly: string;
  source_expenses: string; ledger_expenses: string;
  source_marketing: string; ledger_marketing: string;
  source_purchases: string; ledger_purchases: string; source_inventory: string; ledger_inventory: string;
}
const cents = (value: string | number): number => Math.round(Number(value || 0) * 100); const money = (value: number): string => (value / 100).toFixed(2);
export async function getMatrizCentralLedgerFinancialTruth(environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool): Promise<MatrizFinancialTruth> {
  const result = await dbPool.query<LedgerTruthRow>(
     `WITH bounds AS (
       SELECT date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date month_start,
              (date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')
                +interval '1 month')::date month_end,
              (date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')
                AT TIME ZONE 'America/Sao_Paulo') month_ts,
              ((date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')
                +interval '1 month') AT TIME ZONE 'America/Sao_Paulo') month_end_ts
     ), ledger AS (
       SELECT t.id,t.source_type,t.source_id,t.competence_on,t.cash_on,
              e.account_code,e.account_class,e.side,e.amount
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment=$1
     ), month_ledger AS (
       SELECT l.* FROM ledger l,bounds b
        WHERE l.competence_on>=b.month_start AND l.competence_on<b.month_end
     ), cash_month AS (
       SELECT l.* FROM ledger l,bounds b
        WHERE l.cash_on>=b.month_start AND l.cash_on<b.month_end
     ), retail AS (
       SELECT o.id,o.total_amount,o.created_at,o.updated_at,o.status,
              o.fulfillment_mode,o.closed_by,
              COALESCE(sum(i.quantity*i.unit_price-i.discount_amount),0) item_total,
              COALESCE(sum(i.quantity*i.unit_price-i.discount_amount)
                FILTER (WHERE i.matriz_unit_cost IS NULL),0) pending_revenue,
              count(*) FILTER (WHERE i.matriz_unit_cost IS NULL)::int pending_items
         FROM commerce.orders o
         JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id
          AND u.slug='main'
         JOIN commerce.order_items i
           ON i.environment=o.environment AND i.order_id=o.id
        WHERE o.environment=$1 AND o.partner_order_id IS NULL GROUP BY o.id
     )
     SELECT
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='revenue'
           AND account_code<>'inventory_gain'),0) revenue,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_code='cost_of_goods_sold'),0) known_cost,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='expense'
           AND account_code NOT IN (
             'cost_of_goods_sold','inventory_loss','inventory_internal_use')),0)
         operating_expenses,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_code='inventory_gain'),0) inventory_gain,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM month_ledger
        WHERE account_code IN ('inventory_loss','inventory_internal_use')),0) inventory_loss,
       COALESCE((SELECT sum(amount) FROM cash_month
         WHERE account_code='cash' AND side='debit'),0) cash_in,
       COALESCE((SELECT sum(amount) FROM cash_month
         WHERE account_code='cash' AND side='credit'),0) cash_out,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'commerce.order.%'),0) cash_retail,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'commerce.wholesale_order.%'),0) cash_wholesale,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'network.commission_entry.%'),0) cash_network,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'network.monthly_fee.%'),0) cash_monthly,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'commerce.wholesale_purchase.%'),0) cash_purchases,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type LIKE 'commerce.matriz_expense.%'),0) cash_expenses,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM cash_month WHERE account_code='cash'
           AND source_type='network.commission_refund.payment'),0)
         cash_commission_refund,
       COALESCE((SELECT sum(pending_revenue) FROM retail
         WHERE status IN ('confirmed','paid','delivered')),0) pending_revenue,
       COALESCE((SELECT sum(pending_items) FROM retail
         WHERE status IN ('confirmed','paid','delivered')),0)::int pending_items,
       (SELECT count(*)::int FROM retail
         WHERE status IN ('confirmed','paid','delivered') AND pending_items>0) pending_orders,
       COALESCE((SELECT sum(CASE
         WHEN account_class='asset' AND account_code LIKE '%receivable%'
           THEN CASE side WHEN 'debit' THEN amount ELSE -amount END ELSE 0 END)
         FROM ledger),0) receivables,
       COALESCE((SELECT sum(CASE
         WHEN account_class='liability' AND (
           account_code LIKE '%payable%' OR account_code='accounts_payable')
           THEN CASE side WHEN 'credit' THEN amount ELSE -amount END ELSE 0 END)
         FROM ledger),0) payables,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM ledger WHERE account_code='accounts_receivable'
           AND source_type LIKE 'commerce.order.%'),0) retail_receivable,
       (SELECT count(*)::int FROM retail WHERE status='cancelled') cancelled_retail,
       (SELECT count(*)::int FROM commerce.wholesale_orders
         WHERE environment=$1 AND status='cancelled') cancelled_wholesale,
       (SELECT count(*)::int FROM commerce.wholesale_purchases
         WHERE environment=$1 AND status='cancelled') cancelled_purchases,
       (SELECT count(*)::int FROM network.commission_entries
         WHERE environment=$1 AND status='reversed') reversed_commissions,
       (SELECT count(*)::int FROM commerce.matriz_expenses
         WHERE environment=$1 AND deleted_at IS NOT NULL) deleted_expenses,
       (SELECT count(*)::int FROM finance.matriz_commission_reversals
         WHERE environment=$1 AND refund_status='pending') reversed_after_settlement,
       ((SELECT count(*) FROM retail
          WHERE lower(COALESCE(closed_by,''))~'(test|teste|prova|demo)')
        +(SELECT count(*) FROM finance.matriz_ledger_transactions
          WHERE environment=$1
            AND lower(created_by||' '||description)~'(test|teste|prova|demo)'))::int
         suspected_test_rows,
       COALESCE((SELECT sum(COALESCE(o.settled_total_amount,o.total_amount)) FROM commerce.wholesale_orders o,bounds b
         WHERE o.environment=$1 AND o.sold_at>=b.month_ts
           AND o.sold_at<b.month_end_ts
           AND (o.partner_transfer_status IS NULL
             OR o.partner_transfer_status IN ('settled','received'))),0)
       -COALESCE((SELECT sum(COALESCE(o.settled_total_amount,o.total_amount)) FROM commerce.wholesale_orders o,bounds b
         WHERE o.environment=$1 AND o.status='cancelled'
           AND o.cancelled_at>=b.month_ts AND o.cancelled_at<b.month_end_ts),0)
         source_wholesale,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='revenue'
           AND source_type LIKE 'commerce.wholesale_order.%'),0) ledger_wholesale,
       COALESCE((SELECT sum(total_amount) FROM retail,bounds b
         WHERE status IN ('confirmed','paid','delivered','cancelled')
           AND created_at>=b.month_ts AND created_at<b.month_end_ts),0)
       -COALESCE((SELECT sum(total_amount) FROM retail,bounds b
         WHERE status='cancelled' AND updated_at>=b.month_ts
           AND updated_at<b.month_end_ts),0) source_retail,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='revenue'
           AND source_type LIKE 'commerce.order.%'),0) ledger_retail,
       COALESCE((SELECT sum(GREATEST(total_amount-item_total,0))
         FROM retail,bounds b WHERE fulfillment_mode='delivery'
           AND status IN ('confirmed','paid','delivered') AND created_at>=b.month_ts
           AND created_at<b.month_end_ts),0) source_freight,
       COALESCE((SELECT sum(commission_amount) FROM network.commission_entries,bounds b
         WHERE environment=$1 AND realized_at>=b.month_ts
           AND realized_at<b.month_end_ts),0)
       -COALESCE((SELECT sum(amount) FROM finance.matriz_commission_reversals,bounds b
         WHERE environment=$1 AND reversed_at>=b.month_ts
           AND reversed_at<b.month_end_ts),0) source_commission,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='revenue'
           AND source_type LIKE 'network.commission_entry.%'),0) ledger_commission,
       COALESCE((SELECT sum(amount) FROM finance.matriz_partner_monthly_fees,bounds b
         WHERE environment=$1 AND competence>=b.month_start
           AND competence<b.month_end),0) source_monthly,
       COALESCE((SELECT sum(CASE side WHEN 'credit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='revenue'
           AND source_type LIKE 'network.monthly_fee.%'),0) ledger_monthly,
       COALESCE((SELECT sum(amount) FROM commerce.matriz_expenses,bounds b
         WHERE environment=$1
           AND ops.matriz_expense_competence_month(competence_month,occurred_at)
             >=b.month_start
           AND ops.matriz_expense_competence_month(competence_month,occurred_at)
             <b.month_end),0)
       -COALESCE((SELECT sum(amount) FROM commerce.matriz_expenses,bounds b
         WHERE environment=$1 AND deleted_at IS NOT NULL
           AND (deleted_at AT TIME ZONE 'America/Sao_Paulo')::date>=b.month_start
           AND (deleted_at AT TIME ZONE 'America/Sao_Paulo')::date<b.month_end),0)
         source_expenses,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_class='expense'
           AND account_code LIKE 'expense_%'),0) ledger_expenses,
       COALESCE((SELECT sum(CASE WHEN $2::boolean THEN financial_spend ELSE spend END) FROM
         marketing.meta_insights_daily_scoped,bounds b
         WHERE environment=$1 AND entity_level='campaign' AND account_currency='BRL'
           AND metric_date>=b.month_start AND metric_date<b.month_end),0)
         source_marketing,
       COALESCE((SELECT sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
         FROM month_ledger WHERE account_code='marketing_expense'),0) ledger_marketing,
       COALESCE((SELECT sum(total_amount) FROM commerce.wholesale_purchases p,bounds b
         WHERE p.environment=$1 AND p.purchased_at>=b.month_ts
           AND p.purchased_at<b.month_end_ts),0)
       -COALESCE((SELECT sum(total_amount) FROM commerce.wholesale_purchases p,bounds b
         WHERE p.environment=$1 AND p.status='cancelled'
           AND p.cancelled_at>=b.month_ts
           AND p.cancelled_at<b.month_end_ts),0) source_purchases,
       COALESCE((SELECT sum(CASE
         WHEN account_code IN ('inventory','inventory_in_transit')
           THEN CASE side WHEN 'debit' THEN amount ELSE -amount END ELSE 0 END)
         FROM month_ledger WHERE source_type LIKE 'commerce.wholesale_purchase.%'),0)
         ledger_purchases,
       COALESCE((SELECT sum(CASE direction WHEN 'gain' THEN amount ELSE -amount END)
         FROM finance.matriz_inventory_adjustments,bounds b
         WHERE environment=$1 AND occurred_at>=b.month_ts
           AND occurred_at<b.month_end_ts),0) source_inventory,
       COALESCE((SELECT sum(CASE
         WHEN account_code='inventory_gain'
           THEN CASE side WHEN 'credit' THEN amount ELSE -amount END
         WHEN account_code IN ('inventory_loss','inventory_internal_use')
           THEN CASE side WHEN 'credit' THEN amount ELSE -amount END
         ELSE 0 END) FROM month_ledger),0) ledger_inventory`,
    [environment, env.MARKETING_SCOPE_ENFORCEMENT_ENABLED],
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
      entradas_registradas: money(cashIn), saidas_registradas: money(cashOut),
      movimento_liquido: money(cashIn - cashOut),
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
