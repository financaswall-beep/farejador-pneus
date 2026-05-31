'use strict';

const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL ausente.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const column = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'commerce'
        AND table_name = 'partner_stock_levels'
        AND column_name = 'quantity_reserved'
    `);

    const helper = await client.query(`
      SELECT count(*)::int AS count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'commerce'
        AND p.proname = 'partner_stock_status'
    `);

    const checks = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'commerce.partner_stock_levels'::regclass
        AND conname IN (
          'partner_stock_levels_reserved_check',
          'partner_stock_levels_stock_status_check'
        )
      ORDER BY conname
    `);

    const gate = await client.query(`
      SELECT count(*)::int AS delivery_em_aberto
      FROM commerce.partner_orders
      WHERE fulfillment_mode = 'delivery'
        AND delivery_status IN ('pending', 'dispatched')
        AND status <> 'cancelled'
        AND deleted_at IS NULL
    `);

    console.log(JSON.stringify({
      quantity_reserved: column.rows[0] ?? null,
      helper_count: helper.rows[0]?.count ?? 0,
      checks: checks.rows,
      gate_p1: gate.rows[0],
    }, null, 2));

    if (column.rowCount !== 1 || Number(helper.rows[0]?.count ?? 0) < 1 || checks.rowCount !== 2) {
      process.exit(2);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
