import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
let db: IntegrationDb;
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token', LOG_LEVEL: 'error' });
  db = await startPostgres({ throughMigration: '0280_wholesale_purchase_groups.sql' });
  process.env.DATABASE_URL = db.connectionString; vi.resetModules();
}, 180000);
afterAll(async () => { if (db) await stopPostgres(db); vi.resetModules(); });
it('antes da migration nova, preserva formação antiga, consulta de lotes e histórico antigo', async () => {
  const { tireTransfersReady } = await import('../../src/admin/painel/tire-transfer-read.js');
  expect(await tireTransfersReady(db.pool)).toBe(false);
  const id = (await db.pool.query(`INSERT INTO commerce.wholesale_stock
    (environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES ('test','130/70-13','Pirelli','meia_vida',5,10) RETURNING id`)).rows[0].id;
  const { separateTireLot } = await import('../../src/admin/painel/tire-lot-separation.js');
  const result = await separateTireLot({ stock_id: id, description: 'Legado preservado', quantity: 2,
    reason: 'Formação antiga preservada', idempotency_key: randomUUID() }, 'owner:test', db.pool);
  const { listTireLots, listTireLotMovements } = await import('../../src/admin/painel/queries-tire-lots.js');
  expect((await listTireLots({}, db.pool)).rows[0].quantity_on_hand).toBe(2);
  expect((await listTireLotMovements({ lot_id: result.id }, db.pool)).total).toBe(1);
  expect((await db.pool.query('SELECT quantity_on_hand FROM commerce.wholesale_stock WHERE id=$1', [id])).rows[0].quantity_on_hand).toBe(3);
});
