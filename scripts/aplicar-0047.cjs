'use strict';
const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const COMMIT = process.argv.includes('--commit');

async function main() {
  const sql = fs.readFileSync(path.resolve('db/migrations/0047_resolve_vehicle_model_prefers_useful.sql'), 'utf8');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log(`=== APLICAR MIGRATION 0047 (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  try {
    await client.query('BEGIN');

    // Smoke tests ANTES
    console.log('--- ANTES da migration ---');
    for (const probe of ['PCX', 'Biz', 'CRF', 'XRE', 'Tuareg 660']) {
      const r = await client.query(`SELECT model, variant, year_start, year_end, match_type, match_similarity FROM commerce.resolve_vehicle_model('prod'::env_t, $1, NULL, 0.3) LIMIT 3;`, [probe]);
      console.log(`  resolve('${probe}'): ${r.rows.length}`);
      for (const row of r.rows) console.log(`    ${row.model} ${row.variant ?? ''} | anos=${row.year_start ?? '?'}-${row.year_end ?? '?'} | ${row.match_type} sim=${row.match_similarity}`);
    }

    // Aplica
    console.log('\n--- aplicando 0047 ---');
    await client.query(sql);
    console.log('OK');

    // Smoke tests DEPOIS
    console.log('\n--- DEPOIS da migration ---');
    const tests = [
      { input: 'PCX', year: null,    expect: 'PCX 160 (com fitment) primeiro' },
      { input: 'PCX', year: 2025,    expect: 'PCX 160 (anos cobrem 2025)' },
      { input: 'PCX', year: 2018,    expect: 'PCX 150 (anos cobrem 2018)' },
      { input: 'Biz', year: null,    expect: 'Biz 125 (com fitment) primeiro' },
      { input: 'CRF', year: null,    expect: 'CRF (algum com fitment) primeiro' },
      { input: 'CRF', year: 2022,    expect: 'CRF 1100L Africa Twin (anos cobrem 2022)' },
      { input: 'XRE', year: 2020,    expect: 'XRE 300 (anos cobrem 2020)' },
      { input: 'Tuareg 660', year: null, expect: 'Aprilia Tuareg 660 (unica opcao)' },
      { input: 'NMAX', year: null,   expect: 'NMAX 160 (alias + fitment)' },
      { input: 'Fan', year: null,    expect: 'CG 150 Fan (alias + fitment)' },
      { input: 'MT-07', year: null,  expect: 'MT-07 exact_full + fitment' },
    ];
    for (const t of tests) {
      const r = await client.query(`SELECT model, variant, year_start, year_end, match_type, match_similarity FROM commerce.resolve_vehicle_model('prod'::env_t, $1, $2, 0.3) LIMIT 3;`, [t.input, t.year]);
      console.log(`  resolve('${t.input}'${t.year ? `, ${t.year}` : ''}): ${r.rows.length} | esperado: ${t.expect}`);
      for (const row of r.rows.slice(0, 3)) {
        console.log(`    -> ${row.model} ${row.variant ?? ''} | anos=${row.year_start ?? '?'}-${row.year_end ?? '?'} | ${row.match_type} sim=${row.match_similarity}`);
      }
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log('\n*** COMMIT efetuado. ***');
    } else {
      await client.query('ROLLBACK');
      console.log('\n*** DRY-RUN: ROLLBACK efetuado. Rode com --commit pra aplicar. ***');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}
main();
