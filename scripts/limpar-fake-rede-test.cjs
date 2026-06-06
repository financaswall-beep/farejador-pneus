'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// LIMPEZA dos parceiros FAKE da prova do motor (Fase 2). environment='test' SEMPRE.
// Apaga estoque, cobertura, tokens, permissões, partner_units, partners, units e o
// produto+preço fake. NÃO toca em analytics (append-only) nem em dado real.
// Idempotente. Usado pelo seed (reset) e standalone.
//   node --env-file=.env scripts/limpar-fake-rede-test.cjs
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const { Client } = require('pg');

const ENV = 'test';
const FAKE_SLUGS = ['fake-rede-a', 'fake-rede-b', 'fake-rede-c', 'fake-rede-d'];
const FAKE_PRODUCT_CODE = 'FAKE-REDE-PNEU';

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = fs.readFileSync('.env', 'utf8');
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error('DATABASE_URL não achado no .env');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

// Trava dura: nunca rodar contra a partição prod. Os dados são environment='test',
// mas recusamos se o ambiente carregado disser 'prod' (evita confusão de operador).
function assertTest() {
  if (process.env.FAREJADOR_ENV && process.env.FAREJADOR_ENV !== 'test') {
    throw new Error(`ABORTADO: só roda em test (FAREJADOR_ENV=${process.env.FAREJADOR_ENV}).`);
  }
}

async function limpar(client) {
  const { rows } = await client.query(
    `SELECT id AS partner_unit_id, unit_id, partner_id
       FROM network.partner_units WHERE environment=$1 AND slug = ANY($2)`,
    [ENV, FAKE_SLUGS],
  );
  const puIds = rows.map((r) => r.partner_unit_id);
  const unitIds = rows.map((r) => r.unit_id);
  const partnerIds = rows.map((r) => r.partner_id);

  if (unitIds.length) {
    await client.query(`DELETE FROM commerce.partner_stock_levels WHERE environment=$1 AND unit_id = ANY($2)`, [ENV, unitIds]);
    await client.query(`DELETE FROM network.unit_coverage WHERE environment=$1 AND unit_id = ANY($2)`, [ENV, unitIds]);
  }
  if (puIds.length) {
    await client.query(`DELETE FROM network.partner_access_tokens WHERE environment=$1 AND partner_unit_id = ANY($2)`, [ENV, puIds]);
    await client.query(`DELETE FROM network.partner_unit_permissions WHERE environment=$1 AND partner_unit_id = ANY($2)`, [ENV, puIds]);
    await client.query(`DELETE FROM network.partner_units WHERE environment=$1 AND id = ANY($2)`, [ENV, puIds]);
  }
  if (partnerIds.length) {
    await client.query(`DELETE FROM network.partners WHERE environment=$1 AND id = ANY($2)`, [ENV, partnerIds]);
  }
  if (unitIds.length) {
    await client.query(`DELETE FROM core.units WHERE environment=$1 AND id = ANY($2)`, [ENV, unitIds]);
  }

  const prod = await client.query(`SELECT id FROM commerce.products WHERE environment=$1 AND product_code=$2`, [ENV, FAKE_PRODUCT_CODE]);
  const prodIds = prod.rows.map((r) => r.id);
  if (prodIds.length) {
    await client.query(`DELETE FROM commerce.product_prices WHERE environment=$1 AND product_id = ANY($2)`, [ENV, prodIds]);
    await client.query(`DELETE FROM commerce.partner_stock_levels WHERE environment=$1 AND product_id = ANY($2)`, [ENV, prodIds]);
    await client.query(`DELETE FROM commerce.products WHERE environment=$1 AND id = ANY($2)`, [ENV, prodIds]);
  }

  return { partner_units: puIds.length, units: unitIds.length, partners: partnerIds.length, produtos: prodIds.length };
}

module.exports = { limpar, loadDatabaseUrl, assertTest, ENV, FAKE_SLUGS, FAKE_PRODUCT_CODE };

if (require.main === module) {
  (async () => {
    assertTest();
    const client = new Client({ connectionString: loadDatabaseUrl(), ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      await client.query('BEGIN');
      const res = await limpar(client);
      await client.query('COMMIT');
      console.log('Limpeza fake-rede (test):', res);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      await client.end();
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
