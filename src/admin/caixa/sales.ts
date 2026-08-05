import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { getCaixaWeeklySeries } from './sales-weekly.js';

export type CaixaSalesPeriod = 'today' | '7d' | '30d';

export interface CaixaSalesSummary {
  sales_count: number;
  revenue: number;
  average_ticket: number;
  items_quantity: number;
  pix_revenue: number;
  card_revenue: number;
  cash_revenue: number;
  other_revenue: number;
}

export interface CaixaSaleListItem {
  order_id: string;
  order_number: string;
  customer_name: string;
  payment_method: string | null;
  total_amount: number;
  status: string;
  created_at: string;
  items_quantity: number;
  item_kind: 'pneu' | 'serviço' | 'item';
}

export interface CaixaSalesPayload {
  period: CaixaSalesPeriod;
  week_offset: number;
  summary: CaixaSalesSummary;
  daily_series: CaixaSalesDay[];
  sales: CaixaSaleListItem[];
}

export interface CaixaSalesDay extends CaixaSalesSummary {
  date: string;
}

export interface CaixaSaleReceipt {
  order_id: string;
  order_number: string;
  customer_name: string;
  payment_method: string | null;
  total_amount: number;
  status: string;
  created_at: string;
  seller_name: string | null;
  items: Array<{
    product_name: string;
    quantity: number;
    unit_price: number;
    discount_amount: number;
    line_total: number;
  }>;
}

const PERIOD_START: Record<CaixaSalesPeriod, string> = {
  today: `(date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`,
  '7d': `((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '6 days') AT TIME ZONE 'America/Sao_Paulo')`,
  '30d': `((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '29 days') AT TIME ZONE 'America/Sao_Paulo')`,
};

const paymentRevenueSql = `
  COALESCE(SUM(o.total_amount) FILTER (
    WHERE o.status<>'cancelled' AND lower(COALESCE(o.payment_method,''))='pix'
  ),0)::text AS pix_revenue,
  COALESCE(SUM(o.total_amount) FILTER (
    WHERE o.status<>'cancelled' AND (
      lower(COALESCE(o.payment_method,'')) LIKE '%cart%'
      OR lower(COALESCE(o.payment_method,'')) IN ('credito','crédito','debito','débito')
    )
  ),0)::text AS card_revenue,
  COALESCE(SUM(o.total_amount) FILTER (
    WHERE o.status<>'cancelled' AND lower(COALESCE(o.payment_method,'')) LIKE '%dinheiro%'
  ),0)::text AS cash_revenue,
  COALESCE(SUM(o.total_amount) FILTER (
    WHERE o.status<>'cancelled'
      AND lower(COALESCE(o.payment_method,''))<>'pix'
      AND lower(COALESCE(o.payment_method,'')) NOT LIKE '%cart%'
      AND lower(COALESCE(o.payment_method,'')) NOT IN ('credito','crédito','debito','débito')
      AND lower(COALESCE(o.payment_method,'')) NOT LIKE '%dinheiro%'
  ),0)::text AS other_revenue`;

function weekStart(placeholder: string): string {
  return `((date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')
    + (${placeholder}::int * INTERVAL '7 days')) AT TIME ZONE 'America/Sao_Paulo')`;
}

function weekEnd(placeholder: string): string {
  return `((date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')
    + ((${placeholder}::int + 1) * INTERVAL '7 days')) AT TIME ZONE 'America/Sao_Paulo')`;
}

function timeScope(period: CaixaSalesPeriod, weekPlaceholder: string): string {
  if (period === '7d') {
    return `o.created_at>=${weekStart(weekPlaceholder)} AND o.created_at<${weekEnd(weekPlaceholder)}`;
  }
  return `o.created_at>=${PERIOD_START[period]}`;
}

