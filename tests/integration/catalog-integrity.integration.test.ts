import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

describe('migration 0197 — integridade do Catálogo', () => {
  it('recusa preço zero, sobreposição temporal e variante duplicada', async () => {
    const firstProduct = randomUUID();
    const secondProduct = randomUUID();
    await db.pool.query(
      `INSERT INTO commerce.products
         (id,environment,product_code,product_name,product_type,brand,tire_condition)
       VALUES ($1,'test',$2,'Pneu sem marca A','tire',NULL,'meia_vida'),
              ($3,'test',$4,'Pneu sem marca B','tire','Sem marca','meia_vida')`,
      [firstProduct, `CAT-${firstProduct}`, secondProduct, `CAT-${secondProduct}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs (environment,product_id,tire_size)
       VALUES ('test',$1,'140/70-17')`,
      [firstProduct],
    );
    await expect(db.pool.query(
      `INSERT INTO commerce.tire_specs (environment,product_id,tire_size)
       VALUES ('test',$1,'140/70R17')`,
      [secondProduct],
    )).rejects.toMatchObject({ code: '23505', message: expect.stringContaining('catalog_variant_duplicate') });

    await expect(db.pool.query(
      `INSERT INTO commerce.matriz_product_prices
         (environment,product_id,price_amount) VALUES ('test',$1,0)`,
      [firstProduct],
    )).rejects.toMatchObject({ code: '23514' });

    const firstPrice = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.matriz_product_prices
         (environment,product_id,price_amount) VALUES ('test',$1,100)
       RETURNING id`,
      [firstProduct],
    );
    await expect(db.pool.query(
      `INSERT INTO commerce.matriz_product_prices
         (environment,product_id,price_amount) VALUES ('test',$1,110)`,
      [firstProduct],
    )).rejects.toMatchObject({ code: '23P01', message: expect.stringContaining('catalog_price_window_overlap') });

    await db.pool.query(
      `UPDATE commerce.matriz_product_prices SET valid_until=now() WHERE id=$1`,
      [firstPrice.rows[0]!.id],
    );
    await expect(db.pool.query(
      `INSERT INTO commerce.matriz_product_prices
         (environment,product_id,price_amount) VALUES ('test',$1,110)`,
      [firstProduct],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it('instala guardas protegidas e restrições positivas nas três fontes', async () => {
    const constraints = await db.pool.query<{ constraint_name: string }>(
      `SELECT conname AS constraint_name FROM pg_constraint
        WHERE conname IN (
          'matriz_product_prices_price_amount_check',
          'product_prices_price_amount_check',
          'partner_stock_levels_sale_price_check'
        ) ORDER BY conname`,
    );
    expect(constraints.rows.map((row) => row.constraint_name)).toEqual([
      'matriz_product_prices_price_amount_check',
      'partner_stock_levels_sale_price_check',
      'product_prices_price_amount_check',
    ]);

    const guard = await db.pool.query(
      `SELECT p.prosecdef,
              has_function_privilege('farejador_partner_app',p.oid,'EXECUTE') AS partner_execute
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='commerce' AND p.proname IN (
          'guard_catalog_tire_variant','guard_catalog_price_window',
          'guard_catalog_price_history'
        ) ORDER BY p.proname`,
    );
    expect(guard.rows).toHaveLength(3);
    expect(guard.rows.every((row) => row.prosecdef && !row.partner_execute)).toBe(true);
  });

  it('preserva o histórico publicado em produção e permite apenas encerrar a janela', async () => {
    const productId = randomUUID();
    await db.pool.query(
      `INSERT INTO commerce.products
         (id,environment,product_code,product_name,product_type)
       VALUES ($1,'prod',$2,'Montagem teste','service')`,
      [productId, `SERV-${productId}`],
    );
    const price = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.matriz_product_prices
         (environment,product_id,price_amount) VALUES ('prod',$1,25)
       RETURNING id`,
      [productId],
    );
    const priceId = price.rows[0]!.id;
    await expect(db.pool.query(
      `UPDATE commerce.matriz_product_prices SET price_amount=30 WHERE id=$1`,
      [priceId],
    )).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('catalog_price_history_immutable') });
    await expect(db.pool.query(
      `UPDATE commerce.matriz_product_prices SET valid_until=now() WHERE id=$1`,
      [priceId],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(db.pool.query(
      `UPDATE commerce.matriz_product_prices SET valid_until=NULL WHERE id=$1`,
      [priceId],
    )).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('catalog_price_history_immutable') });
    await expect(db.pool.query(
      `DELETE FROM commerce.matriz_product_prices WHERE id=$1`,
      [priceId],
    )).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('catalog_price_history_immutable') });

    const networkPrice = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.product_prices
         (environment,product_id,price_amount,price_type) VALUES ('prod',$1,27,'regular')
       RETURNING id`,
      [productId],
    );
    const networkPriceId = networkPrice.rows[0]!.id;
    await expect(db.pool.query(
      `UPDATE commerce.product_prices SET price_amount=29 WHERE id=$1`,
      [networkPriceId],
    )).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('catalog_price_history_immutable') });
    await expect(db.pool.query(
      `DELETE FROM commerce.product_prices WHERE id=$1`,
      [networkPriceId],
    )).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('catalog_price_history_immutable') });
  });
});
