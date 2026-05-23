'use strict';
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  // 1) Identidade do banco
  const db = await client.query(`
    SELECT current_database() AS dbname,
           inet_server_addr()::text AS host,
           inet_server_port() AS port,
           current_user AS user;
  `);
  const ext = await client.query(`
    SELECT environment, COUNT(*)::int AS n
    FROM commerce.vehicle_models
    WHERE deleted_at IS NULL
    GROUP BY environment ORDER BY environment;
  `);
  console.log('=== IDENTIDADE DO BANCO ===');
  console.log(`  database: ${db.rows[0].dbname}`);
  console.log(`  host:port: ${db.rows[0].host}:${db.rows[0].port}`);
  console.log(`  user: ${db.rows[0].user}`);
  console.log('  environments populados em vehicle_models:');
  for (const r of ext.rows) console.log(`    ${r.environment}: ${r.n}`);
  console.log();

  // 2) Motos em prod por marca
  const byMake = await client.query(`
    SELECT make, COUNT(*)::int AS n
    FROM commerce.vehicle_models
    WHERE environment='prod' AND deleted_at IS NULL
    GROUP BY make ORDER BY n DESC, make;
  `);
  console.log(`=== MOTOS EM prod POR MARCA (${byMake.rows.reduce((s,r)=>s+r.n,0)} total) ===`);
  for (const r of byMake.rows) console.log(`  ${r.make.padEnd(20)} ${r.n}`);
  console.log();

  // 3) Lista completa
  const all = await client.query(`
    SELECT make, model, variant, year_start, year_end, displacement_cc, aliases
    FROM commerce.vehicle_models
    WHERE environment='prod' AND deleted_at IS NULL
    ORDER BY make, model, variant NULLS LAST, year_start NULLS LAST;
  `);
  console.log(`=== LISTA COMPLETA (${all.rows.length}) ===`);
  let lastMake = '';
  for (const r of all.rows) {
    if (r.make !== lastMake) {
      console.log(`\n  -- ${r.make} --`);
      lastMake = r.make;
    }
    const variant = r.variant ? ` ${r.variant}` : '';
    const year = (r.year_start || r.year_end) ? ` (${r.year_start ?? '?'}-${r.year_end ?? '?'})` : '';
    const cc = r.displacement_cc ? ` ${r.displacement_cc}cc` : '';
    const aliases = Array.isArray(r.aliases) && r.aliases.length > 0 ? ` aliases=${JSON.stringify(r.aliases)}` : '';
    console.log(`    ${r.model}${variant}${year}${cc}${aliases}`);
  }

  await client.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
