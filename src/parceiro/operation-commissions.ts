import type { Pool } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import type { SimpleFinanceRange } from '../shared/simple-finance.js';
import {
  money,
  operationCommissionBounds,
  type OperationCommissionCollaborator,
  type OperationCommissionDetailPayload,
  type OperationCommissionSale,
  type OperationCommissionsPayload,
} from '../shared/operation-commissions.js';
import { commissionItemRulesOf } from '../shared/operation-team.js';
import type { PartnerContext } from './auth.js';
import { settlePartnerPayable } from './queries.js';

type Queryable = Pick<Pool, 'query'>;

type TeamRow = {
  token_id: string; label: string | null; username: string | null; active: boolean;
  commission_kind: 'percent' | 'fixed' | null; commission_value: string;
  commission_itemized: boolean; commission_item_rules: unknown;
  settlement_frequency: 'weekly' | 'monthly';
  sales_count: number; gross_sales: string; commission_amount: string; unsettled_count: number;
};

type SettlementRow = {
  token_id: string; payable_id: string | null; payable_amount: string;
  payable_status: 'open' | 'paid' | null;
  settlement_frequency: 'weekly' | 'monthly'; period_start: string; period_end: string;
};

async function teamRows(
  ctx: PartnerContext,
  range: SimpleFinanceRange,
  db: Queryable,
): Promise<{ rows: TeamRow[]; settlements: SettlementRow[] }> {
  const bounds = operationCommissionBounds(range);
  const [team, settlements] = await Promise.all([
    db.query<TeamRow>(
      `WITH facts AS (
         SELECT ce.token_id,1::int sales_count,ce.gross_amount,
                ce.commission_amount,(ce.settlement_period_id IS NULL)::int unsettled_count
           FROM finance.partner_staff_commission_entries ce
          WHERE ce.environment=$1 AND ce.unit_id=$2 AND ce.status='earned'
            AND ce.realized_at >= $4::date AND ce.realized_at < $5::date
         UNION ALL
         SELECT ca.token_id,0::int,0::numeric,ca.amount,
                (ca.settlement_period_id IS NULL)::int unsettled_count
           FROM finance.partner_staff_commission_adjustments ca
          WHERE ca.environment=$1 AND ca.unit_id=$2
            AND ca.occurred_at >= $4::date AND ca.occurred_at < $5::date
       ), totals AS (
         SELECT token_id,sum(sales_count)::int sales_count,
                COALESCE(sum(gross_amount),0)::numeric gross_sales,
                COALESCE(sum(commission_amount),0)::numeric commission_amount,
                COALESCE(sum(unsettled_count),0)::int unsettled_count
           FROM facts GROUP BY token_id
       )
       SELECT pat.id token_id,pat.label,pat.login_username username,
              pat.revoked_at IS NULL active,cfg.kind commission_kind,
              COALESCE(cfg.value,0)::text commission_value,
              COALESCE(cfg.itemized,false) commission_itemized,
              COALESCE(cfg.item_rules,'{}'::jsonb) commission_item_rules,
              COALESCE(cfg.settlement_frequency,'monthly') settlement_frequency,
              COALESCE(t.sales_count,0)::int sales_count,
              COALESCE(t.gross_sales,0)::text gross_sales,
              COALESCE(t.commission_amount,0)::text commission_amount,
              COALESCE(t.unsettled_count,0)::int unsettled_count
         FROM network.partner_access_tokens pat
         LEFT JOIN network.partner_token_commission cfg
           ON cfg.environment=pat.environment AND cfg.token_id=pat.id AND cfg.active
         LEFT JOIN totals t ON t.token_id=pat.id
        WHERE pat.environment=$1 AND pat.partner_unit_id=$3
          AND pat.role='funcionario'
          AND (pat.revoked_at IS NULL OR t.token_id IS NOT NULL)
          AND (t.token_id IS NOT NULL OR cfg.token_id IS NOT NULL)
        ORDER BY COALESCE(t.commission_amount,0) DESC,
                 COALESCE(NULLIF(btrim(pat.label),''),pat.login_username)`,
      [ctx.environment, ctx.unitId, ctx.partnerUnitId, bounds.start, bounds.end],
    ),
    db.query<SettlementRow>(
      `SELECT period.token_id,period.payable_id,
              COALESCE(period.payable_amount,0)::text payable_amount,
              payable.status payable_status,period.settlement_frequency,
              period.period_start::text,period.period_end::text
         FROM finance.partner_staff_commission_periods period
         LEFT JOIN finance.partner_payables payable
           ON payable.environment=period.environment AND payable.id=period.payable_id
        WHERE period.environment=$1 AND period.unit_id=$2
          AND period.period_start >= (date_trunc('month',$3::date)-interval '12 months')::date
        ORDER BY period.period_start DESC`,
      [ctx.environment, ctx.unitId, bounds.start],
    ),
  ]);
  return { rows: team.rows, settlements: settlements.rows };
}

