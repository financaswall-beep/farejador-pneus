import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';
import { pool } from '../persistence/db.js';
import {
  simpleFinanceRangeDays,
  type SimpleFinancePayload,
  type SimpleFinanceRange,
} from '../shared/simple-finance.js';

interface SimpleFinanceRow {
  cash_in: string;
  cash_out: string;
  receivable_total: string;
  receivable_count: number;
  due_today_total: string;
  due_today_count: number;
  commission_total: string;
}

interface CommissionCollaboratorsRow {
  commission_collaborators: number;
}

function saoPauloMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

/**
 * Resumo de caixa do dono. Entradas e saídas respeitam o intervalo rápido do
 * app; pendências e comissões permanecem como fotografia operacional atual.
 * Tudo roda sob o contexto/RLS da própria unidade.
 */
export async function getPartnerSimpleFinance(
  ctx: PartnerContext,
  range: SimpleFinanceRange,
): Promise<SimpleFinancePayload> {
  const days = simpleFinanceRangeDays(range);
  const [finance, collaborators] = await Promise.all([
    withPartnerContext(ctx.partnerUnitId, async (client) => {
      const result = await client.query<SimpleFinanceRow>(
        `WITH bounds AS (
         SELECT date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date
                  AS month_start_date,
                ((date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')
                  - (($3::int-1)*interval '1 day')) AT TIME ZONE 'America/Sao_Paulo')
                  AS range_start_at,
                ((date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')
                  + interval '1 day') AT TIME ZONE 'America/Sao_Paulo') AS range_end_at,
                ((now() AT TIME ZONE 'America/Sao_Paulo')::date-($3::int-1))
                  AS range_start_date,
                ((now() AT TIME ZONE 'America/Sao_Paulo')::date+1) AS range_end_date
       ), cash_in AS (
         SELECT
           COALESCE((SELECT sum(po.total_amount)
             FROM commerce.partner_orders po,bounds b
            WHERE po.environment=$1 AND po.unit_id=$2
              AND (po.status<>'cancelled' OR EXISTS (SELECT 1
                FROM finance.partner_order_refunds refund
                WHERE refund.environment=po.environment AND refund.order_id=po.id))
              AND po.deleted_at IS NULL
              AND NOT (po.fulfillment_mode='delivery'
                AND po.delivery_status<>'delivered')
              AND NOT po.awaiting_pickup
              AND (CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
                        ELSE COALESCE(po.retrieved_at,po.created_at) END)
                    >=b.range_start_at
              AND (CASE WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
                        ELSE COALESCE(po.retrieved_at,po.created_at) END)
                    <b.range_end_at
              AND NOT EXISTS (SELECT 1 FROM finance.partner_receivables linked
                WHERE linked.environment=po.environment
                  AND linked.source_order_id=po.id AND linked.deleted_at IS NULL)),0)
           + COALESCE((SELECT sum(event.amount)
             FROM finance.partner_receivable_events event,bounds b
            WHERE event.environment=$1 AND event.unit_id=$2
              AND event.event_kind IN ('receipt','recovery')
              AND event.occurred_at>=b.range_start_at
              AND event.occurred_at<b.range_end_at),0)
           AS total
       ), cash_out AS (
         SELECT
           COALESCE((SELECT sum(pp.total_amount)
             FROM commerce.partner_purchases pp,bounds b
            WHERE pp.environment=$1 AND pp.unit_id=$2 AND pp.deleted_at IS NULL
              AND pp.payment_status='paid_now'
              AND NOT EXISTS (SELECT 1 FROM finance.partner_payables linked
                WHERE linked.environment=pp.environment
                  AND linked.source_purchase_id=pp.id AND linked.deleted_at IS NULL)
              AND pp.purchased_at>=b.range_start_at AND pp.purchased_at<b.range_end_at),0)
           + COALESCE((SELECT sum(pe.amount)
             FROM finance.partner_expenses pe,bounds b
            WHERE pe.environment=$1 AND pe.unit_id=$2 AND pe.deleted_at IS NULL
              AND pe.source_payable_id IS NULL
              AND pe.expense_date>=b.range_start_date
              AND pe.expense_date<b.range_end_date),0)
           + COALESCE((SELECT sum(event.amount)
             FROM finance.partner_payable_events event,bounds b
            WHERE event.environment=$1 AND event.unit_id=$2
              AND event.paid_at>=b.range_start_at
              AND event.paid_at<b.range_end_at),0)
           + COALESCE((SELECT sum(event.amount)
             FROM finance.partner_receivable_events event,bounds b
            WHERE event.environment=$1 AND event.unit_id=$2
              AND event.event_kind='refund'
              AND event.occurred_at>=b.range_start_at
              AND event.occurred_at<b.range_end_at),0)
           + COALESCE((SELECT sum(refund.amount)
             FROM finance.partner_order_refunds refund,bounds b
            WHERE refund.environment=$1 AND refund.unit_id=$2
              AND refund.refunded_at>=b.range_start_at
              AND refund.refunded_at<b.range_end_at),0) AS total
       ), commissions AS (
         SELECT
           COALESCE((SELECT sum(ce.commission_amount)
             FROM finance.partner_staff_commission_entries ce,bounds b
            WHERE ce.environment=$1 AND ce.unit_id=$2 AND ce.status='earned'
              AND ce.competence_month=b.month_start_date),0)
           + COALESCE((SELECT sum(ca.amount)
             FROM finance.partner_staff_commission_adjustments ca,bounds b
            WHERE ca.environment=$1 AND ca.unit_id=$2
              AND ca.competence_month=b.month_start_date),0) AS total
       )
       SELECT cash_in.total::text AS cash_in,
              cash_out.total::text AS cash_out,
              COALESCE((SELECT sum(pre.open_amount)
                FROM finance.partner_receivables_effective pre
               WHERE pre.environment=$1 AND pre.unit_id=$2 AND pre.open_amount>0),0)::text
                AS receivable_total,
              (SELECT count(*)::int FROM finance.partner_receivables_effective pre
                WHERE pre.environment=$1 AND pre.unit_id=$2 AND pre.open_amount>0)
                AS receivable_count,
              COALESCE((SELECT sum(pp.open_amount) FROM finance.partner_payables_effective pp
                WHERE pp.environment=$1 AND pp.unit_id=$2 AND pp.open_amount>0
                  AND pp.due_date=(now() AT TIME ZONE 'America/Sao_Paulo')::date),0)::text
                AS due_today_total,
              (SELECT count(*)::int FROM finance.partner_payables_effective pp
                WHERE pp.environment=$1 AND pp.unit_id=$2 AND pp.open_amount>0
                  AND pp.due_date=(now() AT TIME ZONE 'America/Sao_Paulo')::date)
                AS due_today_count,
              commissions.total::text AS commission_total
         FROM cash_in,cash_out,commissions`,
        [ctx.environment, ctx.unitId, days],
      );
      return result.rows[0]!;
    }),
    // Credenciais e regras de comissão são tabelas administrativas sem GRANT
    // para o pool restrito do portal. A contagem roda no backend, escopada pelos
    // IDs da sessão; não amplia a superfície SQL disponível ao parceiro.
    pool.query<CommissionCollaboratorsRow>(
      `SELECT count(*)::int AS commission_collaborators
         FROM network.partner_access_tokens pat
         JOIN network.partner_token_commission cfg
           ON cfg.environment=pat.environment AND cfg.token_id=pat.id
        WHERE pat.environment=$1 AND pat.partner_unit_id=$2
          AND pat.role='funcionario' AND pat.revoked_at IS NULL AND cfg.active`,
      [ctx.environment, ctx.partnerUnitId],
    ),
  ]);
  const row = finance;
  const cashIn = Number(row.cash_in ?? 0);
  const cashOut = Number(row.cash_out ?? 0);
  return {
    period: saoPauloMonth(),
    range,
    unit_name: ctx.unitName,
    cash_in: cashIn,
    cash_out: cashOut,
    cash_net: Math.round((cashIn - cashOut) * 100) / 100,
    receivable_total: Number(row.receivable_total ?? 0),
    receivable_count: Number(row.receivable_count ?? 0),
    due_today_total: Number(row.due_today_total ?? 0),
    due_today_count: Number(row.due_today_count ?? 0),
    commission_total: Number(row.commission_total ?? 0),
    commission_collaborators: Number(
      collaborators.rows[0]?.commission_collaborators ?? 0,
    ),
  };
}
