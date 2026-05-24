'use strict';
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const sig = await c.query(`
      SELECT pg_get_function_arguments(oid) AS args, pg_get_function_result(oid) AS result
      FROM pg_proc WHERE proname='find_compatible_tires';
    `);
    console.log('find_compatible_tires SIG:', sig.rows);

    const fanId = '600aa15b-689f-4cf9-9387-9ef171eb820e';
    const r = await c.query(
      "SELECT * FROM commerce.find_compatible_tires('prod'::env_t, $1::uuid, NULL);",
      [fanId]
    );
    console.log('\nfind_compatible_tires(Fan, NULL):');
    for (const row of r.rows) console.log(' ', row);

    // produtos da CG 160 Fan via tabela direta
    const prods = await c.query(`
      SELECT p.id, p.product_code, ts.tire_size, vf.position, p.is_active, pp.amount_brl
      FROM commerce.vehicle_fitments vf
      JOIN commerce.tire_specs ts ON ts.id = vf.tire_spec_id
      LEFT JOIN commerce.products p ON p.tire_spec_id = ts.id
      LEFT JOIN commerce.product_prices pp ON pp.product_id = p.id AND pp.environment='prod'::env_t
      WHERE vf.vehicle_model_id = $1
      ORDER BY vf.position;
    `, [fanId]);
    console.log('\nPRODUTOS pra CG 160 Fan:');
    for (const row of prods.rows) console.log(' ', row);
  } finally {
    await c.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
