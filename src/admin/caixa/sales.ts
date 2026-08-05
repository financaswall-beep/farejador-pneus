import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';

export type CaixaSalesPeriod = 'today' | '7d' | '30d';

export interface CaixaSalesSummary {
  sales_count: number;
  revenue: number;
  average_ticket: number;
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
  summary: CaixaSalesSummary;
  daily_series: CaixaSalesDay[];
  sales: CaixaSaleListItem[];
}

export interface CaixaSalesDay {
  date: string;
  sales_count: number;
  revenue: number;
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
  dbPool: Pool = defaultPool,
): Promise<CaixaSalesPayload> {
  const periodStart = PERIOD_START[period];
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

  const [summaryResult, salesResult, dailySeriesResult] = await Promise.all([
    dbPool.query<{
      sales_count: number;
      revenue: string;
      average_ticket: string;
    }>(
      `SELECT COUNT(*) FILTER (WHERE o.status<>'cancelled')::int AS sales_count,
              COALESCE(SUM(o.total_amount) FILTER (WHERE o.status<>'cancelled'),0)::text AS revenue,
              COALESCE(AVG(o.total_amount) FILTER (WHERE o.status<>'cancelled'),0)::text AS average_ticket
         ${fromScope}
        WHERE o.environment=$1 AND o.created_at>=${periodStart}`,
      [environment],
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
        WHERE o.environment=$1 AND o.created_at>=${periodStart}
          AND ($2::text IS NULL
           OR o.order_number ILIKE $2 ESCAPE '\\'
           OR COALESCE(ct.name,'') ILIKE $2 ESCAPE '\\'
           OR COALESCE(cu.name,'') ILIKE $2 ESCAPE '\\')
        ORDER BY o.created_at DESC,o.id DESC
        LIMIT 40`,
      [environment, searchPattern],
    ),
    period === '7d'
      ? dbPool.query<{ date: string; sales_count: number; revenue: string }>(
          `WITH days AS (
             SELECT generate_series(
               (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '6 days')::date,
               (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo'))::date,
               INTERVAL '1 day'
             )::date AS day
           ), matriz_sales AS (
             SELECT (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS sale_day,
                    o.total_amount
               FROM commerce.orders o
               JOIN core.units u
                 ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
              WHERE o.environment=$1 AND o.status<>'cancelled'
                AND o.created_at>=${PERIOD_START['7d']}
           )
           SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
                  COUNT(matriz_sales.sale_day)::int AS sales_count,
                  COALESCE(SUM(matriz_sales.total_amount),0)::text AS revenue
             FROM days
             LEFT JOIN matriz_sales ON matriz_sales.sale_day=days.day
            GROUP BY days.day
            ORDER BY days.day`,
          [environment],
        )
      : Promise.resolve({ rows: [] as Array<{ date: string; sales_count: number; revenue: string }> }),
  ]);

  const summaryRow = summaryResult.rows[0];
  return {
    period,
    summary: {
      sales_count: summaryRow?.sales_count ?? 0,
      revenue: Number(summaryRow?.revenue ?? 0),
      average_ticket: Number(summaryRow?.average_ticket ?? 0),
    },
    daily_series: dailySeriesResult.rows.map((row) => ({
      date: row.date,
      sales_count: row.sales_count,
      revenue: Number(row.revenue),
    })),
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
