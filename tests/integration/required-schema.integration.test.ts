import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { assertRequiredSchema } from '../../src/persistence/required-schema.js';

let db: IntegrationDb;
beforeAll(async () => { db = await startPostgres(); }, 180000);
afterAll(async () => { if (db) await stopPostgres(db); });

describe('inicialização após todas as migrations', () => {
  it('aceita vendas de lotes com condição opcional protegida pelo CHECK', async () => {
    const columns = await db.pool.query(`SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='commerce' AND table_name='wholesale_order_items' AND column_name='tire_condition'`);
    expect(columns.rows[0].is_nullable).toBe('YES');
    await expect(assertRequiredSchema(db.pool)).resolves.toBeUndefined();
  });

  it('continua bloqueando condição opcional sem a proteção de tipo do item', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE commerce.wholesale_order_items DROP CONSTRAINT wholesale_item_kind_check');
      await expect(assertRequiredSchema(client as unknown as typeof db.pool)).rejects.toThrow('required_schema_missing');
      // A estrutura anterior à venda de lotes também continua aceita.
      await client.query('ALTER TABLE commerce.wholesale_order_items ALTER COLUMN tire_condition SET NOT NULL');
      await expect(assertRequiredSchema(client as unknown as typeof db.pool)).resolves.toBeUndefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
