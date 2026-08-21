import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

type Environment = 'prod' | 'test';
type Origin = 'atacado' | 'varejo' | 'comissao' | 'mensalidades'
  | 'despesas' | 'marketing' | 'compras' | 'estoque';

interface GateRow {
  competence: string;
  origin: Origin;
  source_total: string;
  ledger_total: string;
  difference: string;
  pending_marketing_campaigns: number;
}

export interface MatrizLedgerCompetenceGate {
  status: 'green' | 'yellow' | 'red';
  required_competences: number;
  checked_competences: number;
  total_abs_difference: string;
  competences: Array<{
    competence: string;
    status: 'green' | 'yellow' | 'red';
    pending_marketing_campaigns: number;
    total_abs_difference: string;
    origins: Array<{
      origin: Origin;
      source_total: string;
      ledger_total: string;
      difference: string;
      matched: boolean;
    }>;
  }>;
}

function normalizeCompetences(values: string[]): string[] {
  const unique = [...new Set(values.map((value) => value.trim()))].sort();
  if (unique.length < 2 || unique.some((value) =>
    !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(value))) {
    throw new Error('two_competences_required');
  }
  return unique;
}

const cents = (value: string): number => Math.round(Number(value || 0) * 100);
const money = (value: number): string => (value / 100).toFixed(2);

