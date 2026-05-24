'use strict';

/**
 * Fix: "Fan" sozinho hoje so eh alias da CG 150 (year_end=2015).
 * Cliente que diz "fan 2019" nao resolve (CG 150 fora do range, CG 160 sem alias).
 * Adiciona Fan/fan/CG Fan/Honda Fan como alias da CG 160 (2015-2026) tambem.
 *
 * DRY-RUN: node --env-file=.env scripts/fix-fan-alias.cjs
 * COMMIT:  COMMIT=1 node --env-file=.env scripts/fix-fan-alias.cjs
 */

const { Client } = require('pg');
const COMMIT = process.env.COMMIT === '1';

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN');

    const before = await c.query(
      "SELECT make, model, year_start, year_end, aliases FROM commerce.vehicle_models WHERE id='600aa15b-689f-4cf9-9387-9ef171eb820e';"
    );
    console.log('CG 160 ANTES:', before.rows[0]);

    const newAliases = ['CG 160','cg 160','CG160','cg160','Fan','fan','Fan 160','CG Fan','CG 160 Fan','Honda Fan','Honda CG 160 Fan'];
    await c.query(
      "UPDATE commerce.vehicle_models SET aliases = $1::text[] WHERE id='600aa15b-689f-4cf9-9387-9ef171eb820e';",
      [newAliases]
    );

    const after = await c.query(
      "SELECT make, model, aliases FROM commerce.vehicle_models WHERE id='600aa15b-689f-4cf9-9387-9ef171eb820e';"
    );
    console.log('CG 160 DEPOIS:', after.rows[0]);

    console.log('\n--- TESTE resolve_vehicle_model ---');
    const cases = [
      ['Fan', 2019],
      ['fan', 2019],
      ['Fan', 2012],   // deve resolver CG 150
      ['CG 160 Fan', 2020],
      ['Honda Fan', 2018],
    ];
    for (const [m, y] of cases) {
      const r = await c.query("SELECT vehicle_model_id, make, model, year_start, year_end, match_type, match_similarity FROM commerce.resolve_vehicle_model('prod'::env_t, $1, $2, 0.4);", [m, y]);
      console.log(`  resolve('${m}', ${y}):`, r.rows.length === 0 ? '(vazio)' : r.rows);
    }

    if (COMMIT) {
      await c.query('COMMIT');
      console.log('\n*** COMMIT ***');
    } else {
      await c.query('ROLLBACK');
      console.log('\n*** DRY-RUN: ROLLBACK ***');
    }
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('ERRO:', err.message);
    throw err;
  } finally {
    await c.end();
  }
}
main().catch(() => process.exit(1));
