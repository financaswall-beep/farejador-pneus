import type { Pool } from 'pg';
import type { CaixaSalesDay } from './sales.js';

interface WeeklySalesRow {
  date: string;
  sales_count: number;
  revenue: string;
  average_ticket: string;
  items_quantity: string;
  pix_revenue: string;
  card_revenue: string;
  cash_revenue: string;
  other_revenue: string;
}

export async function getCaixaWeeklySeries(
  environment: 'prod' | 'test',
  weekOffset: number,
  dbPool: Pool,
): Promise<CaixaSalesDay[]> {
  const result = await dbPool.query<WeeklySalesRow>(
    `WITH bounds AS (
       SELECT (date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')
         + ($2::int * INTERVAL '7 days'))::date AS week_start
     ), days AS (
       SELECT generate_series(
         bounds.week_start,
         bounds.week_start + 6,
         INTERVAL '1 day'
       )::date AS day
         FROM bounds
     ), matriz_sales AS (
       SELECT (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS sale_day,
              o.total_amount,o.payment_method,
              COALESCE(items.items_quantity,0)::int AS items_quantity
         FROM commerce.orders o
         JOIN core.units u
           ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
         CROSS JOIN bounds
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(oi.quantity),0)::int AS items_quantity
             FROM commerce.order_items oi
            WHERE oi.order_id=o.id AND oi.environment=o.environment
         ) items ON true
        WHERE o.environment=$1 AND o.status<>'cancelled'
          AND o.created_at>=(bounds.week_start::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND o.created_at<((bounds.week_start + 7)::timestamp AT TIME ZONE 'America/Sao_Paulo')
     )
     SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
            COUNT(matriz_sales.sale_day)::int AS sales_count,
            COALESCE(SUM(matriz_sales.total_amount),0)::text AS revenue,
            COALESCE(AVG(matriz_sales.total_amount),0)::text AS average_ticket,
            COALESCE(SUM(matriz_sales.items_quantity),0)::text AS items_quantity,
            COALESCE(SUM(matriz_sales.total_amount) FILTER (
              WHERE lower(COALESCE(matriz_sales.payment_method,''))='pix'
            ),0)::text AS pix_revenue,
            COALESCE(SUM(matriz_sales.total_amount) FILTER (
              WHERE lower(COALESCE(matriz_sales.payment_method,'')) LIKE '%cart%'
                OR lower(COALESCE(matriz_sales.payment_method,'')) IN ('credito','crédito','debito','débito')
            ),0)::text AS card_revenue,
            COALESCE(SUM(matriz_sales.total_amount) FILTER (
              WHERE lower(COALESCE(matriz_sales.payment_method,'')) LIKE '%dinheiro%'
            ),0)::text AS cash_revenue,
            COALESCE(SUM(matriz_sales.total_amount) FILTER (
              WHERE lower(COALESCE(matriz_sales.payment_method,''))<>'pix'
                AND lower(COALESCE(matriz_sales.payment_method,'')) NOT LIKE '%cart%'
                AND lower(COALESCE(matriz_sales.payment_method,'')) NOT IN ('credito','crédito','debito','débito')
                AND lower(COALESCE(matriz_sales.payment_method,'')) NOT LIKE '%dinheiro%'
            ),0)::text AS other_revenue
       FROM days
       LEFT JOIN matriz_sales ON matriz_sales.sale_day=days.day
      GROUP BY days.day
      ORDER BY days.day`,
    [environment, weekOffset],
  );

  return result.rows.map((row) => ({
    date: row.date,
    sales_count: row.sales_count,
    revenue: Number(row.revenue),
    average_ticket: Number(row.average_ticket),
    items_quantity: Number(row.items_quantity),
    pix_revenue: Number(row.pix_revenue),
    card_revenue: Number(row.card_revenue),
    cash_revenue: Number(row.cash_revenue),
    other_revenue: Number(row.other_revenue),
  }));
}
