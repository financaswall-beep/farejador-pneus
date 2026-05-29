'use strict';
// Aplica a migration 0069 (pedido de entrega COD) com smoke antes/depois.
//   Dry-run (padrao):  node scripts/aplicar-0069.cjs
//   Aplicar de fato:   node scripts/aplicar-0069.cjs --commit
const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const COMMIT = process.argv.includes('--commit');
const SLUG = 'borracharia-rio-do-ouro';

// Carrega .env (sem dotenv).
(function loadEnv() {
  if (process.env.DATABASE_URL) return;
  const p = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
})();

async function constraintDef(client) {
  const r = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'partner_orders_delivery_status_check'`,
  );
  return r.rows[0] ? r.rows[0].def : '(constraint inexistente)';
}
async function summary(client) {
  const r = await client.query(
    `SELECT sales_month, orders_month, open_receivables_total
       FROM network.partner_unit_summary WHERE slug = $1 AND environment = 'prod'`,
    [SLUG],
  );
  return r.rows[0] || null;
}

async function main() {
  const sql = fs.readFileSync(path.resolve(__dirname, '..', 'db', 'migrations', '0069_partner_delivery_cod.sql'), 'utf8');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log(`=== APLICAR MIGRATION 0069 (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  await client.query('BEGIN');
  try {
    console.log('--- ANTES ---');
    console.log('constraint:', await constraintDef(client));
    console.log('resumo unidade:', JSON.stringify(await summary(client)));

    console.log('\n--- Aplicando 0069 ---');
    await client.query(sql);
    console.log('OK');

    console.log('\n--- DEPOIS ---');
    const def = await constraintDef(client);
    console.log('constraint:', def);
    console.log('resumo unidade:', JSON.stringify(await summary(client)));

    // Prova que o estado 'failed' agora e aceito (sem persistir: savepoint + rollback).
    await client.query('SAVEPOINT s_failed');
    const oneDelivery = await client.query(
      `SELECT id FROM commerce.partner_orders
        WHERE fulfillment_mode = 'delivery' AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    );
    if (oneDelivery.rowCount === 1) {
      await client.query(`UPDATE commerce.partner_orders SET delivery_status = 'failed' WHERE id = $1`, [oneDelivery.rows[0].id]);
      console.log("teste 'failed': constraint ACEITA o novo estado (rollback do teste em seguida)");
    }
    await client.query('ROLLBACK TO SAVEPOINT s_failed');

    if (!def.includes("'failed'")) throw new Error("constraint nao contem 'failed' apos aplicar — abortando");

    if (COMMIT) {
      await client.query('COMMIT');
      console.log('\n*** COMMIT efetuado. 0069 aplicada em prod. ***');
    } else {
      await client.query('ROLLBACK');
      console.log('\n*** DRY-RUN: ROLLBACK. Rode com --commit pra aplicar. ***');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erro:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}
main();
