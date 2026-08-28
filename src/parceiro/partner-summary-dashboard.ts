import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';
import { logger } from '../shared/logger.js';

export type PartnerSummaryPeriod = 'today' | '7d' | 'month';

const PERIOD_START_SQL: Record<PartnerSummaryPeriod, string> = {
  today: `(date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')
    AT TIME ZONE 'America/Sao_Paulo')`,
  '7d': `((date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')-interval '6 days')
    AT TIME ZONE 'America/Sao_Paulo')`,
  month: `(date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')
    AT TIME ZONE 'America/Sao_Paulo')`,
};

const REALIZED_ORDER = `o.status<>'cancelled' AND o.deleted_at IS NULL
  AND NOT (o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered')
  AND NOT o.awaiting_pickup`;
const REALIZED_AT = `(CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at
  ELSE COALESCE(o.retrieved_at,o.created_at) END)`;
const ORDER_EVENT_AT = `(CASE WHEN ${REALIZED_ORDER} THEN ${REALIZED_AT} ELSE o.created_at END)`;

interface PartnerSummaryDetails {
  movement_series: unknown[];
  recent_events: unknown[];
}

/**
 * Resumo simples do parceiro. Totais financeiros continuam vindo da view oficial;
 * esta leitura acrescenta somente série diária e feed operacional, sempre sob RLS.
 */
export async function getPartnerSummaryDashboard(
  ctx: PartnerContext,
  period: PartnerSummaryPeriod = 'month',
): Promise<Record<string, unknown> | null> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const baseResult = await client.query<Record<string, unknown>>(
      `SELECT * FROM network.partner_unit_summary
        WHERE environment=$1 AND unit_id=$2`,
      [ctx.environment, ctx.unitId],
    );
    const base = baseResult.rows[0];
    if (!base) return null;

    let satisfaction_avg: number | null = null;
    let satisfaction_count = 0;
    try {
      const satisfaction = await client.query<{ avg: string | null; n: string }>(
        `SELECT round(avg(rating)::numeric,1) avg,count(id)::text n
           FROM commerce.satisfaction_surveys
          WHERE environment=$1 AND unit_id=$2 AND status='answered'`,
        [ctx.environment, ctx.unitId],
      );
      satisfaction_avg = satisfaction.rows[0]?.avg == null
        ? null : Number(satisfaction.rows[0].avg);
      satisfaction_count = Number(satisfaction.rows[0]?.n ?? 0);
    } catch (error) {
      logger.warn({ err: error, unit_id: ctx.unitId },
        'resumo: satisfacao indisponivel; mantendo painel operacional');
    }

    const periodStartSql = PERIOD_START_SQL[period];
    const details = await client.query<PartnerSummaryDetails>(
      `WITH day_ref AS (
         SELECT generate_series(
           date_trunc('day',${periodStartSql} AT TIME ZONE 'America/Sao_Paulo'),
           date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo'),interval '1 day'
         )::date AS metric_day
       ), daily AS (
         SELECT d.metric_day,
           COALESCE(sum(o.total_amount),0)::numeric total,
           count(o.id)::int orders
         FROM day_ref d
         LEFT JOIN commerce.partner_orders o
           ON o.environment=$1 AND o.unit_id=$2 AND ${REALIZED_ORDER}
          AND ${REALIZED_AT}>=d.metric_day::timestamp AT TIME ZONE 'America/Sao_Paulo'
          AND ${REALIZED_AT}<(d.metric_day+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'
         GROUP BY d.metric_day
       ), recent AS (
         SELECT * FROM (
           SELECT CASE
                    WHEN o.awaiting_pickup THEN 'pickup'
                    WHEN o.fulfillment_mode='delivery' AND o.delivery_status<>'delivered' THEN 'delivery'
                    ELSE 'sale'
                  END kind,
                  ${ORDER_EVENT_AT} event_at,
                  COALESCE(o.customer_name,'Cliente') description,
                  left(o.id::text,8) reference,
                  CASE WHEN ${REALIZED_ORDER} THEN o.total_amount ELSE NULL END amount
             FROM commerce.partner_orders o
            WHERE o.environment=$1 AND o.unit_id=$2 AND o.status<>'cancelled'
              AND o.deleted_at IS NULL AND ${ORDER_EVENT_AT}>=${periodStartSql}
           UNION ALL
           SELECT 'purchase',p.purchased_at,COALESCE(p.supplier_name,'Fornecedor'),
                  left(p.id::text,8),-p.total_amount
             FROM commerce.partner_purchases p
            WHERE p.environment=$1 AND p.unit_id=$2 AND p.deleted_at IS NULL
              AND p.purchased_at>=${periodStartSql}
           UNION ALL
           SELECT 'expense',e.expense_date::timestamp AT TIME ZONE 'America/Sao_Paulo',
                  e.description,left(e.id::text,8),-e.amount
             FROM finance.partner_expenses e
            WHERE e.environment=$1 AND e.unit_id=$2 AND e.deleted_at IS NULL
              AND e.expense_date>=(${periodStartSql} AT TIME ZONE 'America/Sao_Paulo')::date
         ) events ORDER BY event_at DESC LIMIT 8
       )
       SELECT
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'day',metric_day,'total',total,'orders',orders) ORDER BY metric_day) FROM daily),'[]') movement_series,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'kind',kind,'event_at',event_at,'description',description,
           'reference',reference,'amount',amount) ORDER BY event_at DESC) FROM recent),'[]') recent_events`,
      [ctx.environment, ctx.unitId],
    );
    const detail = details.rows[0] ?? { movement_series: [], recent_events: [] };
    return {
      ...base,
      satisfaction_avg,
      satisfaction_count,
      movement_period: period,
      movement_series: detail.movement_series,
      recent_events: detail.recent_events,
    };
  });
}
