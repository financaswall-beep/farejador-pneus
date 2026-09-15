import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
let db: IntegrationDb;
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token', LOG_LEVEL: 'error',
    WHOLESALE_FINANCE: 'true', MATRIZ_CENTRAL_LEDGER: 'true' });
  db = await startPostgres();
}, 180_000);
afterAll(async () => { if (db) await stopPostgres(db); });

it('consolida capital físico, reservas e saldos de lotes sem misturar ambientes ou duplicar separações', async () => {
  const { getStockCosts } = await import('../../src/admin/painel/queries-stock-costs.js');
  const { separateTireLot } = await import('../../src/admin/painel/tire-lot-separation.js');
  const { registerWholesalePurchase } = await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const query = async (sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows;
  assert.equal((await getStockCosts(db.pool)).summary.capital, 0);
  await query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost)
    VALUES ('test','130/70-13','Marca A','meia_vida',50,2,50),('test','130/70-13','Marca B','meia_vida',50,6,70),
      ('test','90/90-12','Marca A','meia_vida',80,4,54),('test','110/70-17','Marca A','meia_vida',72,0,60),
      ('test','180/55-17','Marca A','meia_vida',60,2,68),('prod','130/70-13','Produção','meia_vida',999,0,900),
      ('test','100/80-17','Zerado','novo',0,0,99)`);
  const supplier = (await query(`INSERT INTO commerce.wholesale_suppliers(environment,name)
    VALUES ('test','Fornecedor de lotes QA custos') RETURNING id`))[0];
  const purchase = (quantity: number, total_cost: number, pending = false) => registerWholesalePurchase({
    environment: 'test', supplier_id: supplier.id, items: [], lot: { description: 'Lote QA custos', quantity, total_cost },
    payment_status: 'pending', due_date: '2026-12-31', receipt_status: pending ? 'pending' : 'received',
    created_by: 'owner:qa', idempotency_key: randomUUID()
  }, db.pool);
  const first = await purchase(100, 500);
  await purchase(80, 480); await purchase(400, 8000, true);
  // Remaining inventory after a partial sale; original entry cost stays immutable.
  await query(`UPDATE commerce.tire_lots SET quantity_on_hand=60,quantity_reserved=5,remaining_cost=300 WHERE id=$1`, [first.lot_id]);
  const data = await getStockCosts(db.pool);
  assert.deepEqual(data.summary, { capital: 19500, quantity: 452, catalog_capital: 18720, catalog_quantity: 312,
    lot_capital: 780, lot_quantity: 140, open_lots: 2, zero_cost_quantity: 0 });
  assert.equal(data.catalog.length, 4);
  const group = data.catalog.find((row: any) => row.measure === '130/70-13');
  assert.equal(group.variants.length, 2); assert.equal(group.unit_cost, 60);
  assert.equal(group.quantity_on_hand, 100); assert.equal(group.quantity_reserved, 8);
  assert.equal(group.quantity_available, 92); assert.equal(group.capital, 6000);
  assert.equal(data.lots[0].quantity_available, 55); assert.equal(data.lots[0].capital, 300);
  const separated = await separateTireLot({ stock_id: group.variants[0].id, description: 'Triagem QA custos', quantity: 10,
    reason: 'Separar pneus para borracharia', idempotency_key: randomUUID() }, 'owner:qa', db.pool);
  const after = await getStockCosts(db.pool);
  assert.equal(after.summary.capital, data.summary.capital); assert.equal(after.summary.quantity, 452);
  assert.equal(after.summary.catalog_capital, 18220); assert.equal(after.summary.lot_capital, 1280);
  assert.equal(after.lots.find((row: any) => row.id === separated.id).capital, 500);
  await query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES ('test','130/70-13','Sem custo informado','novo',3,0),('test','90/90-12','Fracionado','novo',3,33.333333)`);
  const zero = await getStockCosts(db.pool);
  assert.equal(zero.summary.zero_cost_quantity, 3); assert.equal(zero.summary.capital, 19600);
  assert.equal(zero.catalog.filter((row: any) => row.measure === '130/70-13').length, 2, 'conditions stay separate');
  const fraction = zero.catalog.find((row: any) => row.measure === '90/90-12' && row.tire_condition === 'novo');
  for (let i=0; i<3; i++) {
    await separateTireLot({ stock_id: fraction.variants[0].id, description: 'Centavos', quantity: 1,
      reason: 'Triagem parcial', idempotency_key: randomUUID() }, 'owner:qa', db.pool);
    assert.equal((await getStockCosts(db.pool)).summary.capital, 19600, 'rounding preserves total after each separation');
  }
}, 60_000);
