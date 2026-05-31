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
    const result = await client.query(`
      SELECT count(*)::int AS delivery_em_aberto
      FROM commerce.partner_orders
      WHERE fulfillment_mode = 'delivery'
        AND delivery_status IN ('pending', 'dispatched')
        AND status <> 'cancelled'
        AND deleted_at IS NULL
    `);
    const count = Number(result.rows[0]?.delivery_em_aberto ?? 0);
    console.log(JSON.stringify({ delivery_em_aberto: count }));
    if (count !== 0) {
      const details = await client.query(`
        SELECT id, status, delivery_status, created_at
        FROM commerce.partner_orders
        WHERE fulfillment_mode = 'delivery'
          AND delivery_status IN ('pending', 'dispatched')
          AND status <> 'cancelled'
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 10
      `);
      console.log(JSON.stringify({ abertas: details.rows }, null, 2));
      console.error('Gate P1 falhou: existem entregas delivery abertas.');
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