function collaboratorOf(row: TeamRow, settlements: SettlementRow[]): OperationCommissionCollaborator {
  const frequency = row.settlement_frequency ?? 'monthly';
  const own = settlements.filter((item) => item.token_id === row.token_id && item.payable_id);
  const open = own.filter((item) => item.payable_status === 'open');
  const allPaid = own.length > 0 && own.every((item) => item.payable_status === 'paid');
  const payable = open.sort((a, b) => a.period_start.localeCompare(b.period_start))[0];
  const canPay = Boolean(payable);
  return {
    id: row.token_id,
    name: row.label?.trim() || row.username?.trim() || 'Colaborador',
    username: row.username,
    role: 'Vendedor',
    active: row.active,
    sales_count: Number(row.sales_count || 0),
    gross_sales: money(row.gross_sales),
    commission_kind: row.commission_kind,
    commission_basis: row.commission_kind === 'percent' ? 'revenue' : 'sale',
    commission_value: money(row.commission_value),
    commission_amount: money(row.commission_amount),
    commission_itemized: Boolean(row.commission_itemized),
    commission_item_rules: commissionItemRulesOf(row.commission_item_rules),
    settlement_frequency: payable?.settlement_frequency ?? frequency,
    status: canPay ? 'payable' : (allPaid && Number(row.unsettled_count || 0) === 0 ? 'paid' : 'open'),
    payment_target_id: canPay ? payable!.payable_id : null,
    payment_total: canPay ? money(payable!.payable_amount) : null,
    payment_period_start: canPay ? payable!.period_start : null,
    payment_period_end: canPay ? payable!.period_end : null,
  };
}

export async function getPartnerOperationCommissions(
  ctx: PartnerContext,
  range: SimpleFinanceRange,
  db: Queryable = defaultPool,
): Promise<OperationCommissionsPayload> {
  const result = await teamRows(ctx, range, db);
  const collaborators = result.rows.map((row) => collaboratorOf(row, result.settlements));
  const totalCommission = money(collaborators.reduce((sum, row) => sum + row.commission_amount, 0));
  const totalSales = collaborators.reduce((sum, row) => sum + row.sales_count, 0);
  return {
    range,
    unit_name: ctx.unitName,
    total_commission: totalCommission,
    total_sales: totalSales,
    average_commission: totalSales ? money(totalCommission / totalSales) : 0,
    collaborators,
  };
}

export async function getPartnerOperationCommissionDetail(
  ctx: PartnerContext,
  collaboratorId: string,
  range: SimpleFinanceRange,
  db: Queryable = defaultPool,
): Promise<OperationCommissionDetailPayload | null> {
  const overview = await getPartnerOperationCommissions(ctx, range, db);
  const collaborator = overview.collaborators.find((row) => row.id === collaboratorId);
  if (!collaborator) return null;
  const bounds = operationCommissionBounds(range);
  const detailStart = collaborator.status === 'payable' && collaborator.payment_period_start
    ? collaborator.payment_period_start : bounds.start;
  const detailEnd = collaborator.status === 'payable' && collaborator.payment_period_end
    ? new Date(new Date(`${collaborator.payment_period_end}T12:00:00Z`).getTime() + 86_400_000)
        .toISOString().slice(0, 10)
    : bounds.end;
  const result = await db.query<{
    id: string; reference: string; occurred_at: string; payment_method: string | null;
    gross_amount: string; commission_amount: string; commission_itemized: boolean;
    commission_rules: unknown;
  }>(
    `SELECT ce.id::text id,'Pedido #'||right(ce.partner_order_id::text,6) reference,
            ce.realized_at occurred_at,po.payment_method,
            ce.gross_amount::text,ce.commission_amount::text,
            ce.commission_itemized,ce.commission_rules
       FROM finance.partner_staff_commission_entries ce
       JOIN commerce.partner_orders po
         ON po.environment=ce.environment AND po.id=ce.partner_order_id
      WHERE ce.environment=$1 AND ce.unit_id=$2 AND ce.token_id=$3
        AND ce.status='earned' AND ce.realized_at >= $4::date AND ce.realized_at < $5::date
      ORDER BY ce.realized_at DESC LIMIT 200`,
    [ctx.environment, ctx.unitId, collaboratorId, detailStart, detailEnd],
  );
  const sales: OperationCommissionSale[] = result.rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    occurred_at: row.occurred_at,
    payment_method: row.payment_method,
    gross_amount: money(row.gross_amount),
    commission_amount: money(row.commission_amount),
    commission_itemized: Boolean(row.commission_itemized),
    commission_item_rules: commissionItemRulesOf(row.commission_rules),
  }));
  const detailCollaborator = collaborator.status === 'payable' ? {
    ...collaborator,
    sales_count: sales.length,
    gross_sales: money(sales.reduce((sum, sale) => sum + sale.gross_amount, 0)),
    commission_amount: money(sales.reduce((sum, sale) => sum + sale.commission_amount, 0)),
  } : collaborator;
  return { range, unit_name: ctx.unitName, collaborator: detailCollaborator, sales };
}

export async function payPartnerOperationCommission(
  ctx: PartnerContext,
  collaboratorId: string,
  payableId: string,
  db: Queryable = defaultPool,
): Promise<{ paid: boolean; payable_id: string }> {
  const allowed = await db.query(
    `SELECT 1
       FROM finance.partner_staff_commission_periods period
       JOIN finance.partner_payables payable
         ON payable.environment=period.environment AND payable.id=period.payable_id
      WHERE period.environment=$1 AND period.unit_id=$2 AND period.token_id=$3
        AND period.payable_id=$4 AND payable.status='open' AND payable.deleted_at IS NULL`,
    [ctx.environment, ctx.unitId, collaboratorId, payableId],
  );
  if (allowed.rowCount !== 1) throw new Error('commission_payment_not_available');
  const result = await settlePartnerPayable(ctx, payableId, {
    paid_at: new Date().toISOString(), payment_method: 'other', force_duplicate: false,
  });
  return { paid: result.paid, payable_id: result.payable_id };
}
