import type { Pool } from 'pg';

/** Commercial sales, including lot discounts and accepted partner transfers.
 * Delivery reservations are not completed sales until actually delivered. */
export async function readOverviewSales(db: Pool, environment: string, from: string, to: string) {
  const result = await db.query(`WITH sales AS (
    SELECT o.id,'varejo'::text channel,
      (CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at ELSE o.created_at END
        AT TIME ZONE 'America/Sao_Paulo')::date sale_day,o.total_amount revenue,
      COALESCE(sum(i.quantity) FILTER(WHERE p.product_type='tire'),0) tires,
      COALESCE(sum(i.quantity) FILTER(WHERE p.product_type='tire' AND i.vehicle_type='motorcycle'),0) moto,
      COALESCE(sum(i.quantity) FILTER(WHERE p.product_type='tire' AND i.vehicle_type='car'),0) car,
      0::bigint lots
    FROM commerce.orders o JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
    JOIN commerce.order_items i ON i.order_id=o.id AND i.environment=o.environment
    JOIN commerce.products p ON p.id=i.product_id AND p.environment=i.environment
    WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.status IN ('confirmed','paid','delivered')
      AND (o.fulfillment_mode<>'delivery' OR o.delivery_status='delivered')
      AND (CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at ELSE o.created_at END)
        >=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND (CASE WHEN o.fulfillment_mode='delivery' THEN o.delivered_at ELSE o.created_at END)
        <(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
    GROUP BY o.id
    UNION ALL
    SELECT o.id,'atacado',(o.sold_at AT TIME ZONE 'America/Sao_Paulo')::date,
      COALESCE(o.settled_total_amount,o.total_amount),sum(q.quantity),
      COALESCE(sum(q.quantity) FILTER(WHERE i.tire_lot_id IS NULL AND i.vehicle_type='motorcycle'),0),
      COALESCE(sum(q.quantity) FILTER(WHERE i.tire_lot_id IS NULL AND i.vehicle_type='car'),0),
      COALESCE(sum(q.quantity) FILTER(WHERE i.tire_lot_id IS NOT NULL),0)
    FROM commerce.wholesale_orders o JOIN commerce.wholesale_order_items i
      ON i.order_id=o.id AND i.environment=o.environment
    CROSS JOIN LATERAL (SELECT CASE WHEN o.partner_transfer_status IN ('settled','received')
      THEN COALESCE(i.accepted_quantity,0) ELSE i.quantity END quantity) q
    WHERE o.environment=$1 AND o.status='confirmed'
      AND (o.partner_transfer_status IS NULL OR o.partner_transfer_status IN ('settled','received'))
      AND o.sold_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND o.sold_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
    GROUP BY o.id HAVING sum(q.quantity)>0
  ) SELECT sale_day::text AS "day",channel,count(*)::int orders,sum(revenue)::text revenue,
    sum(tires)::int tires,sum(moto)::int moto,sum(car)::int car,sum(lots)::int lots
    FROM sales WHERE sale_day BETWEEN $2::date AND $3::date GROUP BY sale_day,channel ORDER BY sale_day,channel`,
  [environment, from, to]);
  const summary = { revenue: 0, orders: 0, tires: 0, moto: 0, car: 0, lots: 0, unclassified: 0, varejo: 0, atacado: 0 };
  const daily = result.rows.map(row => {
    const revenue = Math.round(Number(row.revenue) * 100);
    summary.revenue += revenue;
    summary[row.channel as 'varejo' | 'atacado'] += revenue;
    for (const field of ['orders','tires','moto','car','lots'] as const) summary[field] += Number(row[field]);
    return { day: String(row.day), channel: row.channel as 'varejo'|'atacado', revenue };
  });
  summary.unclassified = summary.tires - summary.moto - summary.car - summary.lots;
  return { summary, daily };
}

/** Same internal estimate as v_daily_metrics, but attributed to the turn date.
 * This is NOT the provider's bill: no model, cache or exchange-rate pricing. */
export async function readOverviewBotCost(db: Pool, environment: string, from: string, to: string) {
  const result = await db.query(`SELECT
      COALESCE(sum(COALESCE(llm_input_tokens,0)+COALESCE(llm_output_tokens,0)),0)::text tokens,
      count(*) FILTER(WHERE llm_input_tokens IS NULL OR llm_output_tokens IS NULL)::int missing_usage,
      count(*)::int turns FROM agent.turns WHERE environment=$1 AND agent_version='v2'
      AND created_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND created_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`, [environment,from,to]);
  const row=result.rows[0];
  return { estimated_cents: Math.round(Number(row.tokens)*550/1_000_000), tokens:Number(row.tokens),
    turns:row.turns, missing_usage:row.missing_usage, brl_per_million_tokens:5.5 };
}
