import type { Pool } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import {
  summarizeOperationDays,
  type OperationMySalesPayload,
  type OperationSaleDetail,
  type OperationSaleListItem,
  type OperationSalesDay,
} from '../operation/my-sales-types.js';
import type { PartnerContext } from './auth.js';

const realizedSql = `po.status<>'cancelled' AND po.deleted_at IS NULL
  AND NOT (po.fulfillment_mode='delivery' AND po.delivery_status IS DISTINCT FROM 'delivered')
  AND NOT po.awaiting_pickup`;

const itemLateralSql = `LEFT JOIN LATERAL (
  SELECT COALESCE(sum(oi.quantity),0)::int AS quantity,
         COALESCE((array_agg(CASE
           WHEN oi.brand IS NOT NULL AND oi.tire_size IS NOT NULL THEN btrim(oi.brand||' '||oi.tire_size)
           WHEN oi.tire_size IS NOT NULL THEN oi.tire_size ELSE oi.item_name END
           ORDER BY oi.created_at,oi.id))[1],'Item') AS first_name,
         count(*)::int AS lines,
         CASE WHEN bool_and(COALESCE(oi.item_type,'pneu')='pneu') THEN 'pneu'
              WHEN bool_and(oi.item_type='servico') THEN 'servico'
              ELSE 'item' END AS item_kind
    FROM commerce.partner_order_items oi
   WHERE oi.order_id=po.id AND oi.environment=po.environment
) items ON true`;

function itemSummary(firstName: string, lines: number): string {
  return lines > 1 ? `${firstName} + ${lines - 1} item(ns)` : firstName;
}

function listRow(row: any): OperationSaleListItem {
  const reversed = row.status === 'cancelled' || row.commission_entry_status === 'reversed';
  return {
    order_id: row.order_id,
    order_number: `#${String(row.order_id).slice(0, 8).toUpperCase()}`,
    payment_method: row.payment_method,
    total_amount: Number(row.total_amount),
    status: row.status,
    created_at: row.created_at,
    items_quantity: Number(row.items_quantity),
    item_kind: row.item_kind ?? 'item',
    item_summary: itemSummary(row.first_name ?? 'Item', Number(row.item_lines ?? 0)),
    commission_kind: row.commission_kind,
    commission_basis: row.commission_kind === 'percent' ? 'revenue'
      : (row.commission_kind === 'fixed' ? 'sale' : null),
    commission_value: Number(row.commission_value ?? 0),
    commission_amount: Number(row.commission_amount ?? 0),
    commission_status: reversed ? 'reversed'
      : (row.payable_status === 'paid' ? 'paid' : 'receivable'),
  };
}

export async function getPartnerMySales(
  ctx: PartnerContext,
  weekOffset: number,
  db: Pool = defaultPool,
): Promise<OperationMySalesPayload> {
  const args = [ctx.environment, ctx.unitId, ctx.tokenId, weekOffset];
  const [daysResult, salesResult] = await Promise.all([
    db.query<any>(
      `WITH bounds AS (
         SELECT (date_trunc('week',now() AT TIME ZONE 'America/Sao_Paulo')
           + ($4::int*interval '7 days'))::date AS week_start
       ), days AS (
         SELECT generate_series(week_start,week_start+6,interval '1 day')::date AS sale_date FROM bounds
       ), own_sales AS (
         SELECT (po.created_at AT TIME ZONE 'America/Sao_Paulo')::date sale_day,
                po.total_amount,items.quantity,COALESCE(ce.commission_amount,0) commission_amount
           FROM commerce.partner_orders po CROSS JOIN bounds
           ${itemLateralSql}
           LEFT JOIN finance.partner_staff_commission_entries ce
             ON ce.environment=po.environment AND ce.partner_order_id=po.id
            AND ce.token_id=$3 AND ce.status='earned'
          WHERE po.environment=$1 AND po.unit_id=$2 AND po.operator_token_id=$3
            AND ${realizedSql}
            AND po.created_at>=(week_start::timestamp AT TIME ZONE 'America/Sao_Paulo')
            AND po.created_at<((week_start+7)::timestamp AT TIME ZONE 'America/Sao_Paulo')
       )
       SELECT to_char(days.sale_date,'YYYY-MM-DD') date,count(own_sales.sale_day)::int sales_count,
              COALESCE(sum(own_sales.total_amount),0)::text revenue,
              COALESCE(sum(own_sales.quantity),0)::int items_quantity,
              COALESCE(sum(own_sales.commission_amount),0)::text commission_amount
         FROM days LEFT JOIN own_sales ON own_sales.sale_day=days.sale_date
        GROUP BY days.sale_date ORDER BY days.sale_date`, args),
    db.query<any>(
      `WITH bounds AS (
         SELECT (date_trunc('week',now() AT TIME ZONE 'America/Sao_Paulo')
           + ($4::int*interval '7 days'))::date AS week_start
       )
       SELECT po.id order_id,po.payment_method,po.total_amount::text,po.status,po.created_at,
              items.quantity items_quantity,items.item_kind,items.first_name,items.lines item_lines,
              ce.commission_kind,ce.commission_value::text,
              COALESCE(ce.commission_amount,0)::text commission_amount,
              ce.status commission_entry_status,payable.status payable_status
         FROM commerce.partner_orders po CROSS JOIN bounds
         ${itemLateralSql}
         LEFT JOIN finance.partner_staff_commission_entries ce
           ON ce.environment=po.environment AND ce.partner_order_id=po.id AND ce.token_id=$3
         LEFT JOIN finance.partner_staff_commission_periods period ON period.id=ce.settlement_period_id
         LEFT JOIN finance.partner_payables payable ON payable.id=period.payable_id
        WHERE po.environment=$1 AND po.unit_id=$2 AND po.operator_token_id=$3
          AND po.deleted_at IS NULL
          AND po.created_at>=(week_start::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND po.created_at<((week_start+7)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        ORDER BY po.created_at DESC,po.id DESC LIMIT 40`, args),
  ]);
  const daily_series: OperationSalesDay[] = daysResult.rows.map((row: any) => {
    const salesCount = Number(row.sales_count);
    const revenue = Number(row.revenue);
    return {
      date: row.date,
      sales_count: salesCount,
      revenue,
      average_ticket: salesCount ? Math.round(revenue * 100 / salesCount) / 100 : 0,
      items_quantity: Number(row.items_quantity),
      commission_amount: Number(row.commission_amount),
    };
  });
  return {
    week_offset: weekOffset,
    summary: summarizeOperationDays(daily_series),
    daily_series,
    sales: salesResult.rows.map(listRow),
  };
}

