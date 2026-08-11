import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import {
  summarizeOperationDays,
  type OperationMySalesPayload,
  type OperationSaleDetail,
  type OperationSaleListItem,
  type OperationSalesDay,
} from '../../operation/my-sales-types.js';

type Environment = 'prod' | 'test';

const commissionSql = `CASE
  WHEN o.status='cancelled' THEN 0
  WHEN cr.active AND cr.kind='percent' AND cr.basis='margin'
    THEN round(items.margin*cr.value/100.0,2)
  WHEN cr.active AND cr.kind='percent' AND cr.basis='revenue'
    THEN round(o.total_amount*cr.value/100.0,2)
  WHEN cr.active AND cr.kind='fixed' AND cr.basis='sale' THEN cr.value
  ELSE 0 END`;

const itemLateralSql = `LEFT JOIN LATERAL (
  SELECT COALESCE(sum(oi.quantity),0)::int AS quantity,
         COALESCE(sum((oi.unit_price-oi.matriz_unit_cost)*oi.quantity-oi.discount_amount)
           FILTER (WHERE oi.matriz_unit_cost IS NOT NULL),0) AS margin,
         COALESCE((array_agg(COALESCE(p.product_name,'Item') ORDER BY oi.created_at,oi.id))[1],'Item') AS first_name,
         count(*)::int AS lines,
         CASE WHEN bool_and(p.product_type='tire') THEN 'pneu'
              WHEN bool_and(p.product_type='service') THEN 'servico'
              ELSE 'item' END AS item_kind
    FROM commerce.order_items oi
    LEFT JOIN commerce.products p ON p.id=oi.product_id AND p.environment=oi.environment
   WHERE oi.order_id=o.id AND oi.environment=o.environment
) items ON true`;

const ruleLateralSql = `LEFT JOIN LATERAL (
  SELECT r.kind,r.basis,r.value,r.active
    FROM network.matriz_collaborator_commission_rules r
   WHERE r.environment=o.environment AND r.collaborator_id=o.seller_collaborator_id
     AND r.starts_on <= (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date
   ORDER BY r.starts_on DESC LIMIT 1
) cr ON true`;

function itemSummary(firstName: string, lines: number): string {
  return lines > 1 ? `${firstName} + ${lines - 1} item(ns)` : firstName;
}

function listRow(row: any): OperationSaleListItem {
  return {
    order_id: row.order_id,
    order_number: row.order_number ?? `#${String(row.order_id).slice(0, 8)}`,
    payment_method: row.payment_method,
    total_amount: Number(row.total_amount),
    status: row.status,
    created_at: row.created_at,
    items_quantity: Number(row.items_quantity),
    item_kind: row.item_kind ?? 'item',
    item_summary: itemSummary(row.first_name ?? 'Item', Number(row.item_lines ?? 0)),
    commission_kind: row.commission_kind,
    commission_basis: row.commission_basis,
    commission_value: Number(row.commission_value ?? 0),
    commission_amount: Number(row.commission_amount ?? 0),
    commission_status: row.status === 'cancelled'
      ? 'reversed' : (row.payroll_status === 'paid' ? 'paid' : 'receivable'),
  };
}

