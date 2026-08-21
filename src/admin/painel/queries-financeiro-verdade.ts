import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMatrizFinancialRead } from './queries-financeiro-read-switch.js';

type Origin = 'atacado' | 'varejo' | 'frete' | 'comissao' | 'mensalidades'
  | 'despesas' | 'marketing' | 'compras' | 'estoque';

export interface MatrizFinancialTruth {
  competencia: {
    receita_total: string;
    receita_custo_conhecido: string;
    receita_custo_pendente: string;
    custo_conhecido: string;
    despesas: string;
    ajustes_estoque: { ganhos: string; perdas: string; efeito_liquido: string };
    lucro_confirmado: string;
    status: 'confirmado' | 'custo_pendente' | 'divergente';
  };
  caixa: {
    entradas_registradas: string;
    saidas_registradas: string;
    movimento_liquido: string;
    recebimento_pendente: string;
    recebimentos: {
      varejo: string; atacado: string; comissao: string; mensalidades?: string;
    };
    pagamentos: { compras: string; despesas: string; devolucoes_comissao: string };
  };
  posicao: {
    a_receber: string;
    a_pagar: string;
    varejo_a_receber_sem_baixa: string;
  };
  conciliacao: {
    status: 'ok' | 'custo_pendente' | 'divergente';
    diferenca_total: string;
    origens: Array<{ origem: Origin; origem_total: string; contabilizado: string; diferenca: string }>;
    custo_pendente: { receita: string; itens: number; pedidos: number };
    cancelamentos: { varejo: number; atacado: number; compras: number; comissoes: number; despesas: number };
    qualidade: {
      datas_caixa_inferidas: number;
      comissoes_estornadas_apos_quitacao: number;
      registros_teste_suspeitos: number;
    };
  };
}

interface TruthRow {
  retail_header: string; retail_items: string; retail_known: string; retail_pending: string;
  retail_cost: string; retail_freight: string; pending_all: string; pending_items: number; pending_orders: number;
  wholesale_header: string; wholesale_items: string; wholesale_cost: string;
  commission_revenue: string; commission_reversal: string; expenses_competence: string;
  inventory_gain: string; inventory_loss: string;
  purchases_header: string; purchases_items: string;
  cash_retail: string; cash_wholesale: string; cash_commission: string;
  cash_commission_refund: string;
  cash_purchases: string; cash_expenses: string; retail_payment_pending: string;
  receivable_retail: string; receivable_wholesale: string; receivable_commission: string;
  payable_purchases: string; payable_expenses: string; payable_commission_refund: string;
  cancelled_retail: number; cancelled_wholesale: number; cancelled_purchases: number;
  reversed_commissions: number; deleted_expenses: number; inferred_cash_dates: number;
  reversed_after_settlement: number; suspected_test_rows: number;
}

const cents = (value: string | number): number => Math.round(Number(value || 0) * 100);
const money = (value: number): string => (value / 100).toFixed(2);

/**
 * Régua única da Etapa 4. Uma consulta/snapshot separa competência, caixa e posição.
 * NULL em matriz_unit_cost é estado explícito de custo pendente: a receita aparece,
 * mas a linha não fabrica lucro. Cancelados ficam no contador/trilha e fora das contas.
 */
