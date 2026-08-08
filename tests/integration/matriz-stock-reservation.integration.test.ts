import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeMatrizGalpaoReservation,
  releaseMatrizGalpaoReservation,
  reserveMatrizGalpaoStock,
} from '../../src/atendente-v2/matriz-stock-reservation.js';
import { getMatrizWholesaleStockQty } from '../../src/atendente-v2/wholesale-stock-read.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('reserva de estoque da Matriz', () => {
  let db: IntegrationDb;
  let productId: string;
  const measure = '190/65-15';

  beforeAll(async () => {
    db = await startPostgres();
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type,brand,tire_condition)
       VALUES ('test','RESERVA-MATRIZ','Pneu reserva Matriz','tire','Sem marca','meia_vida')
       RETURNING id`,
    );
    productId = product.rows[0]!.id;
    await db.pool.query(
      `INSERT INTO commerce.tire_specs (environment,product_id,tire_size)
       VALUES ('test',$1,$2)`,
      [productId, measure],
    );
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock
         (environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
       VALUES ('test',$1,'Sem marca','meia_vida',5,40)`,
      [measure],
    );
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
  });

  beforeEach(async () => {
    await db.pool.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand=5,quantity_reserved=0
        WHERE environment='test' AND measure=$1`,
      [measure],
    );
  });

  async function inTransaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function stockState(): Promise<{
    quantity_on_hand: number; quantity_reserved: number; quantity_available: number;
  }> {
    const row = await db.pool.query<{
      quantity_on_hand: number; quantity_reserved: number;
    }>(
      `SELECT quantity_on_hand,quantity_reserved
         FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=$1`,
      [measure],
    );
    const client = await db.pool.connect();
    try {
      const available = await getMatrizWholesaleStockQty(client, 'test', productId);
      return { ...row.rows[0]!, quantity_available: available };
    } finally {
      client.release();
    }
  }

  it('mostra 4 disponiveis ao proximo cliente sem baixar o fisico antes da retirada', async () => {
    const firstOrderId = randomUUID();
    await inTransaction((client) => reserveMatrizGalpaoStock(
      client, 'test', firstOrderId, [{ productId, quantity: 1 }], true,
    ));
    expect(await stockState()).toEqual({
      quantity_on_hand: 5, quantity_reserved: 1, quantity_available: 4,
    });

    await expect(inTransaction((client) => reserveMatrizGalpaoStock(
      client, 'test', randomUUID(), [{ productId, quantity: 5 }], true,
    ))).rejects.toThrow('walkin_stock_insufficient');
    expect(await stockState()).toEqual({
      quantity_on_hand: 5, quantity_reserved: 1, quantity_available: 4,
    });

    await inTransaction((client) => consumeMatrizGalpaoReservation(
      client, 'test', firstOrderId,
    ));
    expect(await stockState()).toEqual({
      quantity_on_hand: 4, quantity_reserved: 0, quantity_available: 4,
    });
  });

  it('cancelamento libera a reserva sem devolver estoque que nunca foi baixado', async () => {
    const orderId = randomUUID();
    await inTransaction((client) => reserveMatrizGalpaoStock(
      client, 'test', orderId, [{ productId, quantity: 2 }], true,
    ));
    expect(await stockState()).toEqual({
      quantity_on_hand: 5, quantity_reserved: 2, quantity_available: 3,
    });

    await inTransaction(async (client) => {
      await releaseMatrizGalpaoReservation(client, 'test', orderId);
      await releaseMatrizGalpaoReservation(client, 'test', orderId);
    });
    expect(await stockState()).toEqual({
      quantity_on_hand: 5, quantity_reserved: 0, quantity_available: 5,
    });
  });
});
