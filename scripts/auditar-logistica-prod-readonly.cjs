const { Client } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('database_url_required');

const environment = process.env.FAREJADOR_ENV;
if (!['prod', 'test'].includes(environment)) {
  throw new Error('FAREJADOR_ENV deve ser informado explicitamente como prod ou test');
}
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

async function one(sql) {
  const result = await client.query(sql, sql.includes('$1') ? [environment] : []);
  return result.rows[0] || {};
}

async function many(sql) {
  const result = await client.query(sql, sql.includes('$1') ? [environment] : []);
  return result.rows;
}

async function main() {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='30s'");
  await client.query("SET LOCAL lock_timeout='2s'");
  const readOnly = await client.query(
    `SELECT current_setting('transaction_read_only') AS value`,
  );
  if (readOnly.rows[0]?.value !== 'on') throw new Error('audit_not_read_only');

  const matrixOperation = await one(`
    SELECT
      (SELECT count(*)::int FROM commerce.matriz_delivery_trips t
        WHERE t.environment=$1 AND t.status='open' AND t.deleted_at IS NULL)
        AS open_trips,
      (SELECT count(*)::int FROM commerce.matriz_delivery_trips t
        WHERE t.environment=$1 AND t.status='open' AND t.deleted_at IS NULL
          AND t.courier_collaborator_id IS NULL)
        AS open_trips_without_courier_identity,
      (SELECT count(*)::int FROM commerce.matriz_delivery_trips t
        WHERE t.environment=$1 AND t.status='closed' AND t.deleted_at IS NULL
          AND t.courier_collaborator_id IS NULL)
        AS closed_trips_without_courier_identity,
      (SELECT count(*)::int FROM commerce.orders o
        JOIN commerce.matriz_delivery_trips t
          ON t.id=o.trip_id AND t.environment=o.environment
       WHERE o.environment=$1 AND o.status<>'cancelled'
         AND o.delivery_status='delivered'
         AND t.courier_collaborator_id IS NULL)
        AS delivered_orders_without_courier_identity,
      (SELECT count(*)::int FROM commerce.orders o
        JOIN commerce.matriz_delivery_trips t
          ON t.id=o.trip_id AND t.environment=o.environment
       WHERE o.environment=$1 AND t.status='open' AND t.deleted_at IS NULL
         AND t.courier_collaborator_id IS NULL
         AND o.status<>'cancelled'
         AND o.delivery_status IN ('pending','dispatched'))
        AS unresolved_orders_invisible_to_courier_app,
      (SELECT count(*)::int FROM commerce.matriz_delivery_trips t
        WHERE t.environment=$1 AND t.status='open' AND t.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM commerce.orders o
             WHERE o.environment=t.environment AND o.trip_id=t.id
               AND o.status<>'cancelled'
          )) AS open_trips_without_active_orders,
      (SELECT count(*)::int FROM commerce.orders o
        JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment
       WHERE o.environment=$1 AND u.slug='main' AND o.fulfillment_mode='delivery'
         AND o.status<>'cancelled' AND o.delivery_status IN ('pending','dispatched'))
        AS open_deliveries,
      (SELECT count(*)::int FROM commerce.orders o
        JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment
       WHERE o.environment=$1 AND u.slug='main' AND o.fulfillment_mode='delivery'
         AND o.status<>'cancelled' AND o.delivery_status='failed')
        AS failures_awaiting_owner_decision,
      (SELECT count(*)::int FROM commerce.orders o
        JOIN commerce.matriz_delivery_trips t
          ON t.id=o.trip_id AND t.environment=o.environment
       WHERE o.environment=$1 AND o.status<>'cancelled'
         AND lower(btrim(COALESCE(o.delivery_courier,'')))
             <> lower(btrim(t.courier_name)))
        AS order_route_courier_name_mismatches,
      (SELECT count(*)::int FROM commerce.orders o
        JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment
        JOIN commerce.customers customer
          ON customer.id=o.customer_id AND customer.environment=o.environment
       WHERE o.environment=$1 AND u.slug='main' AND o.fulfillment_mode='delivery'
         AND o.contact_id IS NULL AND customer.deleted_at IS NULL
         AND o.status<>'cancelled' AND o.delivery_status IN ('pending','dispatched'))
        AS walkin_open_deliveries_missing_identity_in_courier_query
  `);

  const matrixState = await one(`
    SELECT
      count(*) FILTER (
        WHERE delivery_status='delivered' AND delivered_at IS NULL)::int
        AS delivered_without_timestamp,
      count(*) FILTER (
        WHERE delivery_status='dispatched' AND dispatched_at IS NULL)::int
        AS dispatched_without_timestamp,
      count(*) FILTER (
        WHERE delivery_status<>'delivered' AND delivered_at IS NOT NULL
          AND status<>'cancelled')::int AS open_with_delivered_timestamp,
      count(*) FILTER (
        WHERE status='cancelled' AND delivery_status IN ('pending','dispatched'))::int
        AS cancelled_with_active_delivery_state,
      count(*) FILTER (
        WHERE status='delivered' AND delivery_status<>'delivered')::int
        AS commercial_operational_state_mismatch,
      count(*) FILTER (
        WHERE trip_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM commerce.matriz_delivery_trips t
           WHERE t.id=orders.trip_id AND t.environment=orders.environment))::int
        AS orphan_trip_links,
      count(*) FILTER (
        WHERE trip_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM commerce.matriz_delivery_trips t
           WHERE t.id=orders.trip_id AND t.environment=orders.environment
             AND t.status='closed'
             AND orders.status<>'cancelled'
             AND orders.delivery_status IN ('pending','dispatched')))::int
        AS unresolved_orders_on_closed_trip
    FROM commerce.orders
    WHERE environment=$1 AND fulfillment_mode='delivery'
  `);

  const matrixMath = await one(`
    WITH delivered AS (
      SELECT o.id,o.partner_order_id,o.total_amount,
             COALESCE(sum(i.quantity*i.unit_price-i.discount_amount),0) item_revenue,
             COALESCE(sum(i.quantity*i.matriz_unit_cost)
               FILTER (WHERE i.matriz_unit_cost IS NOT NULL),0) cogs,
             count(*) FILTER (WHERE i.matriz_unit_cost IS NULL)::int missing_cost
        FROM commerce.orders o
        JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
        LEFT JOIN commerce.order_items i
          ON i.order_id=o.id AND i.environment=o.environment
       WHERE o.environment=$1 AND o.fulfillment_mode='delivery'
         AND o.status<>'cancelled' AND o.delivery_status='delivered'
       GROUP BY o.id,o.partner_order_id,o.total_amount
    ), ledger AS (
      SELECT d.*,
             revenue.amount revenue_posted,cost.amount cogs_posted
        FROM delivered d
        LEFT JOIN finance.matriz_ledger_transactions revenue
          ON revenue.environment=$1 AND revenue.source_type='commerce.order.revenue'
         AND revenue.source_id=d.id::text
        LEFT JOIN finance.matriz_ledger_transactions cost
          ON cost.environment=$1 AND cost.source_type='commerce.order.cogs'
         AND cost.source_id=d.id::text
    )
    SELECT
      count(*)::int AS delivered_orders,
      count(*) FILTER (WHERE partner_order_id IS NOT NULL)::int
        AS delivered_partner_linked_orders,
      round(COALESCE(sum(total_amount),0),2)::text AS delivered_revenue,
      round(COALESCE(sum(item_revenue),0),2)::text AS delivered_item_revenue,
      round(COALESCE(sum(GREATEST(total_amount-item_revenue,0)),0),2)::text
        AS delivered_freight,
      round(COALESCE(sum(cogs),0),2)::text AS delivered_cogs,
      count(*) FILTER (WHERE total_amount+0.009<item_revenue)::int
        AS negative_implied_freight,
      COALESCE(sum(missing_cost),0)::int AS item_lines_without_cost,
      count(*) FILTER (WHERE partner_order_id IS NULL AND total_amount>0
        AND revenue_posted IS NULL)::int
        AS retail_revenue_facts_missing,
      count(*) FILTER (WHERE partner_order_id IS NULL AND revenue_posted IS NOT NULL
        AND abs(revenue_posted-total_amount)>0.009)::int AS revenue_fact_mismatches,
      count(*) FILTER (WHERE partner_order_id IS NULL AND cogs>0 AND cogs_posted IS NULL)::int
        AS retail_cogs_facts_missing,
      count(*) FILTER (WHERE partner_order_id IS NULL AND cogs_posted IS NOT NULL
        AND abs(cogs_posted-cogs)>0.009)::int AS cogs_fact_mismatches
    FROM ledger
  `);

  const receipts = await one(`
    SELECT
      (SELECT count(*)::int FROM commerce.matriz_trip_receipts r
        WHERE r.environment=$1) AS receipts,
      (SELECT count(*)::int FROM commerce.matriz_trip_receipts r
        WHERE r.environment=$1 AND NOT EXISTS (
          SELECT 1 FROM commerce.matriz_trip_receipt_blobs b
           WHERE b.receipt_id=r.id AND b.environment=r.environment))
        AS receipts_without_blob,
      (SELECT count(*)::int FROM commerce.matriz_trip_receipt_blobs b
        WHERE b.environment=$1 AND NOT EXISTS (
          SELECT 1 FROM commerce.matriz_trip_receipts r
           WHERE r.id=b.receipt_id AND r.environment=b.environment))
        AS orphan_blobs,
      (SELECT count(*)::int FROM commerce.matriz_trip_receipts r
        WHERE r.environment=$1 AND r.workflow_status IN ('linked','legacy_linked')
          AND (r.ai_expense_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM commerce.matriz_expenses e
             WHERE e.id=r.ai_expense_id AND e.environment=r.environment
               AND e.deleted_at IS NULL))) AS linked_without_active_expense,
      (SELECT count(*)::int FROM (
        SELECT encode(b.content_sha256,'hex') hash
          FROM commerce.matriz_trip_receipt_blobs b
         WHERE b.environment=$1 AND b.content_sha256 IS NOT NULL
         GROUP BY b.content_sha256 HAVING count(DISTINCT b.receipt_id)>1
      ) duplicated) AS repeated_content_hashes,
      (SELECT count(*)::int FROM commerce.matriz_delivery_trips t
        WHERE t.environment=$1 AND t.status='closed' AND t.deleted_at IS NULL
          AND commerce.matriz_trip_financial_status(t.id,t.environment)='pending')
        AS closed_trips_financially_pending,
      (SELECT count(*)::int FROM commerce.matriz_delivery_trips t
        WHERE t.environment=$1 AND t.status='closed' AND t.deleted_at IS NULL
          AND commerce.matriz_trip_financial_status(t.id,t.environment)='divergent')
        AS closed_trips_financially_divergent
  `);

  const partnerOperation = await one(`
    SELECT
      count(*) FILTER (WHERE fulfillment_mode='delivery')::int AS deliveries,
      count(*) FILTER (WHERE fulfillment_mode='delivery'
        AND delivery_status='delivered' AND delivered_at IS NULL)::int
        AS delivered_without_timestamp,
      count(*) FILTER (WHERE fulfillment_mode='delivery'
        AND delivery_status='dispatched' AND dispatched_at IS NULL)::int
        AS dispatched_without_timestamp,
      count(*) FILTER (WHERE fulfillment_mode='delivery'
        AND status='cancelled' AND delivery_status IN ('pending','dispatched'))::int
        AS cancelled_with_active_delivery_state,
      count(*) FILTER (WHERE fulfillment_mode='delivery'
        AND status<>'cancelled' AND delivery_status='failed')::int
        AS failed_without_cancellation,
      count(*) FILTER (WHERE fulfillment_mode='delivery'
        AND delivery_status='delivered' AND status<>'paid')::int
        AS delivered_without_paid_order_state
    FROM commerce.partner_orders
    WHERE environment=$1 AND deleted_at IS NULL
  `);

  const partnerFinance = await one(`
    WITH deliveries AS (
      SELECT o.id,o.unit_id,o.total_amount,o.delivery_status,o.status,o.delivered_at,
             r.id receivable_id,r.amount receivable_amount,r.status receivable_status,
             r.received_at,r.deleted_at receivable_deleted_at
        FROM commerce.partner_orders o
        LEFT JOIN finance.partner_receivables r
          ON r.environment=o.environment AND r.unit_id=o.unit_id
         AND r.source_order_id=o.id
       WHERE o.environment=$1 AND o.fulfillment_mode='delivery' AND o.deleted_at IS NULL
    )
    SELECT
      count(*) FILTER (WHERE delivery_status='delivered'
        AND (receivable_id IS NULL OR receivable_status<>'received'
          OR receivable_deleted_at IS NOT NULL))::int AS delivered_without_received_receivable,
      count(*) FILTER (WHERE delivery_status='delivered' AND receivable_id IS NOT NULL
        AND abs(total_amount-receivable_amount)>0.009)::int
        AS delivered_receivable_amount_mismatches,
      count(*) FILTER (WHERE delivery_status<>'delivered'
        AND receivable_status='received' AND receivable_deleted_at IS NULL)::int
        AS unrealized_delivery_with_received_money,
      count(*) FILTER (WHERE delivery_status='delivered' AND received_at IS NOT NULL
        AND delivered_at IS NOT NULL
        AND abs(extract(epoch FROM (received_at-delivered_at)))>5)::int
        AS delivered_receipt_timestamp_drifts_over_5s,
      (SELECT count(*)::int FROM (
        SELECT source_order_id
          FROM finance.partner_receivables
         WHERE environment=$1 AND source_order_id IS NOT NULL
         GROUP BY source_order_id HAVING count(*)>1
      ) duplicate) AS duplicate_receivables_per_order
    FROM deliveries
  `);

  const isolation = await one(`
    SELECT
      has_table_privilege('farejador_partner_app',
        'commerce.matriz_delivery_trips','SELECT') AS partner_can_read_matrix_trips,
      has_table_privilege('farejador_partner_app',
        'commerce.matriz_trip_receipts','SELECT') AS partner_can_read_matrix_receipts,
      has_table_privilege('farejador_partner_app',
        'commerce.matriz_trip_receipt_blobs','SELECT') AS partner_can_read_matrix_receipt_blobs
  `);

  const routeAttention = await many(`
    SELECT t.trip_number,t.status,
           commerce.matriz_trip_financial_status(t.id,t.environment) financial_status,
           COALESCE(t.fuel_spent,0)::text fuel_spent,
           count(r.id)::int receipt_count,
           count(r.id) FILTER (WHERE r.workflow_status IN ('uploaded','review_required'))::int
             receipts_awaiting_review,
           COALESCE(string_agg(DISTINCT r.workflow_status,','), '') receipt_states,
           (SELECT COALESCE(sum(x.amount),0)::text FROM (
             SELECT DISTINCT e2.id,e2.amount
               FROM commerce.matriz_trip_receipts r2
               JOIN commerce.matriz_expenses e2
                 ON e2.id=r2.ai_expense_id AND e2.environment=r2.environment
                AND e2.category='combustivel' AND e2.deleted_at IS NULL
              WHERE r2.trip_id=t.id AND r2.environment=t.environment
                AND r2.workflow_status IN ('linked','legacy_linked')
           ) x) approved_fuel,
           (SELECT count(*)::int
              FROM commerce.orders o
              JOIN commerce.order_items i
                ON i.order_id=o.id AND i.environment=o.environment
             WHERE o.trip_id=t.id AND o.environment=t.environment
               AND o.status<>'cancelled' AND o.delivery_status='delivered'
               AND i.matriz_unit_cost IS NULL) item_lines_without_cost
      FROM commerce.matriz_delivery_trips t
      LEFT JOIN commerce.matriz_trip_receipts r
        ON r.trip_id=t.id AND r.environment=t.environment
     WHERE t.environment=$1 AND t.deleted_at IS NULL
       AND commerce.matriz_trip_financial_status(t.id,t.environment)<>'reconciled'
     GROUP BY t.id,t.trip_number,t.status,t.environment,t.fuel_spent
     ORDER BY t.started_at DESC
     LIMIT 20
  `);

  const matrixFactAttention = await many(`
    WITH delivered AS (
      SELECT o.id,o.order_number,o.created_at,o.delivered_at,o.total_amount,
             COALESCE(sum(i.quantity*i.unit_price-i.discount_amount),0) item_revenue,
             count(*) FILTER (WHERE i.matriz_unit_cost IS NULL)::int missing_cost
        FROM commerce.orders o
        JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
        LEFT JOIN commerce.order_items i
          ON i.order_id=o.id AND i.environment=o.environment
       WHERE o.environment=$1 AND o.fulfillment_mode='delivery'
         AND o.partner_order_id IS NULL
         AND o.status<>'cancelled' AND o.delivery_status='delivered'
       GROUP BY o.id,o.order_number,o.created_at,o.delivered_at,o.total_amount
    )
    SELECT d.order_number,d.created_at,d.delivered_at,d.total_amount::text,
           d.item_revenue::text,d.missing_cost,
           (d.total_amount>0 AND NOT EXISTS (
             SELECT 1 FROM finance.matriz_ledger_transactions t
              WHERE t.environment=$1 AND t.source_type='commerce.order.revenue'
                AND t.source_id=d.id::text)) revenue_fact_missing,
           EXISTS (
             SELECT 1 FROM audit.events a
              WHERE a.environment=$1 AND a.entity_id=d.id
                AND a.event_type='matriz_galpao_decrement') stock_decrement_recorded
      FROM delivered d
     WHERE d.missing_cost>0 OR (d.total_amount>0 AND NOT EXISTS (
       SELECT 1 FROM finance.matriz_ledger_transactions t
        WHERE t.environment=$1 AND t.source_type='commerce.order.revenue'
          AND t.source_id=d.id::text))
     ORDER BY d.created_at DESC
     LIMIT 20
  `);

  await client.query('ROLLBACK');
  console.log(JSON.stringify({
    environment,
    transaction_read_only: true,
    matrix_operation: matrixOperation,
    matrix_state: matrixState,
    matrix_math: matrixMath,
    receipts,
    partner_operation: partnerOperation,
    partner_finance: partnerFinance,
    isolation,
    route_attention: routeAttention,
    matrix_fact_attention: matrixFactAttention,
  }));
}

main()
  .catch(async (error) => {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => client.end().catch(() => undefined));