function numberOf(value: string | number | null | undefined): number {
  return Number(value ?? 0);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Histórico operacional do varejo da Matriz. A unidade `main` é a mesma régua
 * usada pelo painel administrativo; cancelamentos aparecem na lista para
 * rastreabilidade, mas ficam fora dos indicadores.
 */
export async function getCaixaSales(
  environment: 'prod' | 'test',
  period: CaixaSalesPeriod,
  search = '',
  weekOffset = 0,
  dbPool: Pool = defaultPool,
): Promise<CaixaSalesPayload> {
  const normalizedSearch = search.trim().slice(0, 80);
  const searchPattern = normalizedSearch ? `%${escapeLike(normalizedSearch)}%` : null;
  const fromScope = `
    FROM commerce.orders o
    JOIN core.units u
      ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
    LEFT JOIN core.contacts ct
      ON ct.id=o.contact_id AND ct.environment=o.environment
    LEFT JOIN commerce.customers cu
      ON cu.id=o.customer_id AND cu.environment=o.environment`;

  const summaryArgs = period === '7d' ? [environment, weekOffset] : [environment];
  const salesArgs = period === '7d'
    ? [environment, searchPattern, weekOffset]
    : [environment, searchPattern];

  const [summaryResult, salesResult, dailySeriesResult] = await Promise.all([
    dbPool.query<{
      sales_count: number;
      revenue: string;
      average_ticket: string;
      items_quantity: string;
      pix_revenue: string;
      card_revenue: string;
      cash_revenue: string;
      other_revenue: string;
    }>(
      `SELECT COUNT(*) FILTER (WHERE o.status<>'cancelled')::int AS sales_count,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.status<>'cancelled'),0)::text AS revenue,
              COALESCE(AVG(o.total_amount) FILTER (WHERE o.status<>'cancelled'),0)::text AS average_ticket,
              COALESCE(SUM(summary_items.items_quantity) FILTER (WHERE o.status<>'cancelled'),0)::text AS items_quantity,
              ${paymentRevenueSql}
         ${fromScope}
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(oi.quantity),0)::int AS items_quantity
             FROM commerce.order_items oi
            WHERE oi.order_id=o.id AND oi.environment=o.environment
         ) summary_items ON true
        WHERE o.environment=$1 AND ${timeScope(period, '$2')}`,
      summaryArgs,
    ),
    dbPool.query<{
      order_id: string;
      order_number: string | null;
      customer_name: string;
      payment_method: string | null;
      total_amount: string;
      status: string;
      created_at: string;
      items_quantity: number;
      item_kind: 'pneu' | 'serviço' | 'item';
    }>(
      `SELECT o.id AS order_id, o.order_number,
              COALESCE(NULLIF(btrim(ct.name),''),NULLIF(btrim(cu.name),''),'Cliente Balcão') AS customer_name,
              o.payment_method,o.total_amount::text,o.status,o.created_at,
              COALESCE(items.items_quantity,0)::int AS items_quantity,
              COALESCE(items.item_kind,'item') AS item_kind
         ${fromScope}
         LEFT JOIN LATERAL (
           SELECT SUM(oi.quantity)::int AS items_quantity,
                  CASE WHEN bool_and(p.product_type='tire') THEN 'pneu'
                       WHEN bool_and(p.product_type='service') THEN 'serviço'
                       ELSE 'item' END AS item_kind
             FROM commerce.order_items oi
             LEFT JOIN commerce.products p
               ON p.id=oi.product_id AND p.environment=oi.environment
            WHERE oi.order_id=o.id AND oi.environment=o.environment
         ) items ON true
        WHERE o.environment=$1 AND ${timeScope(period, '$3')}
          AND ($2::text IS NULL
           OR o.order_number ILIKE $2 ESCAPE '\\'
           OR COALESCE(ct.name,'') ILIKE $2 ESCAPE '\\'
           OR COALESCE(cu.name,'') ILIKE $2 ESCAPE '\\')
        ORDER BY o.created_at DESC,o.id DESC
        LIMIT 40`,
      salesArgs,
    ),
    period === '7d'
      ? getCaixaWeeklySeries(environment, weekOffset, dbPool)
      : Promise.resolve([]),
  ]);

  const summaryRow = summaryResult.rows[0];
  return {
    period,
    week_offset: period === '7d' ? weekOffset : 0,
    summary: {
      sales_count: summaryRow?.sales_count ?? 0,
      revenue: numberOf(summaryRow?.revenue),
      average_ticket: numberOf(summaryRow?.average_ticket),
      items_quantity: numberOf(summaryRow?.items_quantity),
      pix_revenue: numberOf(summaryRow?.pix_revenue),
      card_revenue: numberOf(summaryRow?.card_revenue),
      cash_revenue: numberOf(summaryRow?.cash_revenue),
      other_revenue: numberOf(summaryRow?.other_revenue),
    },
    daily_series: dailySeriesResult,
    sales: salesResult.rows.map((row) => ({
      ...row,
      order_number: row.order_number ?? `#${row.order_id.slice(0, 8)}`,
      total_amount: Number(row.total_amount),
    })),
  };
}

export async function getCaixaSaleReceipt(
  environment: 'prod' | 'test',
  orderId: string,
  dbPool: Pool = defaultPool,
): Promise<CaixaSaleReceipt | null> {
  const result = await dbPool.query<{
    order_id: string;
    order_number: string | null;
    customer_name: string;
    payment_method: string | null;
    total_amount: string;
    status: string;
    created_at: string;
    seller_name: string | null;
    items: CaixaSaleReceipt['items'];
  }>(
    `SELECT o.id AS order_id,o.order_number,
            COALESCE(NULLIF(btrim(ct.name),''),NULLIF(btrim(cu.name),''),'Cliente Balcão') AS customer_name,
            o.payment_method,o.total_amount::text,o.status,o.created_at,
            COALESCE(mc.display_name,o.closed_by) AS seller_name,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'product_name',COALESCE(p.product_name,'Item'),
              'quantity',oi.quantity,
              'unit_price',oi.unit_price,
              'discount_amount',oi.discount_amount,
              'line_total',oi.quantity*oi.unit_price-oi.discount_amount
            ) ORDER BY oi.created_at,oi.id)
              FROM commerce.order_items oi
              LEFT JOIN commerce.products p
                ON p.id=oi.product_id AND p.environment=oi.environment
             WHERE oi.order_id=o.id AND oi.environment=o.environment),'[]'::jsonb) AS items
       FROM commerce.orders o
       JOIN core.units u
         ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
       LEFT JOIN core.contacts ct
         ON ct.id=o.contact_id AND ct.environment=o.environment
       LEFT JOIN commerce.customers cu
         ON cu.id=o.customer_id AND cu.environment=o.environment
       LEFT JOIN network.matriz_collaborators mc
         ON mc.id=o.seller_collaborator_id AND mc.environment=o.environment
      WHERE o.environment=$1 AND o.id=$2
      LIMIT 1`,
    [environment, orderId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    order_number: row.order_number ?? `#${row.order_id.slice(0, 8)}`,
    total_amount: Number(row.total_amount),
    items: row.items.map((item) => ({
      ...item,
      quantity: Number(item.quantity),
      unit_price: Number(item.unit_price),
      discount_amount: Number(item.discount_amount),
      line_total: Number(item.line_total),
    })),
  };
}
