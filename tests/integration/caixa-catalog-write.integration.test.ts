import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import type { CaixaAuth } from '../../src/admin/caixa/queries.js';

describe('catálogo compartilhado: gravações do app e leitura do web', () => {
  let db: IntegrationDb, app: FastifyInstance, defaultPool: Pool;
  let overview: typeof import('../../src/admin/painel/queries-catalogo.js').getCatalogOverview;
  const base = '/api/caixa/operacao/catalogo';
  const headers = { authorization: 'fixture-owner', 'x-stock': 'yes' };
  beforeAll(async () => {
    db = await startPostgres();
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
      DATABASE_SSL: 'false', CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'fixture-token' });
    vi.resetModules();
    ({ pool: defaultPool } = await import('../../src/persistence/db.js'));
    ({ getCatalogOverview: overview } = await import('../../src/admin/painel/queries-catalogo.js'));
    const { registerCaixaOperationStockRoutes } = await import('../../src/admin/caixa/route-operation-stock.js');
    app = Fastify();
    registerCaixaOperationStockRoutes(app, async () => {}, async (request, reply) => {
      if (!request.headers.authorization) { await reply.code(401).send({ error: 'unauthorized' }); return; }
      (request as FastifyRequest & { caixa: CaixaAuth }).caixa = {
        personId: 'fixture', collaboratorId: 'fixture', displayName: 'Proprietário local', username: 'fixture', job: 'colaborador',
        panelRole: request.headers.authorization === 'fixture-owner' ? 'owner' : 'admin',
        modules: { estoque: true, vendas: false, entregas: false, retiradas: false, financeiro: false },
      };
    }, async (request, reply) => { if (request.headers['x-stock'] !== 'yes') await reply.code(403).send({ error: 'module_forbidden' }); });
    await app.ready();
  }, 180000);
  afterAll(async () => { if (app) await app.close(); if (defaultPool) await defaultPool.end(); if (db) await stopPostgres(db); });
  const body = (brand: string, code: string) => ({ measure: '90/90-18', brand, tire_condition: 'novo',
    creation_mode: 'manual', product_code: code, product_name: 'Pneu ' + brand,
    vehicle_type: 'motorcycle', position: 'rear', price_amount: 129.9 });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url: base + url, headers, payload });

  it('exige acesso à Matriz, estoque e proprietário para mutações', async () => {
    expect((await app.inject({ url: base })).statusCode).toBe(401);
    expect((await app.inject({ url: base, headers: { authorization: 'fixture-owner' } })).statusCode).toBe(403);
    for (const [url, payload] of [['/products', body('Technic', 'TEC-APP')],
      ['/' + randomUUID() + '/spec', { reason: 'conferência' }],
      ['/' + randomUUID() + '/price', { price_amount: 100, reason: 'tabela' }],
      ['/' + randomUUID() + '/compatibility', {}]] as const) {
      expect((await app.inject({ method: 'POST', url: base + url, headers: { ...headers, authorization: 'fixture-admin' }, payload })).statusCode).toBe(403);
    }
    expect((await post('/products', { ...body('Technic', 'TEC-APP'), quantity: 50, unit_cost: 1 })).statusCode).toBe(400);
  });

  it('cria, configura e compartilha compatibilidades sem duplicar ou movimentar estoque/financeiro', async () => {
    const result = await post('/products', body('Technic', 'TEC-APP'));
    expect(result.statusCode, result.body).toBe(201); const id = result.json().product_id;
    const repeated = await post('/products', { ...body('Technic', 'TEC-APP-2'), measure: '90/90R18' });
    expect(repeated.statusCode).toBe(409); expect(repeated.json().error).toBe('catalog_variant_already_exists');
    const before = (await app.inject({ url: base, headers })).json();
    expect(before.rows.find((row: { product_id: string }) => row.product_id === id)).toMatchObject({ local_sale_price_min: 129.9, local_quantity_available: 0, catalogued: true });
    expect(JSON.stringify(before)).not.toMatch(/unit_cost|gross_profit|margin_percent|last_purchase_cost/);
    expect((await post('/' + id + '/spec', { vehicle_type: 'motorcycle', position: 'rear', tread_pattern: 'Conferido', load_index: '57', speed_rating: 'p', reason: 'Ficha conferida' })).statusCode).toBe(200);
    expect((await post('/' + id + '/price', { price_amount: 149.9, reason: 'Tabela atual' })).statusCode).toBe(200);
    const web = (await overview('test', db.pool)).rows as Array<Record<string, unknown>>;
    expect(web.find(row => row.product_id === id)).toMatchObject({ price_amount: 149.9, tread_pattern: 'Conferido', load_index: '57', speed_rating: 'P', tire_position: 'rear' });
    const vehicle = randomUUID();
    await db.pool.query(`INSERT INTO commerce.vehicle_models(id,environment,vehicle_type,make,model,variant,year_start)
      VALUES($1,'test','motorcycle','Teste','Veículo do app','Fixture',2020)`, [vehicle]);
    const fitment = { vehicle_model_id: vehicle, position: 'rear', year_start: 2020, year_end: 2024,
      source: 'manual', is_oem: false, confidence_level: 1, reason: 'Conferido no cadastro' };
    expect((await post('/' + id + '/compatibility', { ...fitment, year_end: 2019 })).statusCode).toBe(400);
    expect((await post('/' + id + '/compatibility', fitment)).statusCode).toBe(201);
    const second = await post('/products', body('Pirelli', 'PIR-APP')); expect(second.statusCode).toBe(201);
    const inherited = (await app.inject({ url: base + '/' + second.json().product_id + '/compatibility', headers })).json();
    expect(inherited.rows).toContainEqual(expect.objectContaining({ vehicle_model_id: vehicle, position: 'rear', year_start: 2020, year_end: 2024 }));
    expect((await app.inject({ method: 'DELETE', url: base + '/' + id + '/compatibility/' + vehicle + '/rear', headers, payload: { reason: 'Correção conferida' } })).statusCode).toBe(200);
    expect((await app.inject({ url: base + '/' + second.json().product_id + '/compatibility', headers })).json().rows).toEqual([]);
    const effects = (await db.pool.query(`SELECT (SELECT count(*) FROM commerce.wholesale_stock WHERE environment='test') stocks,
      (SELECT count(*) FROM commerce.wholesale_purchases WHERE environment='test') purchases,
      (SELECT count(*) FROM commerce.orders WHERE environment='test') orders,
      (SELECT count(*) FROM finance.matriz_ledger_entries WHERE environment='test') ledger`)).rows[0];
    expect(effects).toEqual({ stocks: '0', purchases: '0', orders: '0', ledger: '0' });
    expect((await db.pool.query("SELECT count(*)::int n FROM audit.events WHERE environment='test' AND actor_label LIKE 'Caixa:%'")).rows[0].n).toBeGreaterThan(4);
  });

  it('completa item do estoque com o mesmo saldo e custo e mantém ambientes separados', async () => {
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,vehicle_type,quantity_on_hand,quantity_reserved,unit_cost)
      VALUES('test','100/80-16','Levorin','meia_vida','motorcycle',4,1,33)`);
    const snapshot = (await db.pool.query("SELECT * FROM commerce.wholesale_stock WHERE environment='test'")).rows;
    const catalog = (await app.inject({ url: base, headers })).json();
    expect(catalog.rows.find((row: { tire_size: string }) => row.tire_size === '100/80-16')).toMatchObject({ creation_mode: 'stock', catalogued: false, local_quantity_available: 3 });
    const data = { ...body('Levorin', 'LEV-STOCK-APP'), measure: '100/80-16', tire_condition: 'meia_vida', creation_mode: 'stock', price_amount: null };
    expect((await post('/products', { ...data, price_amount: 100 })).statusCode).toBe(400);
    const result = await post('/products', data); expect(result.statusCode, result.body).toBe(201);
    expect((await post('/' + result.json().product_id + '/price', { price_amount: 100, reason: 'Preço inicial' })).statusCode).toBe(200);
    expect((await db.pool.query("SELECT * FROM commerce.wholesale_stock WHERE environment='test'")).rows).toEqual(snapshot);
    expect((await db.pool.query("SELECT count(*)::int n FROM commerce.products WHERE environment='prod' AND product_code='LEV-STOCK-APP'")).rows[0].n).toBe(0);
  });
});