export async function getCaixaMySales(
  environment: Environment,
  collaboratorId: string,
  weekOffset: number,
  db: Pool = defaultPool,
): Promise<OperationMySalesPayload> {
  const [daysResult, salesResult] = await Promise.all([
    db.query<any>(
      `WITH bounds AS (
         SELECT (date_trunc('week',now() AT TIME ZONE 'America/Sao_Paulo')
           + ($3::int*interval '7 days'))::date AS week_start
       ), days AS (
         SELECT generate_series(week_start,week_start+6,interval '1 day')::date AS sale_date FROM bounds
       ), own_sales AS (
         SELECT (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date sale_day,
                o.total_amount,items.quantity,${commissionSql} AS commission_amount
           FROM commerce.orders o
           JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
           CROSS JOIN bounds
           ${itemLateralSql}
           ${ruleLateralSql}
          WHERE o.environment=$1 AND o.seller_collaborator_id=$2 AND o.status<>'cancelled'
            AND o.created_at>=(week_start::timestamp AT TIME ZONE 'America/Sao_Paulo')
            AND o.created_at<((week_start+7)::timestamp AT TIME ZONE 'America/Sao_Paulo')
       )
       SELECT to_char(days.sale_date,'YYYY-MM-DD') date,count(own_sales.sale_day)::int sales_count,
              COALESCE(sum(own_sales.total_amount),0)::text revenue,
              COALESCE(sum(own_sales.quantity),0)::int items_quantity,
              COALESCE(sum(own_sales.commission_amount),0)::text commission_amount
         FROM days LEFT JOIN own_sales ON own_sales.sale_day=days.sale_date
        GROUP BY days.sale_date ORDER BY days.sale_date`,
      [environment, collaboratorId, weekOffset],
    ),
    db.query<any>(
      `WITH bounds AS (
         SELECT (date_trunc('week',now() AT TIME ZONE 'America/Sao_Paulo')
           + ($3::int*interval '7 days'))::date AS week_start
       )
       SELECT o.id order_id,o.order_number,o.payment_method,o.total_amount::text,o.status,o.created_at,
              items.quantity items_quantity,items.item_kind,items.first_name,items.lines item_lines,
              cr.kind commission_kind,cr.basis commission_basis,COALESCE(cr.value,0)::text commission_value,
              (${commissionSql})::text commission_amount,pi.payment_status payroll_status
         FROM commerce.orders o
         JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
         CROSS JOIN bounds
         ${itemLateralSql}
         ${ruleLateralSql}
         LEFT JOIN finance.matriz_payroll_periods pp
           ON pp.environment=o.environment
          AND pp.competence=date_trunc('month',o.created_at AT TIME ZONE 'America/Sao_Paulo')::date
         LEFT JOIN finance.matriz_payroll_items pi
           ON pi.payroll_period_id=pp.id AND pi.collaborator_id=o.seller_collaborator_id
        WHERE o.environment=$1 AND o.seller_collaborator_id=$2
          AND o.created_at>=(week_start::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND o.created_at<((week_start+7)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        ORDER BY o.created_at DESC,o.id DESC LIMIT 40`,
      [environment, collaboratorId, weekOffset],
    ),
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

export async function getCaixaMySaleDetail(
  environment: Environment,
  collaboratorId: string,
  orderId: string,
  db: Pool = defaultPool,
): Promise<OperationSaleDetail | null> {
  const result = await db.query<any>(
    `SELECT o.id order_id,o.order_number,o.payment_method,o.total_amount::text,o.status,o.created_at,
            mc.display_name seller_name,items.quantity items_quantity,items.item_kind,
            items.first_name,items.lines item_lines,cr.kind commission_kind,cr.basis commission_basis,
            COALESCE(cr.value,0)::text commission_value,(${commissionSql})::text commission_amount,
            pi.payment_status payroll_status,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'product_name',COALESCE(p.product_name,'Item'),'quantity',oi.quantity,
              'unit_price',oi.unit_price,'discount_amount',oi.discount_amount,
              'line_total',oi.quantity*oi.unit_price-oi.discount_amount,
              'image_url',(SELECT pm.media_url FROM commerce.product_media pm
                WHERE pm.environment=oi.environment AND pm.product_id=oi.product_id
                  AND pm.media_type='image' ORDER BY pm.display_order,pm.id LIMIT 1)
            ) ORDER BY oi.created_at,oi.id) FROM commerce.order_items oi
              LEFT JOIN commerce.products p ON p.id=oi.product_id AND p.environment=oi.environment
             WHERE oi.order_id=o.id AND oi.environment=o.environment),'[]'::jsonb) items_json
       FROM commerce.orders o
       JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
       JOIN network.matriz_collaborators mc
         ON mc.id=o.seller_collaborator_id AND mc.environment=o.environment
       ${itemLateralSql}
       ${ruleLateralSql}
       LEFT JOIN finance.matriz_payroll_periods pp ON pp.environment=o.environment
        AND pp.competence=date_trunc('month',o.created_at AT TIME ZONE 'America/Sao_Paulo')::date
       LEFT JOIN finance.matriz_payroll_items pi
         ON pi.payroll_period_id=pp.id AND pi.collaborator_id=o.seller_collaborator_id
      WHERE o.environment=$1 AND o.seller_collaborator_id=$2 AND o.id=$3 LIMIT 1`,
    [environment, collaboratorId, orderId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...listRow(row),
    seller_name: row.seller_name,
    items: (row.items_json ?? []).map((item: any) => ({
      product_name: item.product_name,
      quantity: Number(item.quantity),
      unit_price: Number(item.unit_price),
      discount_amount: Number(item.discount_amount),
      line_total: Number(item.line_total),
      image_url: item.image_url ?? null,
    })),
  };
}
