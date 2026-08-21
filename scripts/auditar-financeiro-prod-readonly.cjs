const { Client } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('database_url_required');
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("SET LOCAL lock_timeout = '2s'");

  const { rows: [result] } = await client.query(`
    WITH zero_counts AS (
      SELECT
        (SELECT count(*)::integer
           FROM commerce.partner_orders
          WHERE total_amount <= 0) AS orders_nonpositive,
        (SELECT count(*)::integer
           FROM finance.partner_expenses
          WHERE amount <= 0) AS expenses_nonpositive,
        (SELECT count(*)::integer
           FROM finance.partner_payables
          WHERE NOT (amount > 0 OR (status = 'cancelled' AND amount = 0)))
          AS payables_invalid_amount,
        (SELECT count(*)::integer
           FROM finance.partner_receivables
          WHERE amount <= 0) AS receivables_nonpositive
    ),
    installment_groups AS (
      SELECT
        receivable.id,
        receivable.amount,
        COALESCE(sum(installment.amount)
          FILTER (WHERE installment.deleted_at IS NULL), 0) AS installment_total,
        count(installment.id)
          FILTER (WHERE installment.deleted_at IS NULL) AS installment_count
      FROM finance.partner_receivables receivable
      LEFT JOIN finance.partner_receivable_installments installment
        ON installment.receivable_id = receivable.id
      WHERE receivable.deleted_at IS NULL
      GROUP BY receivable.id, receivable.amount
    )
    SELECT
      zero_counts.*,
      (SELECT count(*)::integer
         FROM installment_groups
        WHERE installment_count > 0
          AND abs(amount - installment_total) > 0.009)
        AS installment_total_mismatches,
      (SELECT count(*)::integer
         FROM installment_groups
        WHERE installment_count > 0) AS installment_parents
    FROM zero_counts
  `);

  const { rows: [causal] } = await client.query(`
    WITH settled AS (
      SELECT order_row.id,order_row.environment,
             COALESCE(order_row.settled_total_amount,order_row.total_amount) revenue,
             COALESCE(sum(COALESCE(item.accepted_quantity,0)*item.unit_cost),0) cogs
        FROM commerce.wholesale_orders order_row
        LEFT JOIN commerce.wholesale_order_items item
          ON item.environment=order_row.environment AND item.order_id=order_row.id
       WHERE order_row.environment='prod'
         AND order_row.partner_transfer_status IN ('settled','received')
       GROUP BY order_row.id,order_row.environment,
                order_row.settled_total_amount,order_row.total_amount
    ), settled_sources AS (
      SELECT settled.*,
             revenue_fact.amount revenue_posted,
             cogs_fact.amount cogs_posted
        FROM settled
        LEFT JOIN LATERAL (
          SELECT transaction.amount
            FROM finance.matriz_ledger_transactions transaction
           WHERE transaction.environment=settled.environment
             AND transaction.source_id=settled.id::text
             AND transaction.source_type IN (
               'commerce.wholesale_order.arrival_revenue',
               'commerce.wholesale_order.revenue'
             )
           ORDER BY CASE transaction.source_type
             WHEN 'commerce.wholesale_order.arrival_revenue' THEN 0 ELSE 1 END
           LIMIT 1
        ) revenue_fact ON true
        LEFT JOIN LATERAL (
          SELECT transaction.amount
            FROM finance.matriz_ledger_transactions transaction
           WHERE transaction.environment=settled.environment
             AND transaction.source_id=settled.id::text
             AND transaction.source_type IN (
               'commerce.wholesale_order.arrival_cogs',
               'commerce.wholesale_order.cogs'
             )
           ORDER BY CASE transaction.source_type
             WHEN 'commerce.wholesale_order.arrival_cogs' THEN 0 ELSE 1 END
           LIMIT 1
        ) cogs_fact ON true
    )
    SELECT
      (SELECT count(*)::integer FROM settled_sources) settled_partner_transfers,
      (SELECT count(*)::integer FROM settled_sources
        WHERE revenue>0 AND revenue_posted IS NULL) arrival_aware_revenue_missing,
      (SELECT count(*)::integer FROM settled_sources
        WHERE cogs>0 AND cogs_posted IS NULL) arrival_aware_cogs_missing,
      (SELECT count(*)::integer FROM settled_sources
        WHERE revenue_posted IS NOT NULL
          AND abs(revenue-revenue_posted)>0.009) settled_revenue_mismatches,
      (SELECT count(*)::integer FROM settled_sources
        WHERE cogs_posted IS NOT NULL
          AND abs(cogs-cogs_posted)>0.009) settled_cogs_mismatches,
      (SELECT count(*)::integer
         FROM commerce.wholesale_orders order_row
        WHERE order_row.environment='prod'
          AND order_row.partner_transfer_status='in_transit'
          AND EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions transaction
             WHERE transaction.environment=order_row.environment
               AND transaction.source_id=order_row.id::text
               AND transaction.source_type IN (
                 'commerce.wholesale_order.revenue',
                 'commerce.wholesale_order.cogs',
                 'commerce.wholesale_order.arrival_revenue',
                 'commerce.wholesale_order.arrival_cogs'
               )
          )) in_transit_economic_recognition,
      (SELECT count(*)::integer
         FROM commerce.partner_orders order_row
        WHERE order_row.environment='prod' AND order_row.status<>'cancelled'
          AND order_row.fulfillment_mode='delivery'
          AND order_row.delivery_status<>'delivered'
          AND lower(btrim(COALESCE(order_row.payment_method,'')))<>'a receber')
        unrealized_delivery_marked_as_cash,
      (SELECT count(*)::integer
         FROM commerce.partner_orders order_row
        WHERE order_row.environment='prod' AND order_row.status<>'cancelled'
          AND order_row.awaiting_pickup
          AND lower(btrim(COALESCE(order_row.payment_method,'')))<>'a receber')
        unrealized_pickup_marked_as_cash,
      (SELECT count(*)::integer FROM (
        SELECT transaction.source_type,transaction.source_id
          FROM finance.matriz_ledger_transactions transaction
         WHERE transaction.environment='prod'
         GROUP BY transaction.source_type,transaction.source_id
        HAVING count(*)>1
      ) duplicate) duplicate_ledger_sources,
      (SELECT count(*)::integer
         FROM finance.matriz_ledger_transactions reversal
        WHERE reversal.environment='prod'
          AND reversal.reversal_of_transaction_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM finance.matriz_ledger_transactions original
             WHERE original.environment=reversal.environment
               AND original.id=reversal.reversal_of_transaction_id
          )) orphan_ledger_reversals,
      (SELECT count(*)::integer
         FROM finance.partner_payables payable
        WHERE payable.environment='prod' AND payable.deleted_at IS NULL
          AND ((payable.status='paid' AND payable.paid_at IS NULL)
            OR (payable.status<>'paid' AND payable.paid_at IS NOT NULL)))
        payable_status_timestamp_mismatches,
      (SELECT count(*)::integer
         FROM finance.partner_receivables receivable
        WHERE receivable.environment='prod' AND receivable.deleted_at IS NULL
          AND ((receivable.status='received' AND receivable.received_at IS NULL)
            OR (receivable.status<>'received' AND receivable.received_at IS NOT NULL)))
        receivable_status_timestamp_mismatches,
      (SELECT count(*)::integer FROM (
        SELECT expense.source_payable_id
          FROM finance.partner_expenses expense
         WHERE expense.environment='prod' AND expense.deleted_at IS NULL
           AND expense.source_payable_id IS NOT NULL
         GROUP BY expense.source_payable_id HAVING count(*)>1
      ) duplicate) duplicate_expenses_per_payable
  `);

  await client.query('ROLLBACK');
  console.log(JSON.stringify({ monetary_constraints: result, causal_integrity: causal }));
}

main()
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end().catch(() => undefined);
  });
