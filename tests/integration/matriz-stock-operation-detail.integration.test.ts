import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('consulta operacional do Estoque da Matriz', () => {
  let db: IntegrationDb, stockId: string, unitId: string, contactId: string, activeId: string;
  let queries: typeof import('../../src/admin/caixa/operation-stock-detail.js');
  let list: typeof import('../../src/admin/caixa/operation-stock.js').getMatrizOperationStock;
  const movement = (qty: number, brand = 'Kenda', condition = 'novo') => ({ measure: '100/80-14', brand, tire_condition: condition, qty });
  async function order() {
    return (await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,unit_id,total_amount,fulfillment_mode)
      VALUES('test',$1,$2,89,'pickup') RETURNING id`, [contactId, unitId])).rows[0].id as string;
  }
  async function event(id: string, type: string, after: unknown[], before?: unknown[]) {
    await db.pool.query(`INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,actor_label,payload_after,payload_before)
      VALUES('test','stock','commerce.wholesale_stock',$1,$2,'integração',$3,$4)`,
    [id, type, JSON.stringify({ movements: after }), before ? JSON.stringify({ movements: before }) : null]);
  }
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test', CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token' });
    db = await startPostgres();
    queries = await import('../../src/admin/caixa/operation-stock-detail.js');
    ({ getMatrizOperationStock: list } = await import('../../src/admin/caixa/operation-stock.js'));
    unitId = (await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz')
      ON CONFLICT(environment,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id;
    contactId = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
      VALUES('test',991277,'Cliente da consulta') RETURNING id`)).rows[0].id;
    const product = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test','STK-MOTO','Pneu Moto','tire','Kenda','novo') RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type)
      VALUES('test',$1,'100/80-14','motorcycle')`, [product]);
    stockId = (await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost,vehicle_type)
      VALUES('test','100/80-14','Kenda','novo',10,2,40,'motorcycle') RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost,vehicle_type)
      VALUES('test','185/65-15','Pirelli','novo',2,100,'car'),('prod','100/80-14','Kenda','novo',99,40,'motorcycle')`);
    activeId = await order(); await event(activeId, 'matriz_galpao_reserved', [movement(3)]);
    await event(activeId, 'matriz_galpao_reservation_adjusted', [movement(2)], [movement(3)]);
    const released = await order(); await event(released, 'matriz_galpao_reserved', [movement(1)]);
    await event(released, 'matriz_galpao_reservation_released', [movement(1)]);
    const consumed = await order(); await event(consumed, 'matriz_galpao_reserved', [movement(1)]);
    await event(consumed, 'matriz_galpao_decrement', [movement(1)]);
    const other = await order(); await event(other, 'matriz_galpao_reserved', [movement(8, 'Outra marca'), movement(4, 'Kenda', 'meia_vida')]);
    await order();
    await db.pool.query(`INSERT INTO commerce.wholesale_stock_movements(environment,measure,brand,tire_condition,op,qty_before,qty_after,source,created_at)
      VALUES('test','100/80-14','Kenda','novo','update',9,10,'antigo',now()-interval '100 days')`);
  }, 180_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  it('mostra carro e moto pelo cadastro, mantém o saldo oficial e não expõe custo', async () => {
    const data = await list(db.pool);
    const moto = data.rows.find(r => r.stock_id === stockId)!;
    expect(moto).toMatchObject({ vehicle_type: 'motorcycle', quantity_on_hand: 10, quantity_reserved: 2, quantity_available: 8 });
    expect(data.rows.find(r => r.brand === 'Pirelli')).toMatchObject({ vehicle_type: 'car' });
    expect(data.rows).toHaveLength(2);
    expect(moto).not.toHaveProperty('unit_cost');
  });
  it('usa somente a última reserva ativa, exclui concluídas e não mistura marcas nem condições', async () => {
    const data = await queries.getMatrizStockReservations(stockId, 1, db.pool);
    expect(data.reservations.rows).toEqual([expect.objectContaining({ order_id: activeId, quantity: 2, customer_name: 'Cliente da consulta', fulfillment_mode: 'pickup' })]);
    expect(data.reservations.has_more).toBe(false);
    expect((await queries.getMatrizStockReservations(stockId, 2, db.pool)).reservations.rows).toEqual([]);
  });
  it('separa o delta de reserva do físico, filtra período e pagina sem expor custo', async () => {
    const data = await queries.getMatrizStockHistory(stockId, 1, 30, db.pool);
    expect(data.history.rows.some(r => r.kind === 'reservation' && r.source === 'matriz_galpao_reservation_adjusted' && r.quantity_delta === -1)).toBe(true);
    expect(data.history.rows.some(r => r.kind === 'reservation' && r.source === 'matriz_galpao_decrement' && r.quantity_delta === -1)).toBe(true);
    expect(data.history.rows.some(r => r.kind === 'physical' && r.quantity_delta === 10)).toBe(true);
    expect(data.history.rows.some(r => r.source === 'antigo')).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/cost_before|cost_after|unit_cost/);
    const all = await queries.getMatrizStockHistory(stockId, 1, null, db.pool);
    expect(all.history.rows.some(r => r.source === 'antigo')).toBe(true);
    expect((await queries.getMatrizStockHistory(stockId, 2, 90, db.pool)).history.rows).toEqual([]);
  });
  it('não aceita ID de outro ambiente nem ID inexistente', async () => {
    const prod = (await db.pool.query(`SELECT id FROM commerce.wholesale_stock WHERE environment='prod' AND measure='100/80-14'`)).rows[0].id;
    await expect(queries.getMatrizOperationStockItem(prod, db.pool)).rejects.toMatchObject({ status: 404 });
    await expect(queries.getMatrizOperationStockItem(randomUUID(), db.pool)).rejects.toMatchObject({ status: 404 });
  });
  it('pagina todas as reservas sem cortar silenciosamente os pedidos seguintes', async () => {
    await db.pool.query(`UPDATE commerce.wholesale_stock SET quantity_on_hand=100,quantity_reserved=23 WHERE id=$1`, [stockId]);
    for (let index = 0; index < 21; index++) await event(await order(), 'matriz_galpao_reserved', [movement(1)]);
    const first = await queries.getMatrizStockReservations(stockId, 1, db.pool);
    const second = await queries.getMatrizStockReservations(stockId, 2, db.pool);
    expect(first.reservations.rows).toHaveLength(20); expect(first.reservations.has_more).toBe(true);
    expect(second.reservations.rows).toHaveLength(2); expect(second.reservations.has_more).toBe(false);
    expect(new Set([...first.reservations.rows, ...second.reservations.rows].map(row => row.order_id)).size).toBe(22);
  });
});