export async function getLegacyMatrizFinancialTruth(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizFinancialTruth> {
  const result = await dbPool.query<TruthRow>(
     `WITH bounds AS (
       SELECT (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')
               AT TIME ZONE 'America/Sao_Paulo') AS month_start,
              ((date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')
                +interval '1 month') AT TIME ZONE 'America/Sao_Paulo') AS month_end,
              date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date AS month_start_date,
              (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')
                +interval '1 month')::date AS month_end_date
     ), retail AS (
       SELECT o.id,o.created_at,o.total_amount,o.status,o.fulfillment_mode,o.payment_method,
              o.closed_at,o.delivered_at,o.delivery_status,o.closed_by,o.source,
              COALESCE(SUM(oi.quantity*oi.unit_price-oi.discount_amount),0) item_total,
              COALESCE(SUM(oi.quantity*oi.unit_price-oi.discount_amount)
                FILTER (WHERE oi.matriz_unit_cost IS NOT NULL),0) known_revenue,
              COALESCE(SUM(oi.quantity*oi.unit_price-oi.discount_amount)
                FILTER (WHERE oi.matriz_unit_cost IS NULL),0) pending_revenue,
              COALESCE(SUM(oi.quantity*oi.matriz_unit_cost)
                FILTER (WHERE oi.matriz_unit_cost IS NOT NULL),0) known_cost,
              COUNT(*) FILTER (WHERE oi.matriz_unit_cost IS NULL)::int pending_items
         FROM commerce.orders o
         JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
         JOIN commerce.order_items oi ON oi.order_id=o.id AND oi.environment=o.environment
        WHERE o.environment=$1
        GROUP BY o.id
     ), wholesale AS (
       SELECT o.id,o.created_at,COALESCE(o.settled_total_amount,o.total_amount) total_amount,
              o.status,o.payment_status,o.paid_at,
              CASE WHEN o.partner_transfer_status IN ('settled','received')
                THEN COALESCE(o.partner_settled_at,o.sold_at) ELSE o.sold_at END recognized_at,
              o.created_by,
              COALESCE(SUM(i.unit_price*CASE WHEN o.partner_transfer_status IN ('settled','received')
                THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END),0) item_total,
              COALESCE(SUM(i.unit_cost*CASE WHEN o.partner_transfer_status IN ('settled','received')
                THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END),0) known_cost
         FROM commerce.wholesale_orders o
         JOIN commerce.wholesale_order_items i ON i.order_id=o.id AND i.environment=o.environment
        WHERE o.environment=$1 AND (o.partner_transfer_status IS NULL
          OR o.partner_transfer_status IN ('settled','received')) GROUP BY o.id
     ), purchases AS (
       SELECT p.id,p.created_at,p.total_amount,p.status,p.payment_status,p.paid_at,p.purchased_at,p.created_by,
              COALESCE(SUM(i.line_total),0) item_total
         FROM commerce.wholesale_purchases p
         JOIN commerce.wholesale_purchase_items i ON i.purchase_id=p.id AND i.environment=p.environment
        WHERE p.environment=$1 GROUP BY p.id
     )
     SELECT
       COALESCE((SELECT SUM(total_amount) FROM retail,bounds WHERE status IN ('confirmed','paid','delivered') AND created_at>=month_start AND created_at<month_end),0) retail_header,
       COALESCE((SELECT SUM(item_total) FROM retail,bounds WHERE status IN ('confirmed','paid','delivered') AND created_at>=month_start AND created_at<month_end),0) retail_items,
       COALESCE((SELECT SUM(known_revenue) FROM retail,bounds WHERE status IN ('confirmed','paid','delivered') AND created_at>=month_start AND created_at<month_end),0) retail_known,
       COALESCE((SELECT SUM(pending_revenue) FROM retail,bounds WHERE status IN ('confirmed','paid','delivered') AND created_at>=month_start AND created_at<month_end),0) retail_pending,
       COALESCE((SELECT SUM(known_cost) FROM retail,bounds WHERE status IN ('confirmed','paid','delivered') AND created_at>=month_start AND created_at<month_end),0) retail_cost,
       COALESCE((SELECT SUM(GREATEST(total_amount-item_total,0)) FROM retail,bounds
                  WHERE status IN ('confirmed','paid','delivered') AND fulfillment_mode='delivery'
                    AND created_at>=month_start AND created_at<month_end),0) retail_freight,
       COALESCE((SELECT SUM(pending_revenue) FROM retail WHERE status IN ('confirmed','paid','delivered')),0) pending_all,
       COALESCE((SELECT SUM(pending_items) FROM retail WHERE status IN ('confirmed','paid','delivered')),0)::int pending_items,
       (SELECT COUNT(*) FROM retail WHERE status IN ('confirmed','paid','delivered') AND pending_items>0)::int pending_orders,
       COALESCE((SELECT SUM(total_amount) FROM wholesale,bounds WHERE status='confirmed' AND recognized_at>=month_start AND recognized_at<month_end),0) wholesale_header,
       COALESCE((SELECT SUM(item_total) FROM wholesale,bounds WHERE status='confirmed' AND recognized_at>=month_start AND recognized_at<month_end),0) wholesale_items,
       COALESCE((SELECT SUM(known_cost) FROM wholesale,bounds WHERE status='confirmed' AND recognized_at>=month_start AND recognized_at<month_end),0) wholesale_cost,
       COALESCE((SELECT SUM(commission_amount) FROM network.commission_entries,bounds
                  WHERE environment=$1 AND realized_at>=month_start
                    AND realized_at<month_end),0) commission_revenue,
       COALESCE((SELECT SUM(amount) FROM finance.matriz_commission_reversals,bounds
                  WHERE environment=$1 AND reversed_at>=month_start
                    AND reversed_at<month_end),0) commission_reversal,
       COALESCE((SELECT SUM(amount) FROM commerce.matriz_expenses,bounds
                  WHERE environment=$1 AND deleted_at IS NULL
                    AND ops.matriz_expense_competence_month(competence_month,occurred_at)>=month_start_date
                    AND ops.matriz_expense_competence_month(competence_month,occurred_at)<month_end_date),0) expenses_competence,
       COALESCE((SELECT SUM(amount) FROM finance.matriz_inventory_adjustments,bounds
                  WHERE environment=$1 AND direction='gain'
                    AND occurred_at>=month_start AND occurred_at<month_end),0) inventory_gain,
       COALESCE((SELECT SUM(amount) FROM finance.matriz_inventory_adjustments,bounds
                  WHERE environment=$1 AND direction='loss'
                    AND occurred_at>=month_start AND occurred_at<month_end),0) inventory_loss,
       COALESCE((SELECT SUM(total_amount) FROM purchases,bounds WHERE status<>'cancelled' AND created_at>=month_start AND created_at<month_end),0) purchases_header,
       COALESCE((SELECT SUM(item_total) FROM purchases,bounds WHERE status<>'cancelled' AND created_at>=month_start AND created_at<month_end),0) purchases_items,
       COALESCE((SELECT SUM(total_amount) FROM retail,bounds WHERE status IN ('confirmed','paid','delivered')
                  AND payment_method IS NOT NULL AND lower(trim(payment_method))<>'a receber'
                  AND ((fulfillment_mode='delivery' AND delivery_status='delivered'
                        AND COALESCE(delivered_at,closed_at,created_at)>=month_start
                        AND COALESCE(delivered_at,closed_at,created_at)<month_end)
                    OR (fulfillment_mode<>'delivery' AND status IN ('confirmed','paid','delivered')
                        AND COALESCE(closed_at,created_at)>=month_start
                        AND COALESCE(closed_at,created_at)<month_end))),0) cash_retail,
       COALESCE((SELECT SUM(total_amount) FROM wholesale,bounds WHERE status='confirmed' AND payment_status='paid'
                   AND COALESCE(paid_at,recognized_at)>=month_start
                   AND COALESCE(paid_at,recognized_at)<month_end),0) cash_wholesale,
       COALESCE((SELECT SUM(commission_amount) FROM network.commission_entries,bounds
                  WHERE environment=$1 AND settled_at IS NOT NULL
                    AND settled_at>=month_start AND settled_at<month_end),0) cash_commission,
       COALESCE((SELECT SUM(amount) FROM finance.matriz_commission_reversals,bounds
                  WHERE environment=$1 AND refund_status='paid'
                    AND refunded_at>=month_start AND refunded_at<month_end),0) cash_commission_refund,
       COALESCE((SELECT SUM(total_amount) FROM purchases,bounds WHERE status<>'cancelled' AND payment_status='paid'
                  AND COALESCE(paid_at,purchased_at)>=month_start
                  AND COALESCE(paid_at,purchased_at)<month_end),0) cash_purchases,
       COALESCE((SELECT SUM(amount) FROM commerce.matriz_expenses,bounds WHERE environment=$1
                  AND deleted_at IS NULL AND payment_status='paid'
                  AND COALESCE(paid_at,occurred_at)>=month_start
                  AND COALESCE(paid_at,occurred_at)<month_end),0) cash_expenses,
       COALESCE((SELECT SUM(total_amount) FROM retail,bounds WHERE status IN ('confirmed','paid','delivered')
                  AND created_at>=month_start AND created_at<month_end
                  AND lower(trim(COALESCE(payment_method,'')))<>'a receber'
                  AND NOT (payment_method IS NOT NULL AND ((fulfillment_mode='delivery' AND delivery_status='delivered')
                    OR (fulfillment_mode<>'delivery' AND status IN ('confirmed','paid','delivered'))))),0) retail_payment_pending,
       COALESCE((SELECT SUM(total_amount) FROM retail WHERE status IN ('confirmed','paid','delivered') AND lower(trim(COALESCE(payment_method,'')))='a receber'),0) receivable_retail,
       COALESCE((SELECT SUM(total_amount) FROM wholesale WHERE status='confirmed' AND payment_status='pending'),0) receivable_wholesale,
       COALESCE((SELECT SUM(commission_amount) FROM network.commission_entries WHERE environment=$1 AND status='open'),0) receivable_commission,
       COALESCE((SELECT SUM(total_amount) FROM purchases WHERE status<>'cancelled' AND payment_status='pending'),0) payable_purchases,
       COALESCE((SELECT SUM(amount) FROM commerce.matriz_expenses WHERE environment=$1 AND deleted_at IS NULL AND payment_status='pending'),0) payable_expenses,
       COALESCE((SELECT SUM(amount) FROM finance.matriz_commission_reversals
                  WHERE environment=$1 AND refund_status='pending'),0) payable_commission_refund,
       (SELECT COUNT(*) FROM retail WHERE status='cancelled')::int cancelled_retail,
       (SELECT COUNT(*) FROM wholesale WHERE status='cancelled')::int cancelled_wholesale,
       (SELECT COUNT(*) FROM purchases WHERE status='cancelled')::int cancelled_purchases,
       (SELECT COUNT(*) FROM network.commission_entries WHERE environment=$1 AND status='reversed')::int reversed_commissions,
       (SELECT COUNT(*) FROM commerce.matriz_expenses WHERE environment=$1 AND deleted_at IS NOT NULL)::int deleted_expenses,
       ((SELECT COUNT(*) FROM wholesale WHERE status='confirmed' AND payment_status='paid' AND paid_at IS NULL)
        +(SELECT COUNT(*) FROM purchases WHERE status<>'cancelled' AND payment_status='paid' AND paid_at IS NULL)
        +(SELECT COUNT(*) FROM commerce.matriz_expenses WHERE environment=$1 AND deleted_at IS NULL AND payment_status='paid' AND paid_at IS NULL))::int inferred_cash_dates,
       (SELECT COUNT(*) FROM finance.matriz_commission_reversals
         WHERE environment=$1 AND refund_status='pending')::int reversed_after_settlement,
       ((SELECT COUNT(*) FROM retail WHERE lower(COALESCE(closed_by,'')) ~ '(test|teste|prova|demo)')
        +(SELECT COUNT(*) FROM wholesale WHERE lower(COALESCE(created_by,'')) ~ '(test|teste|prova|demo)')
        +(SELECT COUNT(*) FROM purchases WHERE lower(COALESCE(created_by,'')) ~ '(test|teste|prova|demo)')
        +(SELECT COUNT(*) FROM commerce.matriz_expenses WHERE environment=$1 AND lower(COALESCE(created_by,'')||' '||COALESCE(description,'')) ~ '(test|teste|prova|demo)'))::int suspected_test_rows`,
    [environment],
  );
  const row = result.rows[0]!;
  const retailHeader = cents(row.retail_header); const retailItems = cents(row.retail_items);
  const freight = cents(row.retail_freight); const wholesaleHeader = cents(row.wholesale_header);
  const wholesaleItems = cents(row.wholesale_items);
  const commission = cents(row.commission_revenue) - cents(row.commission_reversal);
  const inventoryGain = cents(row.inventory_gain); const inventoryLoss = cents(row.inventory_loss);
  const expenses = cents(row.expenses_competence) + inventoryLoss;
  const purchasesHeader = cents(row.purchases_header);
  const purchasesItems = cents(row.purchases_items); const pending = cents(row.retail_pending);
  const pendingAll = cents(row.pending_all);
  const origins: MatrizFinancialTruth['conciliacao']['origens'] = [
    ['atacado', wholesaleHeader, wholesaleItems], ['varejo', retailHeader, retailItems + freight],
    ['frete', freight, freight], ['comissao', commission, commission], ['despesas', expenses, expenses],
    ['compras', purchasesHeader, purchasesItems],
    ['estoque', inventoryGain - inventoryLoss, inventoryGain - inventoryLoss],
  ].map(([origem, source, accounted]) => ({ origem: origem as Origin, origem_total: money(source as number),
    contabilizado: money(accounted as number), diferenca: money((source as number) - (accounted as number)) }));
  const difference = origins.reduce((sum, item) => sum + Math.abs(cents(item.diferenca)), 0);
  const knownRevenue = wholesaleItems + cents(row.retail_known) + freight + commission;
  const knownCost = cents(row.wholesale_cost) + cents(row.retail_cost);
  const status = difference ? 'divergente' : pending ? 'custo_pendente' : 'confirmado';
  const cashIn = cents(row.cash_retail) + cents(row.cash_wholesale) + cents(row.cash_commission);
  const cashOut = cents(row.cash_purchases) + cents(row.cash_expenses)
    + cents(row.cash_commission_refund);
  return {
    competencia: { receita_total: money(knownRevenue + pending), receita_custo_conhecido: money(knownRevenue),
      receita_custo_pendente: money(pending), custo_conhecido: money(knownCost), despesas: money(expenses),
      ajustes_estoque: { ganhos: money(inventoryGain), perdas: money(inventoryLoss),
        efeito_liquido: money(inventoryGain - inventoryLoss) },
      lucro_confirmado: money(knownRevenue - knownCost - expenses + inventoryGain), status },
    caixa: { entradas_registradas: money(cashIn), saidas_registradas: money(cashOut),
      movimento_liquido: money(cashIn - cashOut), recebimento_pendente: money(cents(row.retail_payment_pending)),
      recebimentos: { varejo: money(cents(row.cash_retail)), atacado: money(cents(row.cash_wholesale)), comissao: money(cents(row.cash_commission)) },
      pagamentos: { compras: money(cents(row.cash_purchases)),
        despesas: money(cents(row.cash_expenses)),
        devolucoes_comissao: money(cents(row.cash_commission_refund)) } },
    posicao: { a_receber: money(cents(row.receivable_retail) + cents(row.receivable_wholesale) + cents(row.receivable_commission)),
      a_pagar: money(cents(row.payable_purchases) + cents(row.payable_expenses)
        + cents(row.payable_commission_refund)),
      varejo_a_receber_sem_baixa: money(cents(row.receivable_retail)) },
    conciliacao: { status: difference ? 'divergente' : pendingAll ? 'custo_pendente' : 'ok', diferenca_total: money(difference), origens: origins,
      custo_pendente: { receita: money(pendingAll), itens: row.pending_items, pedidos: row.pending_orders },
      cancelamentos: { varejo: row.cancelled_retail, atacado: row.cancelled_wholesale, compras: row.cancelled_purchases,
        comissoes: row.reversed_commissions, despesas: row.deleted_expenses },
      qualidade: { datas_caixa_inferidas: row.inferred_cash_dates,
        comissoes_estornadas_apos_quitacao: row.reversed_after_settlement, registros_teste_suspeitos: row.suspected_test_rows } },
  };
}

export async function getMatrizFinancialTruth(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizFinancialTruth> {
  return (await getMatrizFinancialRead(environment, dbPool)).truth;
}
