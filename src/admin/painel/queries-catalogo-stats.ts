import type { Pool } from 'pg';

interface Counts { units: number; total: number }
interface Week extends Counts { percent: number | null }
interface BasketItem { label: string; orders: number }

export interface CatalogProductStats {
  weeks: Week[];
  share: Week & { delta_pp: number | null };
  basket: { orders: number; items: BasketItem[] };
  discount: { eligible_orders: number; orders_without_discount: number; percent: number | null; unknown_orders: number };
}

interface StatsRow {
  periods: Counts[];
  orders: number;
  items: BasketItem[];
  eligible_orders: number;
  orders_without_discount: number;
}

function totals(weeks: Counts[]): Counts {
  return weeks.reduce((sum, week) => ({ units: sum.units + week.units, total: sum.total + week.total }), { units: 0, total: 0 });
}

function percent(units: number, total: number): number | null {
  return total > 0 ? Math.round(1000 * units / total) / 10 : null;
}

export async function getCatalogProductStats(
  db: Pool, environment: string, productId: string,
): Promise<CatalogProductStats | null> {
  const result = await db.query<StatsRow>(`
    WITH target AS (
      SELECT p.id, p.tire_condition, s.vehicle_type, NULLIF(commerce.catalog_measure_identity(s.tire_size), '') AS measure
      FROM commerce.products p
      LEFT JOIN commerce.tire_specs s ON s.environment=p.environment AND s.product_id=p.id
      WHERE p.environment=$1 AND p.id=$2 AND p.product_type='tire' AND NOT p.partner_generic AND p.deleted_at IS NULL
    ), bounds AS (
      SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - 55 AS first_day
    ), retail_orders AS (
      SELECT o.id, ((o.created_at AT TIME ZONE 'America/Sao_Paulo')::date - b.first_day) / 7 AS week
      FROM commerce.orders o
      JOIN core.units u ON u.environment=o.environment AND u.id=o.unit_id AND u.slug='main'
      CROSS JOIN bounds b
      WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.status IN ('confirmed','paid','delivered')
        AND o.created_at >= (b.first_day::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND o.created_at <= CURRENT_TIMESTAMP
    ), weekly_units AS (
      SELECT o.week, COALESCE(sum(i.quantity) FILTER (WHERE i.product_id=t.id), 0) AS units, sum(i.quantity) AS total
      FROM target t
      JOIN commerce.tire_specs peer ON peer.environment=$1 AND commerce.catalog_measure_identity(peer.tire_size)=t.measure
      JOIN commerce.products p ON p.environment=peer.environment AND p.id=peer.product_id
        AND p.product_type='tire' AND NOT p.partner_generic
      JOIN commerce.order_items i ON i.environment=p.environment AND i.product_id=p.id
        AND i.tire_condition=t.tire_condition AND i.vehicle_type=t.vehicle_type
      JOIN retail_orders o ON o.id=i.order_id
      GROUP BY o.week
    ), selected_lines AS (
      SELECT i.order_id, i.created_at, i.quantity, i.unit_price, i.discount_amount, i.reference_unit_price
      FROM target t
      JOIN commerce.order_items i ON i.product_id=t.id AND i.environment=$1
      JOIN retail_orders o ON o.id=i.order_id AND o.week>=4
    ), selected_orders AS (
      SELECT DISTINCT order_id FROM selected_lines
    ), basket_counts AS (
      SELECT p.id, p.product_code, p.product_name, count(DISTINCT i.order_id)::int AS orders
      FROM selected_orders o
      JOIN commerce.order_items i ON i.environment=$1 AND i.order_id=o.order_id AND i.product_id<>$2
      JOIN commerce.products p ON p.environment=i.environment AND p.id=i.product_id AND NOT p.partner_generic
      GROUP BY p.id
    ), basket AS (
      SELECT id, orders, CASE WHEN count(*) OVER (PARTITION BY product_name)>1
                              THEN product_name || ' · ' || product_code ELSE product_name END AS label
      FROM basket_counts
    ), line_prices AS (
      SELECT i.order_id,
        CASE WHEN i.discount_amount>0 THEN true
             WHEN i.reference_unit_price>0 AND i.reference_unit_price<>i.unit_price
               THEN i.unit_price<i.reference_unit_price
             WHEN price.amount IS NOT NULL THEN i.quantity*i.unit_price-i.discount_amount < i.quantity*price.amount
        END AS discounted
      FROM selected_lines i
      -- Legacy and non-PDV rows may copy the negotiated price to reference_unit_price.
      -- Where they coincide, verify against the independent price at item capture, including backdated orders.
      LEFT JOIN LATERAL (
        SELECT pp.price_amount AS amount FROM commerce.matriz_product_prices pp
        WHERE pp.environment=$1 AND pp.product_id=$2 AND pp.currency='BRL'
          AND pp.valid_from<=i.created_at AND (pp.valid_until IS NULL OR pp.valid_until>i.created_at)
        ORDER BY pp.valid_from DESC,pp.id DESC LIMIT 1
      ) price ON true
    ), order_discounts AS (
      SELECT order_id, CASE WHEN bool_or(discounted) THEN true
                            WHEN count(discounted)=count(*) THEN false END AS discounted
      FROM line_prices GROUP BY order_id
    )
    SELECT (SELECT json_agg(json_build_object('units',COALESCE(w.units,0),'total',COALESCE(w.total,0)) ORDER BY n)
              FROM generate_series(0,7) n LEFT JOIN weekly_units w ON w.week=n) AS periods,
           (SELECT count(*)::int FROM selected_orders) AS orders,
           COALESCE((SELECT json_agg(json_build_object('label',label,'orders',orders) ORDER BY orders DESC,label,id)
                       FROM basket), '[]'::json) AS items,
           (SELECT count(discounted)::int FROM order_discounts) AS eligible_orders,
           (SELECT count(*)::int FROM order_discounts WHERE discounted=false) AS orders_without_discount
    FROM target
  `, [environment, productId]);
  const row = result.rows[0];
  if (!row) return null;
  const weeks = row.periods.slice(4).map(week => ({ ...week, percent: percent(week.units, week.total) }));
  const current = totals(weeks);
  const previous = totals(row.periods.slice(0, 4));
  const delta = current.total && previous.total
    ? Math.round(1000 * (current.units / current.total - previous.units / previous.total)) / 10 : null;
  return {
    weeks,
    share: { ...current, percent: percent(current.units, current.total), delta_pp: delta },
    basket: { orders: row.orders, items: row.items },
    discount: { eligible_orders: row.eligible_orders, orders_without_discount: row.orders_without_discount,
      percent: percent(row.orders_without_discount, row.eligible_orders), unknown_orders: row.orders - row.eligible_orders },
  };
}
