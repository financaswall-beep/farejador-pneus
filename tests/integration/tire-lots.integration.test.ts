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

it('lista saldo, custo, origem e movimentos reais e separa sem duplicar estoque ou financeiro', async () => {
  const { listTireLots, listTireLotMovements, listLotSeparationSources, getTireLotPurchase } =
    await import('../../src/admin/painel/queries-tire-lots.js');
  const { separateTireLot } = await import('../../src/admin/painel/tire-lot-separation.js');
  const { registerWholesalePurchase } = await import('../../src/admin/painel/queries-fornecedores-registro.js');
  const query = async (sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows;
  const supplier = (await query(`INSERT INTO commerce.wholesale_suppliers(environment,name)
    VALUES ('test','Fornecedor QA Estoque Lotes') RETURNING id`))[0];
  const purchase = await registerWholesalePurchase({ environment: 'test', supplier_id: supplier.id,
    items: [], lot: { description: 'Pneus para borracharia', quantity: 80, total_cost: 480 },
    payment_status: 'paid', payment_method: 'Pix', receipt_status: 'received',
    created_by: 'owner:qa', idempotency_key: randomUUID() }, db.pool);
  await registerWholesalePurchase({ environment: 'test', supplier_id: supplier.id,
    items: [], lot: { description: 'A caminho QA', quantity: 20, total_cost: 150 },
    payment_status: 'pending', due_date: '2026-12-31', receipt_status: 'pending',
    created_by: 'owner:qa', idempotency_key: randomUUID() }, db.pool);
  await query(`UPDATE commerce.tire_lots SET quantity_reserved=3 WHERE id=$1`, [purchase.lot_id]);
  const list = await listTireLots({}, db.pool);
  assert.equal(list.total, 1); assert.equal(list.summary.available_quantity, 77);
  assert.equal(list.summary.remaining_cost, 480); assert.equal(list.rows[0].unit_cost, 6);
  assert.equal(list.rows[0].supplier_name, supplier.name ?? 'Fornecedor QA Estoque Lotes');
  assert.equal((await listTireLots({ status: 'pending' }, db.pool)).total, 1);
  assert.equal((await listTireLots({ search: 'não existe' }, db.pool)).total, 0);
  const origin = await getTireLotPurchase(purchase.lot_id!, db.pool);
  assert.equal(origin.id, purchase.purchase_id); assert.equal(origin.items_count, 80);
  assert.match(origin.order_code, /^OC-/); assert.equal(origin.items[0].item_kind, 'lot');
  assert.equal(await getTireLotPurchase(randomUUID(), db.pool), null);
  const source = (await query(`INSERT INTO commerce.wholesale_stock
    (environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost)
    VALUES ('test','130/70-13','QA-SEPARACAO','meia_vida',10,2,5.25) RETURNING id`))[0];
  const prodSource = (await query(`INSERT INTO commerce.wholesale_stock
    (environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES ('prod','130/70-13','QA-PROD','meia_vida',10,5.25) RETURNING id`))[0];
  const before = (await query(`SELECT (SELECT count(*) FROM finance.matriz_ledger_transactions) ledger,
    (SELECT count(*) FROM commerce.wholesale_purchases) purchases,
    (SELECT count(*) FROM finance.matriz_inventory_adjustments) adjustments`))[0];
  const body = { stock_id: source.id, description: 'Separados para lote', quantity: 6,
    reason: 'Triagem para venda no lote', idempotency_key: randomUUID() };
  const separated = await separateTireLot(body, 'owner:qa', db.pool);
  assert.deepEqual(await separateTireLot(body, 'owner:qa', db.pool), separated);
  await assert.rejects(() => separateTireLot({ ...body, quantity: 1 }, 'owner:qa', db.pool), /idempotency_conflict/);
  await assert.rejects(() => separateTireLot({ ...body, quantity: 3, idempotency_key: randomUUID() }, 'owner:qa', db.pool), /lot_source_insufficient/);
  await assert.rejects(() => separateTireLot({ ...body, stock_id: prodSource.id, idempotency_key: randomUUID() }, 'owner:qa', db.pool), /lot_source_not_found/);
  const stock = (await query(`SELECT quantity_on_hand,quantity_reserved FROM commerce.wholesale_stock WHERE id=$1`, [source.id]))[0];
  assert.equal(stock.quantity_on_hand, 4); assert.equal(stock.quantity_reserved, 2);
  const all = await listTireLots({}, db.pool);
  const lot = all.rows.find((row: { id: string }) => row.id === separated.id);
  assert.equal(lot.origin_type, 'separation'); assert.equal(lot.allocated_cost, 31.5);
  assert.equal(lot.available_quantity, 6); assert.equal(lot.exited_quantity, 0);
  assert.equal(all.summary.available_quantity, 83); assert.equal(all.summary.remaining_cost, 511.5);
  assert.equal((await listLotSeparationSources('QA-SEPARACAO', db.pool)).rows[0].available_quantity, 2);
  assert.equal((await listLotSeparationSources('QA-PROD', db.pool)).rows.length, 0);
  assert.equal(await getTireLotPurchase(separated.id, db.pool), null);
  const moves = await listTireLotMovements({ lot_id: separated.id }, db.pool);
  assert.equal(moves.total, 1); assert.equal(moves.rows[0].quantity_delta, 6);
  assert.equal(moves.rows[0].source, 'separation_in');
  const counterpart = (await query(`SELECT qty_delta,ref FROM commerce.wholesale_stock_movements
    WHERE environment='test' AND source='separacao_lote'`))[0];
  assert.equal(counterpart.qty_delta, -6); assert.equal(counterpart.ref, separated.id);
  assert.deepEqual((await query(`SELECT (SELECT count(*) FROM finance.matriz_ledger_transactions) ledger,
    (SELECT count(*) FROM commerce.wholesale_purchases) purchases,
    (SELECT count(*) FROM finance.matriz_inventory_adjustments) adjustments`))[0], before);
  assert.equal((await query(`SELECT count(*)::int n FROM commerce.wholesale_purchase_lines WHERE id=$1`, [separated.id]))[0].n, 0);
  await assert.rejects(() => query(`UPDATE commerce.tire_lots SET allocated_cost=30 WHERE id=$1`, [separated.id]), /lot_origin_immutable/);
  await assert.rejects(() => query(`DELETE FROM commerce.tire_lot_movements WHERE lot_id=$1`, [separated.id]), /lot_movement_immutable/);
  const fractional = (await query(`INSERT INTO commerce.wholesale_stock
    (environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES ('test','90/90-12','QA-CENTAVOS','meia_vida',3,33.333333) RETURNING id`))[0];
  for (let i=0; i<3; i++) await separateTireLot({ ...body, stock_id: fractional.id,
    quantity: 1, idempotency_key: randomUUID() }, 'owner:qa', db.pool);
  assert.equal(Number((await query(`SELECT sum(allocated_cost) amount FROM commerce.tire_lots
    WHERE environment='test' AND origin_stock_id=$1`, [fractional.id]))[0].amount), 100,
  'three partial separations preserve every cent of the original inventory value');
}, 60_000);
