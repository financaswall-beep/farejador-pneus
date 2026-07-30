import { pool } from '../persistence/db.js';
import type { PartnerContext } from './auth.js';
import type { PartnerCommissionConfig } from './commission.js';

export interface PartnerCommissionTeamRow {
  token_id: string;
  label: string | null;
  username: string | null;
  finalized_sales: number;
  gross_sales: number;
  commission_kind: 'percent' | 'fixed' | null;
  commission_value: number;
  commission_active: boolean;
  commission_amount: number;
}

export interface PartnerMyPerformanceSale {
  order_id: string;
  created_at: string;
  canal: 'balcao' | '2w' | 'ajuste';
  fulfillment_mode: string;
  status: string;
  amount: number;
  commission_amount: number;
}

export interface PartnerMyPerformance {
  finalized_sales: number;
  gross_sales: number;
  commission_kind: 'percent' | 'fixed' | null;
  commission_value: number;
  commission_active: boolean;
  commission_amount: number;
  sales: PartnerMyPerformanceSale[];
}

/** Livro congelado da equipe no mes corrente, incluindo estornos posteriores. */
export async function getPartnerCommissionTeam(
  ctx: PartnerContext,
): Promise<{ rows: PartnerCommissionTeamRow[]; total_commission: number }> {
  const res = await pool.query<{
    token_id: string; label: string | null; username: string | null;
    finalized_sales: string; gross_sales: string;
    commission_kind: 'percent' | 'fixed' | null; commission_value: string;
    commission_active: boolean; commission_amount: string;
  }>(
    `WITH mb AS (
       SELECT date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date
         AS month_start
     ),
     earned AS (
       SELECT ce.token_id,count(*)::int finalized_sales,
              COALESCE(sum(ce.gross_amount),0)::numeric gross_sales,
              COALESCE(sum(ce.commission_amount),0)::numeric commission_amount
         FROM finance.partner_staff_commission_entries ce CROSS JOIN mb
        WHERE ce.environment=$1 AND ce.unit_id=$2 AND ce.status='earned'
          AND ce.competence_month=mb.month_start
        GROUP BY ce.token_id
     ),
     adjustments AS (
       SELECT ca.token_id,COALESCE(sum(ca.amount),0)::numeric amount
         FROM finance.partner_staff_commission_adjustments ca CROSS JOIN mb
        WHERE ca.environment=$1 AND ca.unit_id=$2
          AND ca.competence_month=mb.month_start
        GROUP BY ca.token_id
     )
     SELECT pat.id AS token_id,pat.label,pat.login_username AS username,
            COALESCE(e.finalized_sales,0)::int AS finalized_sales,
            COALESCE(e.gross_sales,0)::numeric AS gross_sales,
            cfg.kind AS commission_kind,
            COALESCE(cfg.value,0)::numeric AS commission_value,
            COALESCE(cfg.active,false) AS commission_active,
            (COALESCE(e.commission_amount,0)
              + COALESCE(a.amount,0))::numeric AS commission_amount
       FROM network.partner_access_tokens pat
       LEFT JOIN earned e ON e.token_id=pat.id
       LEFT JOIN adjustments a ON a.token_id=pat.id
       LEFT JOIN network.partner_token_commission cfg ON cfg.token_id=pat.id
      WHERE pat.environment=$1 AND pat.partner_unit_id=$3
        AND pat.role='funcionario'
        AND (pat.revoked_at IS NULL OR e.token_id IS NOT NULL OR a.token_id IS NOT NULL)
      ORDER BY commission_amount DESC,username ASC`,
    [ctx.environment, ctx.unitId, ctx.partnerUnitId],
  );
  const rows: PartnerCommissionTeamRow[] = res.rows.map((row) => ({
    token_id: row.token_id,
    label: row.label,
    username: row.username,
    finalized_sales: Number(row.finalized_sales),
    gross_sales: Number(row.gross_sales),
    commission_kind: row.commission_kind,
    commission_value: Number(row.commission_value),
    commission_active: row.commission_active,
    commission_amount: Number(row.commission_amount),
  }));
  const total_commission = Math.round(
    rows.reduce((sum, row) => sum + row.commission_amount, 0) * 100,
  ) / 100;
  return { rows, total_commission };
}

/** Desempenho do login atual; nunca aceita token de outra pessoa. */
export async function getPartnerMyPerformance(
  ctx: PartnerContext,
): Promise<PartnerMyPerformance> {
  const cfgRes = await pool.query<{
    kind: 'percent' | 'fixed'; value: string; active: boolean;
  }>(
    `SELECT kind,value,active FROM network.partner_token_commission
      WHERE token_id=$1 AND environment=$2`,
    [ctx.tokenId, ctx.environment],
  );
  const cfgRow = cfgRes.rows[0];
  const cfg: PartnerCommissionConfig = cfgRow
    ? { kind: cfgRow.kind, value: Number(cfgRow.value), active: cfgRow.active }
    : { kind: 'percent', value: 0, active: false };

  const salesRes = await pool.query<{
    order_id: string; created_at: string; source_tag: string | null;
    fulfillment_mode: string; status: string; amount: string;
    commission_amount: string; is_adjustment: boolean;
  }>(
    `WITH mb AS (
       SELECT date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date
         AS month_start
     )
     SELECT ce.partner_order_id::text AS order_id,ce.realized_at AS created_at,
            po.source_tag,po.fulfillment_mode,po.status,
            ce.gross_amount::numeric AS amount,
            ce.commission_amount::numeric AS commission_amount,
            false AS is_adjustment
       FROM finance.partner_staff_commission_entries ce
       JOIN commerce.partner_orders po
         ON po.environment=ce.environment AND po.id=ce.partner_order_id
       CROSS JOIN mb
      WHERE ce.environment=$1 AND ce.unit_id=$2 AND ce.token_id=$3
        AND ce.status='earned' AND ce.competence_month=mb.month_start
     UNION ALL
     SELECT 'adjustment:'||ca.id::text,ca.occurred_at,po.source_tag,
            'adjustment','reversed',0::numeric,ca.amount::numeric,true
       FROM finance.partner_staff_commission_adjustments ca
       JOIN finance.partner_staff_commission_entries ce
         ON ce.id=ca.commission_entry_id
       JOIN commerce.partner_orders po
         ON po.environment=ce.environment AND po.id=ce.partner_order_id
       CROSS JOIN mb
      WHERE ca.environment=$1 AND ca.unit_id=$2 AND ca.token_id=$3
        AND ca.competence_month=mb.month_start
      ORDER BY created_at DESC
      LIMIT 200`,
    [ctx.environment, ctx.unitId, ctx.tokenId],
  );

  const sales: PartnerMyPerformanceSale[] = salesRes.rows.map((row) => ({
    order_id: row.order_id,
    created_at: row.created_at,
    canal: row.is_adjustment ? 'ajuste' : (row.source_tag === '2w' ? '2w' : 'balcao'),
    fulfillment_mode: row.fulfillment_mode,
    status: row.status,
    amount: Number(row.amount),
    commission_amount: Number(row.commission_amount),
  }));
  const gross_sales = sales.reduce(
    (sum, sale) => sum + Math.round(sale.amount * 100), 0,
  ) / 100;
  const commission_amount = sales.reduce(
    (sum, sale) => sum + Math.round(sale.commission_amount * 100), 0,
  ) / 100;
  return {
    finalized_sales: sales.filter((sale) => sale.canal !== 'ajuste').length,
    gross_sales,
    commission_kind: cfg.active ? cfg.kind : null,
    commission_value: cfg.value,
    commission_active: cfg.active,
    commission_amount,
    sales,
  };
}