export async function getPartnerMySaleDetail(
  ctx: PartnerContext,
  orderId: string,
  db: Pool = defaultPool,
): Promise<OperationSaleDetail | null> {
  const result = await db.query<any>(
    `SELECT po.id order_id,po.payment_method,po.total_amount::text,po.status,po.created_at,
            COALESCE(NULLIF(btrim(pat.label),''),pp.username) seller_name,
            items.quantity items_quantity,items.item_kind,items.first_name,items.lines item_lines,
            ce.commission_kind,ce.commission_value::text,
            COALESCE(ce.commission_amount,0)::text commission_amount,
            ce.status commission_entry_status,payable.status payable_status,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'product_name',CASE WHEN oi.brand IS NOT NULL AND oi.tire_size IS NOT NULL
                THEN btrim(oi.brand||' '||oi.tire_size) ELSE oi.item_name END,
              'quantity',oi.quantity,'reference_unit_price',oi.reference_unit_price,
              'unit_price',oi.unit_price,
              'discount_amount',oi.discount_amount,
              'line_total',oi.quantity*oi.unit_price-oi.discount_amount,
              'image_url',NULL
            ) ORDER BY oi.created_at,oi.id) FROM commerce.partner_order_items oi
             WHERE oi.order_id=po.id AND oi.environment=po.environment),'[]'::jsonb) items_json
       FROM commerce.partner_orders po
       JOIN network.partner_access_tokens pat
         ON pat.id=po.operator_token_id AND pat.environment=po.environment
       JOIN network.partner_people pp ON pp.id=pat.person_id AND pp.environment=pat.environment
       ${itemLateralSql}
       LEFT JOIN finance.partner_staff_commission_entries ce
         ON ce.environment=po.environment AND ce.partner_order_id=po.id AND ce.token_id=$3
       LEFT JOIN finance.partner_staff_commission_periods period ON period.id=ce.settlement_period_id
       LEFT JOIN finance.partner_payables payable ON payable.id=period.payable_id
      WHERE po.environment=$1 AND po.unit_id=$2 AND po.operator_token_id=$3
        AND po.id=$4 AND po.deleted_at IS NULL LIMIT 1`,
    [ctx.environment, ctx.unitId, ctx.tokenId, orderId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...listRow(row),
    seller_name: row.seller_name,
    items: (row.items_json ?? []).map((item: any) => ({
      product_name: item.product_name,
      quantity: Number(item.quantity),
      reference_unit_price: Number(item.reference_unit_price),
      unit_price: Number(item.unit_price),
      discount_amount: Number(item.discount_amount),
      line_total: Number(item.line_total),
      image_url: item.image_url ?? null,
    })),
  };
}
