// Obra 300 (2026-07-05): fatia do banco da MATRIZ — getPainelRede — o agregado por parceiro da página Rede.
// VERBATIM das linhas 130-389 do queries.ts pré-obra (commit 2628748).
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { applyWholesaleStockDecrement, applyWholesaleStockReturn } from './wholesale-stock.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyMatrizGalpaoDecrement, applyMatrizGalpaoReturn, applyMatrizRetailCostSnapshot } from '../../atendente-v2/wholesale-stock-read.js';
import { hashPassword } from '../../parceiro/password.js';
import { PAINEL_TZ, resolveRedePeriodStartSql, type PainelRedePeriod } from './queries-pedidos.js';

export async function getPainelRede(
  period: PainelRedePeriod = 'month',
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  // Janela calculada no banco; expressão/PAINEL_TZ são constantes sem input do usuário.
  const periodStartSql = resolveRedePeriodStartSql(period);
  const todayStartSql = `(date_trunc('day', now() AT TIME ZONE '${PAINEL_TZ}') AT TIME ZONE '${PAINEL_TZ}')`;
  // 0077/0090: entrega conta em delivered_at; retirada reservada só em retrieved_at.
  const realizedWhere = `po.status <> 'cancelled' AND po.deleted_at IS NULL AND NOT (po.fulfillment_mode = 'delivery' AND po.delivery_status <> 'delivered') AND NOT po.awaiting_pickup`;
  const realizedDate = `(CASE WHEN po.fulfillment_mode = 'delivery' THEN po.delivered_at ELSE COALESCE(po.retrieved_at, po.created_at) END)`;
  // Pedido de ENTREGA ainda não entregue (ou retirada aguardando) NÃO é venda — no feed aparece com o status atual.
  const isRealizedExpr = `NOT (po.fulfillment_mode = 'delivery' AND po.delivery_status <> 'delivered') AND NOT po.awaiting_pickup`;
  // Data do evento no feed: venda realizada usa a data de realização; pedido em curso usa a criação.
  const eventDateExpr = `(CASE WHEN ${isRealizedExpr} THEN ${realizedDate} ELSE po.created_at END)`;
  const result = await dbPool.query(
    `SELECT
       s.environment,
       s.partner_unit_id,
       s.partner_id,
       s.unit_id,
       s.slug,
       s.display_name,
       s.partner_name,
       s.partner_status,
       s.unit_status,
       COALESCE(period_sales.sales_total, 0) AS sales_month,
       COALESCE(period_sales.orders_total, 0) AS orders_month,
       COALESCE(period_purchases.purchases_total, 0) AS purchases_month,
       COALESCE(employee_expenses.employee_total, 0) + COALESCE(other_expenses.other_total, 0) AS expenses_month,
       s.stock_items,
       s.low_stock_items,
       satisfaction.avg_rating AS satisfaction_avg,
       COALESCE(satisfaction.n, 0) AS satisfaction_count,
       COALESCE(period_costs.known_cost_total, 0) AS cogs_month,
       COALESCE(period_costs.pending_cost_items, 0) AS pending_cost_items_month,
       COALESCE(period_costs.pending_cost_revenue, 0) AS pending_cost_revenue_month,
       COALESCE(period_costs.pending_cost_items, 0) > 0 AS has_pending_cost_month,
       CASE WHEN COALESCE(period_costs.pending_cost_items, 0) = 0 THEN
         COALESCE(period_sales.sales_total, 0)
           - COALESCE(period_costs.known_cost_total, 0)
           - COALESCE(employee_expenses.employee_total, 0)
           - COALESCE(other_expenses.other_total, 0)
       ELSE NULL::numeric END AS estimated_result_month,
       p.document_number,
       p.responsible_name,
       p.whatsapp_phone,
       p.address,
       pu.service_mode,
       pu.delivery_radius_km,
       p.commercial_model,
       p.commission_percent,
       p.monthly_fee,
       COALESCE(employee_expenses.employee_total, 0) AS employee_total,
       COALESCE(other_expenses.other_total, 0) AS other_expenses_total,
       COALESCE(today_sales.sales_today, 0) AS sales_today,
       COALESCE(today_sales.orders_today, 0) AS orders_today,
       COALESCE(source_stats.orders_2w, 0) AS orders_2w,
       COALESCE(source_stats.sales_2w, 0) AS sales_2w,
       COALESCE(source_stats.orders_porta, 0) AS orders_porta,
       COALESCE(source_stats.sales_porta, 0) AS sales_porta,
       COALESCE(stock.stock_rows, '[]'::jsonb) AS stock_rows,
       COALESCE(recent_events.events, '[]'::jsonb) AS recent_events,
       COALESCE(top_items.items, '[]'::jsonb) AS top_items,
       COALESCE(sales_series.series, '[0,0,0,0,0,0,0]'::jsonb) AS sales_series,
       COALESCE(order_series.series, '[0,0,0,0,0,0,0]'::jsonb) AS order_series
     FROM network.partner_unit_summary s
     JOIN network.partners p
       ON p.id = s.partner_id AND p.environment = s.environment
     LEFT JOIN network.partner_units pu
       ON pu.id = s.partner_unit_id AND pu.environment = s.environment
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(amount), 0) AS employee_total
       FROM finance.partner_expenses pe
       WHERE pe.environment = s.environment
         AND pe.unit_id = s.unit_id
         AND pe.category = 'employee_payment'
          AND pe.expense_date >= ${periodStartSql}::date
         AND pe.deleted_at IS NULL
     ) employee_expenses ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(amount), 0) AS other_total
       FROM finance.partner_expenses pe
       WHERE pe.environment = s.environment
         AND pe.unit_id = s.unit_id
         AND pe.category <> 'employee_payment'
         AND pe.expense_date >= ${periodStartSql}::date
         AND pe.deleted_at IS NULL
     ) other_expenses ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(total_amount), 0) AS sales_total,
              count(*)::int AS orders_total
       FROM commerce.partner_orders po
       WHERE po.environment = s.environment
         AND po.unit_id = s.unit_id
         AND ${realizedWhere}
         AND ${realizedDate} >= ${periodStartSql}::timestamptz
      ) period_sales ON true
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(sum(oi.quantity::numeric * oi.unit_cost_snapshot)
           FILTER (WHERE oi.cost_status = 'known'), 0) AS known_cost_total,
         count(*) FILTER (WHERE oi.cost_status = 'pending')::int AS pending_cost_items,
         COALESCE(sum(oi.quantity::numeric * oi.unit_price - oi.discount_amount)
           FILTER (WHERE oi.cost_status = 'pending'), 0) AS pending_cost_revenue
       FROM commerce.partner_orders po
       JOIN commerce.partner_order_items oi
         ON oi.order_id = po.id AND oi.environment = po.environment
       WHERE po.environment = s.environment
         AND po.unit_id = s.unit_id
         AND ${realizedWhere}
         AND ${realizedDate} >= ${periodStartSql}::timestamptz
     ) period_costs ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(total_amount), 0) AS purchases_total
       FROM commerce.partner_purchases pp
       WHERE pp.environment = s.environment
         AND pp.unit_id = s.unit_id
         AND pp.deleted_at IS NULL
         AND pp.purchased_at >= ${periodStartSql}::timestamptz
     ) period_purchases ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(total_amount), 0) AS sales_today,
              count(*)::int AS orders_today
       FROM commerce.partner_orders po
       WHERE po.environment = s.environment
         AND po.unit_id = s.unit_id
         AND ${realizedWhere}
         AND ${realizedDate} >= ${todayStartSql}
     ) today_sales ON true
     LEFT JOIN LATERAL (
       SELECT
         count(*) FILTER (WHERE po.source_tag = '2w')::int AS orders_2w,
         COALESCE(sum(po.total_amount) FILTER (WHERE po.source_tag = '2w'), 0) AS sales_2w,
         count(*) FILTER (
           WHERE COALESCE(po.source_tag, 'porta') IN ('porta', 'walkin_balcao', 'walkin_telefone', 'walkin_outro', 'outro')
         )::int AS orders_porta,
         COALESCE(sum(po.total_amount) FILTER (
           WHERE COALESCE(po.source_tag, 'porta') IN ('porta', 'walkin_balcao', 'walkin_telefone', 'walkin_outro', 'outro')
         ), 0) AS sales_porta
       FROM commerce.partner_orders po
       WHERE po.environment = s.environment
         AND po.unit_id = s.unit_id
         AND ${realizedWhere}
         AND ${realizedDate} >= ${periodStartSql}::timestamptz
     ) source_stats ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'id', ps.id,
         'item_name', ps.item_name,
         'quantity_on_hand', ps.quantity_on_hand,
         'minimum_quantity', ps.minimum_quantity,
         'supplier_name', ps.supplier_name,
         'average_cost', ps.average_cost,
         'sale_price', ps.sale_price,
         'stock_status', ps.stock_status,
         'is_tracked', ps.is_tracked,
         'tire_size', ps.tire_size,
         'brand', ps.brand,
         'updated_at', ps.updated_at
       ) ORDER BY ps.item_name) AS stock_rows
       FROM commerce.partner_stock_levels ps
       WHERE ps.environment = s.environment
         AND ps.unit_id = s.unit_id
         AND ps.deleted_at IS NULL
     ) stock ON true
     LEFT JOIN LATERAL (
       -- Nota do cliente (0105/0131): média + nº de respostas da loja. Vazio (null/0)
       -- com a flag off — o score só usa o check quando há amostra (count > 0).
       SELECT round(avg(ss.rating)::numeric, 1) AS avg_rating, count(*)::int AS n
       FROM commerce.satisfaction_surveys ss
       WHERE ss.environment = s.environment AND ss.unit_id = s.unit_id
         AND ss.status = 'answered'
     ) satisfaction ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(event ORDER BY event_at DESC) AS events
       FROM (
         SELECT ${eventDateExpr} AS event_at,
                jsonb_build_object(
                  'type', CASE
                    WHEN ${isRealizedExpr} THEN 'Venda'
                    WHEN po.delivery_status = 'pending' THEN 'Pedido · Em separação'
                    WHEN po.delivery_status = 'dispatched' THEN 'Pedido · Saiu pra entrega'
                    WHEN po.delivery_status = 'failed' THEN 'Pedido · Entrega falhou'
                    ELSE 'Pedido'
                  END,
                  'event_at', ${eventDateExpr},
                  'description', COALESCE(po.customer_name, 'Cliente') || ' - pedido',
                  'amount', po.total_amount
                ) AS event
         FROM commerce.partner_orders po
         WHERE po.environment = s.environment
            AND po.unit_id = s.unit_id
            AND po.status <> 'cancelled'
            AND po.deleted_at IS NULL
            AND po.created_at >= ${periodStartSql}::timestamptz
          UNION ALL
         SELECT pp.purchased_at AS event_at,
                jsonb_build_object(
                  'type', 'Compra pneus',
                  'event_at', pp.purchased_at,
                  'description', COALESCE(pp.supplier_name, 'Compra de pneus'),
                  'amount', -pp.total_amount
                ) AS event
         FROM commerce.partner_purchases pp
          WHERE pp.environment = s.environment
            AND pp.unit_id = s.unit_id
            AND pp.deleted_at IS NULL
            AND pp.purchased_at >= ${periodStartSql}::timestamptz
          UNION ALL
         SELECT pe.created_at AS event_at,
                jsonb_build_object(
                  'type', CASE WHEN pe.category = 'employee_payment' THEN 'Pagamento funcionario' ELSE 'Despesa extra' END,
                  'event_at', pe.created_at,
                  'description', pe.description,
                  'amount', -pe.amount
                ) AS event
         FROM finance.partner_expenses pe
          WHERE pe.environment = s.environment
            AND pe.unit_id = s.unit_id
            AND pe.deleted_at IS NULL
            AND pe.created_at >= ${periodStartSql}::timestamptz
         ORDER BY event_at DESC
         LIMIT 30
       ) unioned
     ) recent_events ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('label', label, 'quantity', qty) ORDER BY qty DESC) AS items
       FROM (
         SELECT COALESCE(ps.tire_size, ps.item_name, poi.partner_stock_id::text) AS label,
                sum(poi.quantity)::int AS qty
         FROM commerce.partner_order_items poi
         JOIN commerce.partner_orders po
           ON po.id = poi.order_id AND po.environment = poi.environment
         LEFT JOIN commerce.partner_stock_levels ps
           ON ps.id = poi.partner_stock_id AND ps.environment = poi.environment
         WHERE po.environment = s.environment
            AND po.unit_id = s.unit_id
            AND ${realizedWhere}
            AND ${realizedDate} >= ${periodStartSql}::timestamptz
         GROUP BY COALESCE(ps.tire_size, ps.item_name, poi.partner_stock_id::text)
         ORDER BY qty DESC
         LIMIT 5
       ) top_query
     ) top_items ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(COALESCE(day_sales.total, 0) ORDER BY day_ref.day)::jsonb AS series
       FROM generate_series(
         date_trunc('day', ${periodStartSql}::timestamptz),
         date_trunc('day', now()),
         interval '1 day'
       ) AS day_ref(day)
       LEFT JOIN LATERAL (
         SELECT sum(po.total_amount)::numeric AS total
         FROM commerce.partner_orders po
         WHERE po.environment = s.environment
           AND po.unit_id = s.unit_id
           AND ${realizedWhere}
           AND ${realizedDate} >= day_ref.day
           AND ${realizedDate} < day_ref.day + interval '1 day'
       ) day_sales ON true
     ) sales_series ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(COALESCE(day_orders.total, 0) ORDER BY day_ref.day)::jsonb AS series
       FROM generate_series(
         date_trunc('day', ${periodStartSql}::timestamptz),
         date_trunc('day', now()),
         interval '1 day'
       ) AS day_ref(day)
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS total
         FROM commerce.partner_orders po
         WHERE po.environment = s.environment
           AND po.unit_id = s.unit_id
           AND ${realizedWhere}
           AND ${realizedDate} >= day_ref.day
           AND ${realizedDate} < day_ref.day + interval '1 day'
       ) day_orders ON true
     ) order_series ON true
     WHERE s.environment = $1
     ORDER BY sales_month DESC, s.display_name ASC`,
    [env.FAREJADOR_ENV],
  );
  return result.rows;
}