export async function getMatrizLedgerCompetenceGate(
  competences: string[],
  environment: Environment = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizLedgerCompetenceGate> {
  const months = normalizeCompetences(competences);
  const result = await dbPool.query<GateRow>(
    `WITH months AS (
       SELECT month competence,(month+interval '1 month')::date month_end,
              month::timestamp AT TIME ZONE 'America/Sao_Paulo' month_ts,
              (month+interval '1 month')::timestamp
                AT TIME ZONE 'America/Sao_Paulo' month_end_ts
         FROM unnest($2::date[]) month
     ), origins(origin) AS (VALUES
       ('atacado'),('varejo'),('comissao'),('mensalidades'),
       ('despesas'),('marketing'),('compras'),('estoque')
     ), source_values AS (
       SELECT m.competence,'atacado' origin,
         COALESCE((SELECT sum(COALESCE(settled_total_amount,total_amount)) FROM commerce.wholesale_orders
           WHERE environment=$1
             AND (CASE WHEN partner_transfer_status IN ('settled','received')
                    THEN COALESCE(partner_settled_at,sold_at) ELSE sold_at END)>=m.month_ts
             AND (CASE WHEN partner_transfer_status IN ('settled','received')
                    THEN COALESCE(partner_settled_at,sold_at) ELSE sold_at END)<m.month_end_ts
             AND (partner_transfer_status IS NULL
               OR partner_transfer_status IN ('settled','received'))),0)
         -COALESCE((SELECT sum(COALESCE(settled_total_amount,total_amount)) FROM commerce.wholesale_orders
           WHERE environment=$1 AND status='cancelled'
             AND cancelled_at>=m.month_ts AND cancelled_at<m.month_end_ts),0) value
         FROM months m
       UNION ALL
       SELECT m.competence,'varejo',
         COALESCE((SELECT sum(o.total_amount) FROM commerce.orders o
           JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id
            AND u.slug='main'
          WHERE o.environment=$1 AND o.partner_order_id IS NULL
            AND o.status IN ('confirmed','paid','delivered','cancelled')
            AND o.created_at>=m.month_ts AND o.created_at<m.month_end_ts),0)
         -COALESCE((SELECT sum(o.total_amount) FROM commerce.orders o
           JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id
            AND u.slug='main'
          WHERE o.environment=$1 AND o.partner_order_id IS NULL
            AND o.status='cancelled' AND o.updated_at>=m.month_ts
            AND o.updated_at<m.month_end_ts),0) FROM months m
       UNION ALL
       SELECT m.competence,'comissao',
         COALESCE((SELECT sum(commission_amount) FROM network.commission_entries
           WHERE environment=$1 AND realized_at>=m.month_ts
             AND realized_at<m.month_end_ts),0)
         -COALESCE((SELECT sum(amount) FROM finance.matriz_commission_reversals
           WHERE environment=$1 AND reversed_at>=m.month_ts
             AND reversed_at<m.month_end_ts),0) FROM months m
       UNION ALL
       SELECT m.competence,'mensalidades',
         COALESCE((SELECT sum(amount) FROM finance.matriz_partner_monthly_fees
           WHERE environment=$1 AND competence>=m.competence
             AND competence<m.month_end),0) FROM months m
       UNION ALL
       SELECT m.competence,'despesas',
         COALESCE((SELECT sum(amount) FROM commerce.matriz_expenses
           WHERE environment=$1
             AND ops.matriz_expense_competence_month(competence_month,occurred_at)
               >=m.competence
             AND ops.matriz_expense_competence_month(competence_month,occurred_at)
               <m.month_end),0)
         -COALESCE((SELECT sum(amount) FROM commerce.matriz_expenses
           WHERE environment=$1 AND deleted_at IS NOT NULL
             AND deleted_at>=m.month_ts AND deleted_at<m.month_end_ts),0) FROM months m
       UNION ALL
       SELECT m.competence,'marketing',
         COALESCE((SELECT sum(CASE WHEN $3::boolean THEN financial_spend ELSE spend END)
           FROM marketing.meta_insights_daily_scoped
           WHERE environment=$1 AND entity_level='campaign'
             AND account_currency='BRL' AND metric_date>=m.competence
             AND metric_date<m.month_end),0) FROM months m
       UNION ALL
       SELECT m.competence,'compras',
         COALESCE((SELECT sum(total_amount) FROM commerce.wholesale_purchases
           WHERE environment=$1 AND purchased_at>=m.month_ts
             AND purchased_at<m.month_end_ts),0)
         -COALESCE((SELECT sum(total_amount) FROM commerce.wholesale_purchases
           WHERE environment=$1 AND status='cancelled'
             AND cancelled_at>=m.month_ts AND cancelled_at<m.month_end_ts),0) FROM months m
       UNION ALL
       SELECT m.competence,'estoque',
         COALESCE((SELECT sum(CASE direction WHEN 'gain' THEN amount ELSE -amount END)
           FROM finance.matriz_inventory_adjustments
          WHERE environment=$1 AND occurred_at>=m.month_ts
            AND occurred_at<m.month_end_ts),0) FROM months m
     ), ledger_lines AS (
       SELECT m.competence,
         CASE
           WHEN t.source_type LIKE 'commerce.wholesale_order.%' THEN 'atacado'
           WHEN t.source_type LIKE 'commerce.order.%' THEN 'varejo'
           WHEN t.source_type LIKE 'network.commission_entry.%' THEN 'comissao'
           WHEN t.source_type LIKE 'network.monthly_fee.%' THEN 'mensalidades'
           WHEN t.source_type LIKE 'commerce.matriz_expense.%' THEN 'despesas'
           WHEN t.source_type='marketing.meta_spend.adjustment' THEN 'marketing'
           WHEN t.source_type LIKE 'commerce.wholesale_purchase.%' THEN 'compras'
           WHEN t.source_type='finance.inventory_adjustment' THEN 'estoque'
         END origin,e.account_code,e.account_class,e.side,e.amount
       FROM months m
       JOIN finance.matriz_ledger_transactions t ON t.environment=$1
        AND t.competence_on>=m.competence AND t.competence_on<m.month_end
       JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
     ), ledger_values AS (
       SELECT competence,origin,sum(CASE
         WHEN origin IN ('atacado','varejo','comissao','mensalidades')
           AND account_class='revenue'
           THEN CASE side WHEN 'credit' THEN amount ELSE -amount END
         WHEN origin='despesas' AND account_class='expense'
           AND account_code LIKE 'expense_%'
           THEN CASE side WHEN 'debit' THEN amount ELSE -amount END
         WHEN origin='marketing' AND account_code='marketing_expense'
           THEN CASE side WHEN 'debit' THEN amount ELSE -amount END
         WHEN origin='compras' AND account_code IN ('inventory','inventory_in_transit')
           THEN CASE side WHEN 'debit' THEN amount ELSE -amount END
         WHEN origin='estoque' AND account_code='inventory_gain'
           THEN CASE side WHEN 'credit' THEN amount ELSE -amount END
         WHEN origin='estoque'
           AND account_code IN ('inventory_loss','inventory_internal_use')
           THEN CASE side WHEN 'credit' THEN amount ELSE -amount END
         ELSE 0 END) value
       FROM ledger_lines WHERE origin IS NOT NULL GROUP BY competence,origin
     )
     SELECT m.competence::text,o.origin,
            COALESCE(s.value,0)::numeric(14,2)::text source_total,
            COALESCE(l.value,0)::numeric(14,2)::text ledger_total,
            (COALESCE(s.value,0)-COALESCE(l.value,0))::numeric(14,2)::text difference,
            (SELECT count(DISTINCT (mi.ad_account_id,mi.campaign_id))::int
               FROM marketing.meta_insights_daily_scoped mi
              WHERE $3::boolean AND mi.environment=$1
                AND mi.entity_level='campaign' AND mi.spend>0
                AND mi.campaign_scope='pending'
                AND mi.metric_date>=m.competence AND mi.metric_date<m.month_end)
              AS pending_marketing_campaigns
       FROM months m CROSS JOIN origins o
       LEFT JOIN source_values s ON s.competence=m.competence AND s.origin=o.origin
       LEFT JOIN ledger_values l ON l.competence=m.competence AND l.origin=o.origin
      ORDER BY m.competence,o.origin`,
    [environment, months, env.MARKETING_SCOPE_ENFORCEMENT_ENABLED],
  );
  const grouped = new Map<string, GateRow[]>();
  for (const row of result.rows) {
    const current = grouped.get(row.competence) ?? [];
    current.push(row);
    grouped.set(row.competence, current);
  }
  let total = 0;
  let pendingTotal = 0;
  const reports = months.map((competence) => {
    const rows = grouped.get(competence) ?? [];
    const difference = rows.reduce((sum, row) => sum + Math.abs(cents(row.difference)), 0);
    const pendingMarketing = rows[0]?.pending_marketing_campaigns ?? 0;
    total += difference;
    pendingTotal += pendingMarketing;
    return {
      competence,
      status: difference > 0 ? 'red' as const
        : pendingMarketing > 0 ? 'yellow' as const : 'green' as const,
      pending_marketing_campaigns: pendingMarketing,
      total_abs_difference: money(difference),
      origins: rows.map((row) => ({
        origin: row.origin, source_total: row.source_total,
        ledger_total: row.ledger_total, difference: row.difference,
        matched: cents(row.difference) === 0,
      })),
    };
  });
  return {
    status: total > 0 ? 'red' : pendingTotal > 0 ? 'yellow' : 'green',
    required_competences: 2, checked_competences: reports.length,
    total_abs_difference: money(total), competences: reports,
  };
}
