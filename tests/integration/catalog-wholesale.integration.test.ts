import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, applyMigrationFile, type IntegrationDb } from './helpers/postgres.js';
import type { Pool } from 'pg';
let db: IntegrationDb, defaultPool: Pool;
let wholesale: typeof import('../../src/admin/painel/queries-catalogo-wholesale.js');
let pricing: typeof import('../../src/shared/catalog-pricing.js');
const migration = '0267_catalog_wholesale_prices.sql';
const botViews = ['current_prices', 'matriz_current_prices', 'product_full'];
async function product(environment: 'test' | 'prod' = 'test', type = 'tire') {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO commerce.products
    (id,environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES ($1::uuid,$2,$1::uuid::text,'Pneu integração',$3,$1::uuid::text,$4)`,
    [id, environment, type, type === 'tire' ? 'meia_vida' : null]);
  if (type === 'tire') await db.pool.query(`INSERT INTO commerce.tire_specs
    (environment,product_id,tire_size) VALUES ($1,$2,'90/90-18')`, [environment, id]);
  return id;
}
beforeAll(async () => {
  db = await startPostgres({ throughMigration: '0266_partner_replenishment_demo.sql' });
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    DATABASE_SSL: 'false', CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'fixture-token' });
  const before = await db.pool.query(`SELECT viewname,definition FROM pg_views
    WHERE schemaname='commerce' AND viewname=ANY($1::text[]) ORDER BY viewname`, [botViews]);
  await applyMigrationFile(db.pool, migration);
  const after = await db.pool.query(`SELECT viewname,definition FROM pg_views
    WHERE schemaname='commerce' AND viewname=ANY($1::text[]) ORDER BY viewname`, [botViews]);
  expect(after.rows).toEqual(before.rows);
  ({ pool: defaultPool } = await import('../../src/persistence/db.js'));
  wholesale = await import('../../src/admin/painel/queries-catalogo-wholesale.js');
  pricing = await import('../../src/shared/catalog-pricing.js');
}, 180000);
afterAll(async () => { if (defaultPool) await defaultPool.end(); if (db) await stopPostgres(db); });
const save = (productId: string, priceAmount: number | null, environment: 'prod' | 'test' = 'test') =>
  wholesale.setCatalogWholesalePrice({ productId, priceAmount, reason: 'Tabela parceiros',
    actorLabel: 'Fixture proprietário', environment }, db.pool);
describe('Catálogo da Matriz — preço de atacado isolado', () => {
  it('não publica oferta automaticamente nem concede acesso direto ao parceiro', async () => {
    expect((await db.pool.query('SELECT count(*)::int n FROM commerce.wholesale_product_prices')).rows[0].n).toBe(0);
    const access = await db.pool.query(`SELECT
      has_table_privilege('farejador_partner_app','commerce.wholesale_product_prices','SELECT') table_access,
      has_table_privilege('farejador_partner_app','commerce.wholesale_current_prices','SELECT') view_access`);
    expect(access.rows[0]).toEqual({ table_access: false, view_access: false });
  });
  it('muda atacado mantendo preços efetivamente lidos pelo bot da Matriz e da Rede', async () => {
    const id = await product();
    await db.pool.query(`INSERT INTO commerce.matriz_product_prices
      (environment,product_id,price_amount) VALUES ('test',$1,95)`, [id]);
    await db.pool.query(`INSERT INTO commerce.product_prices
      (environment,product_id,price_amount,price_type) VALUES ('test',$1,105,'regular')`, [id]);
    await save(id, 65);
    expect((await pricing.loadCurrentCatalogPrices(db.pool, 'test', [id])).get(id)?.price_amount).toBe(95);
    expect((await pricing.loadCurrentPartnerPrices(db.pool, 'test', [id])).get(id)?.price_amount).toBe(105);
    const bot = await db.pool.query('SELECT price_amount FROM commerce.product_full WHERE environment=$1 AND product_id=$2', ['test', id]);
    expect(Number(bot.rows[0].price_amount)).toBe(105);
    const overview = await wholesale.getMatrixCatalogWithWholesale('test', db.pool);
    expect(overview.rows.find(row => row.product_id === id)).toMatchObject({ price_amount: 95, wholesale_price_amount: 65 });
    await save(id, 75);
    await save(id, null);
    expect((await pricing.loadCurrentCatalogPrices(db.pool, 'test', [id])).get(id)?.price_amount).toBe(95);
    expect((await pricing.loadCurrentPartnerPrices(db.pool, 'test', [id])).get(id)?.price_amount).toBe(105);
    expect((await db.pool.query('SELECT * FROM commerce.wholesale_current_prices WHERE product_id=$1', [id])).rows).toEqual([]);
    const history = await wholesale.getCatalogWholesaleHistory(id, 'test', db.pool);
    expect(history).toHaveLength(3);
    expect(history.map(row => row.price_amount === null ? null : Number(row.price_amount))).toEqual([null, 75, 65]);
    expect(history[0]).toMatchObject({ actor_label: 'Fixture proprietário', reason: 'Tabela parceiros' });
  });
  it('não mistura ambientes e recusa serviços e produtos arquivados', async () => {
    const id = await product('prod');
    await expect(save(id, 65, 'test')).rejects.toThrow('catalog_product_not_found');
    await save(id, 65, 'prod');
    expect((await wholesale.getCatalogWholesaleHistory(id, 'test', db.pool))).toEqual([]);
    await expect(db.pool.query(`INSERT INTO commerce.wholesale_product_prices
      (environment,product_id,price_amount) VALUES ('test',$1,65)`, [id])).rejects.toThrow();
    const serviceId = await product('test', 'service');
    await expect(save(serviceId, 65)).rejects.toThrow('catalog_wholesale_product_invalid');
    const archived = await product();
    await db.pool.query('UPDATE commerce.products SET deleted_at=now() WHERE id=$1', [archived]);
    await expect(save(archived, 65)).rejects.toThrow('catalog_product_not_found');
  });
  it('conserva snapshots em produção, permitindo só encerrar a vigência', async () => {
    const id = await product('prod'), result = await save(id, 65, 'prod');
    await expect(db.pool.query('UPDATE commerce.wholesale_product_prices SET price_amount=70 WHERE id=$1', [result.price_id]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(db.pool.query('DELETE FROM commerce.wholesale_product_prices WHERE id=$1', [result.price_id]))
      .rejects.toMatchObject({ code: '55000' });
    await save(id, null, 'prod');
    await expect(db.pool.query('UPDATE commerce.wholesale_product_prices SET valid_until=NULL WHERE id=$1', [result.price_id]))
      .rejects.toMatchObject({ code: '55000' });
    expect((await db.pool.query('SELECT count(*)::int n FROM commerce.wholesale_product_prices WHERE product_id=$1', [id])).rows[0].n).toBe(1);
  });
  it('serializa preços concorrentes sem janela duplicada ou sobreposta', async () => {
    const id = await product();
    await Promise.all([save(id, 65), save(id, 75), save(id, 85)]);
    const rows = await db.pool.query(`SELECT * FROM commerce.wholesale_product_prices WHERE product_id=$1`, [id]);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.filter(row => row.valid_until === null)).toHaveLength(1);
    const overlap = await db.pool.query(`SELECT count(*)::int n FROM commerce.wholesale_product_prices a
      JOIN commerce.wholesale_product_prices b ON a.product_id=b.product_id AND a.id<b.id
      WHERE a.product_id=$1 AND tstzrange(a.valid_from,a.valid_until,'[)') && tstzrange(b.valid_from,b.valid_until,'[)')`, [id]);
    expect(overlap.rows[0].n).toBe(0);
    await expect(db.pool.query(`INSERT INTO commerce.wholesale_product_prices
      (environment,product_id,price_amount,valid_from) VALUES ('test',$1,95,now()-interval '1 hour')`, [id]))
      .rejects.toMatchObject({ code: '23P01' });
  });
});
