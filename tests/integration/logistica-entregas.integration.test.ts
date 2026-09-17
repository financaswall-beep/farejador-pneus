import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
let container: StartedPostgreSqlContainer; let db: Pool;
let list: typeof import('../../src/admin/painel/queries-logistica-entregas.js').listMatrizDeliveries;
let parse: typeof import('../../src/admin/painel/queries-logistica-entregas.js').logisticsDeliveriesQuery;
// Banco efêmero com as colunas usadas pela consulta; nenhum acesso ao banco de produção.
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test', CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token' });
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  db = new Pool({ connectionString: container.getConnectionUri().replace('@localhost:', '@127.0.0.1:') });
  ({ listMatrizDeliveries: list, logisticsDeliveriesQuery: parse } = await import('../../src/admin/painel/queries-logistica-entregas.js'));
  await db.query(`
    CREATE SCHEMA commerce; CREATE SCHEMA core;
    CREATE TABLE core.units(id text, environment text, slug text);
    CREATE TABLE core.contacts(id text, environment text, name text, phone_e164 text);
    CREATE TABLE commerce.customers(id text, environment text, name text, phone_e164 text);
    CREATE TABLE commerce.products(id text, environment text, product_name text);
    CREATE TABLE commerce.matriz_delivery_trips(id text, environment text, trip_number text, status text, courier_name text, courier_collaborator_id text, deleted_at timestamptz);
    CREATE TABLE commerce.orders(id text, environment text, order_number text, unit_id text, contact_id text, customer_id text, status text, delivery_status text, delivery_address text, total_amount numeric, payment_method text, created_at timestamptz, dispatched_at timestamptz, delivered_at timestamptz, delivery_failure_reason text, trip_id text, delivery_courier text, scheduled_delivery_date date, fulfillment_mode text);
    CREATE TABLE commerce.order_items(id text, environment text, order_id text, product_id text, quantity numeric, unit_price numeric, discount_amount numeric, created_at timestamptz);
    INSERT INTO core.units VALUES ('main','test','main'),('prod','prod','main'),('partner','test','partner');
    INSERT INTO core.contacts VALUES ('c','test','Marina Costa','5511999999999'),('prod-c','prod','Segredo','5511888888888');
    INSERT INTO commerce.products VALUES ('p','test','Pneu 130/70-13');
    INSERT INTO commerce.matriz_delivery_trips VALUES ('trip','test','204','open','Marcos Reis','courier',NULL);
    INSERT INTO commerce.orders(id,environment,order_number,unit_id,contact_id,status,delivery_status,delivery_address,total_amount,created_at,scheduled_delivery_date,fulfillment_mode,trip_id)
      SELECT n::text,'test',n::text,'main','c',CASE WHEN n=13 THEN 'cancelled' ELSE 'open' END,
        CASE WHEN n<=9 THEN 'pending' WHEN n<=11 THEN 'delivered' ELSE 'failed' END,
        'Icaraí',n*10,'2024-01-01','2024-01-02','delivery',CASE WHEN n>9 THEN 'trip' END FROM generate_series(1,13) n;
    INSERT INTO commerce.orders(id,environment,order_number,unit_id,contact_id,status,delivery_status,total_amount,created_at,scheduled_delivery_date,fulfillment_mode)
      VALUES ('private','prod','999','prod','prod-c','open','pending',999,'2024-01-01','2024-01-02','delivery'),('partner','test','888','partner','c','open','pending',888,'2024-01-01','2024-01-02','delivery');
    INSERT INTO commerce.order_items VALUES ('item','test','1','p',2,99,10,'2024-01-01');
  `);
}, 120000);
afterAll(async () => { if (db) await db.end(); if (container) await container.stop(); });
describe('Consulta paginada de Entregas no PostgreSQL', () => {
  const f = { from: '2024-01-01', to: '2024-01-03' };
  it('consulta pedidos antigos, isola matriz/ambiente, conta situações e lê preços reais', async () => {
    const result = await list(parse.parse(f), 'test', db);
    expect(result.total).toBe(13); expect(result.rows).toHaveLength(8);
    expect(result.counts).toEqual({ all: 13, pending: 9, dispatched: 0, delivered: 2, failed: 2 });
    expect(result.rows.find((d: any) => d.order_id === '1').items).toEqual([{ label: 'Pneu 130/70-13', quantity: 2, unit_price: 99, total: 188 }]);
    expect(result.couriers).toEqual([{ id: 'courier', name: 'Marcos Reis' }]);
    const next = await list(parse.parse({ ...f, page: 100 }), 'test', db);
    expect(next.page).toBe(2); expect(next.rows).toHaveLength(5);
    expect(new Set([...result.rows, ...next.rows].map((d: any) => d.order_id)).size).toBe(13);
  });
  it('filtra situação, responsável, busca literal e ordena valores numericamente', async () => {
    const done = await list(parse.parse({ ...f, status: 'delivered', courier: 'courier' }), 'test', db);
    expect(done.total).toBe(2); expect(done.counts.all).toBe(4);
    const none = await list(parse.parse({ ...f, q: '%' }), 'test', db); expect(none.total).toBe(0); expect(none.rows).toEqual([]); expect(none.page).toBe(1);
    const search = await list(parse.parse({ ...f, q: '#13' }), 'test', db); expect(search.rows[0].status).toBe('cancelled');
    for (const sort of ['scheduled_asc','scheduled_desc','customer_asc','value_desc']) {
      const r = await list(parse.parse({ ...f, sort }), 'test', db); expect(r.rows).toHaveLength(8);
      if (sort === 'value_desc') expect(r.rows[0].total_amount).toBe('130');
    }
  });
});
