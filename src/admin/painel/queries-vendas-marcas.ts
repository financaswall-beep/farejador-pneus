import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import type { SalesPeriod } from './queries-galpao.js';

interface BrandSalesSourceRow {
  brand: string;
  channel: 'varejo' | 'atacado';
  units: number | string;
  revenue: number | string;
}

export interface BrandSalesRankingRow {
  rank: number;
  brand: string;
  units: number;
  revenue: number;
  retail_units: number;
  wholesale_units: number;
  retail_revenue: number;
  wholesale_revenue: number;
  share_percent: number;
}

export interface BrandSalesRanking {
  period: SalesPeriod;
  summary: { brands: number; units: number; revenue: number };
  rows: BrandSalesRankingRow[];
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Ranking comercial da Matriz. Considera somente vendas confirmadas de pneus. */
export async function getSalesBrandRanking(
  period: SalesPeriod = '30d',
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<BrandSalesRanking> {
  const result = await dbPool.query<BrandSalesSourceRow>(
    `WITH bounds AS (
       SELECT CASE $2::text
         WHEN 'today' THEN date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')
                           AT TIME ZONE 'America/Sao_Paulo'
         WHEN '7d' THEN (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')
                           - INTERVAL '6 days') AT TIME ZONE 'America/Sao_Paulo'
         WHEN '30d' THEN (date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')
                            - INTERVAL '29 days') AT TIME ZONE 'America/Sao_Paulo'
         WHEN 'mes' THEN date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')
                         AT TIME ZONE 'America/Sao_Paulo'
         ELSE NULL::timestamptz
       END AS starts_at
     ), brand_lines AS (
       SELECT p.brand,'varejo'::text AS channel,
              SUM(oi.quantity)::numeric AS units,
              SUM(oi.quantity*oi.unit_price-oi.discount_amount)::numeric AS revenue
         FROM commerce.orders o
         JOIN core.units u
           ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
         JOIN commerce.order_items oi
           ON oi.order_id=o.id AND oi.environment=o.environment
         JOIN commerce.products p
           ON p.id=oi.product_id AND p.environment=oi.environment
        CROSS JOIN bounds b
        WHERE o.environment=$1
          AND o.status IN ('confirmed','paid','delivered')
          AND p.product_type='tire'
          AND p.brand IS NOT NULL AND btrim(p.brand)<>''
          AND lower(btrim(p.brand))<>'sem marca'
          AND (b.starts_at IS NULL OR o.created_at>=b.starts_at)
        GROUP BY p.brand
       UNION ALL
       SELECT i.brand,'atacado'::text AS channel,
              SUM(i.quantity)::numeric AS units,
              SUM(i.line_total)::numeric AS revenue
         FROM commerce.wholesale_orders o
         JOIN commerce.wholesale_order_items i
           ON i.order_id=o.id AND i.environment=o.environment
        CROSS JOIN bounds b
        WHERE o.environment=$1 AND o.status='confirmed'
          AND i.brand IS NOT NULL AND btrim(i.brand)<>''
          AND lower(btrim(i.brand))<>'sem marca'
          AND (b.starts_at IS NULL OR o.sold_at>=b.starts_at)
        GROUP BY i.brand
     )
     SELECT brand,channel,units,revenue FROM brand_lines`,
    [environment, period],
  );

  const grouped = new Map<string, Omit<BrandSalesRankingRow, 'rank' | 'share_percent'>>();
  for (const source of result.rows) {
    const brand = canonicalCatalogBrand(source.brand);
    if (!brand) continue;
    const row = grouped.get(brand) ?? {
      brand, units: 0, revenue: 0, retail_units: 0, wholesale_units: 0,
      retail_revenue: 0, wholesale_revenue: 0,
    };
    const units = Number(source.units || 0);
    const revenue = Number(source.revenue || 0);
    row.units += units;
    row.revenue += revenue;
    if (source.channel === 'varejo') {
      row.retail_units += units;
      row.retail_revenue += revenue;
    } else {
      row.wholesale_units += units;
      row.wholesale_revenue += revenue;
    }
    grouped.set(brand, row);
  }

  const all = [...grouped.values()].map((row) => ({
    ...row,
    revenue: money(row.revenue),
    retail_revenue: money(row.retail_revenue),
    wholesale_revenue: money(row.wholesale_revenue),
  })).sort((a, b) => b.units - a.units || b.revenue - a.revenue
    || a.brand.localeCompare(b.brand, 'pt-BR'));
  const units = all.reduce((sum, row) => sum + row.units, 0);
  const revenue = money(all.reduce((sum, row) => sum + row.revenue, 0));
  return {
    period,
    summary: { brands: all.length, units, revenue },
    rows: all.slice(0, 5).map((row, index) => ({
      ...row,
      rank: index + 1,
      share_percent: units > 0 ? Math.round((row.units / units) * 1000) / 10 : 0,
    })),
  };
}
