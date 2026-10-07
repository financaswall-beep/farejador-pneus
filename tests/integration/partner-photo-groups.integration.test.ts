import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture, type PartnerFixture } from './helpers/partner-fixtures.js';

const route = vi.hoisted(() => ({ unitId: '' }));
vi.mock('../../src/atendente-v2/configured-routing.js', () => ({ decideConfiguredStore: async () => ({ kind: 'partner', routing: { unitId: route.unitId } }) }));
vi.mock('../../src/atendente-v2/customer-location.js', () => ({ resolveCustomerLocation: async () => ({ lat: -22.9, lng: -43.2 }) }));
vi.mock('../../src/atendente-v2/delivery-quote-routing.js', () => ({ fillCityFromPin: async (_c: unknown, _e: unknown, _id: unknown, current: unknown) => current }));
let db: IntegrationDb, client: PoolClient, own: PartnerFixture, other: PartnerFixture, products: string[], prodUnit: string, prodProduct: string;
let seq = 921000000, pools: Pool[] = [];
let execute: typeof import('../../src/atendente-v2/tools.js')['executeTool'];
let create: typeof import('../../src/atendente-v2/photo-requests.js')['createPhotoRequest'];
let confirmed: typeof import('../../src/atendente-v2/stock-confirmation-photo.js')['createConfirmedStockPhotos'];
beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    PARTNER_DATABASE_URL: db.connectionString, CHATWOOT_HMAC_SECRET: 'test', ADMIN_AUTH_TOKEN: 'test',
    PHOTO_REQUESTS: 'true', ROUTING_GEO: 'true', PARTNER_STOCK_CONFIRMATION: 'true' });
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Rede externa proibida'); }));
  ({ executeTool: execute } = await import('../../src/atendente-v2/tools.js'));
  ({ createPhotoRequest: create } = await import('../../src/atendente-v2/photo-requests.js'));
  ({ createConfirmedStockPhotos: confirmed } = await import('../../src/atendente-v2/stock-confirmation-photo.js'));
  pools = [(await import('../../src/persistence/db.js')).pool, (await import('../../src/parceiro/db.js')).partnerPool];
  own = await createPartnerFixture(db.pool); other = await createPartnerFixture(db.pool); route.unitId = own.unitId;
  prodUnit = (await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('prod','photo-prod','Prod') RETURNING id`)).rows[0].id;
  products = [];
  for (const measure of ['90/90-18', '80/100-14']) products.push((await db.pool.query(`INSERT INTO commerce.products
    (environment,product_code,product_name,product_type,brand,tire_condition) VALUES('test',$1,$2,'tire','Pirelli','meia_vida') RETURNING id`, [measure, 'Pneu ' + measure])).rows[0].id);
  prodProduct = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type)
    VALUES('prod','PHOTO-PROD','Pneu prod','tire') RETURNING id`)).rows[0].id;
  client = await db.pool.connect();
}, 180000);
afterAll(async () => { client?.release(); vi.unstubAllGlobals(); for (const pool of pools) await pool.end(); if (db) await stopPostgres(db); });
beforeEach(async () => { await client.query('BEGIN'); });
afterEach(async () => { await client.query('ROLLBACK'); });
async function conversation() {
  return (await client.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at)
    VALUES('test',$1,1,'open',now()) RETURNING id,chatwoot_conversation_id`, [++seq])).rows[0];
}
async function restricted(sql: string, unit: PartnerFixture | null = own) {
  await client.query('SAVEPOINT read_partner');
  try {
    await client.query('SET LOCAL ROLE farejador_partner_app');
    await client.query("SELECT set_config('app.partner_unit_id',$1,true)", [unit?.partnerUnitId ?? '']);
    return (await client.query(sql)).rows;
  } finally { await client.query('ROLLBACK TO SAVEPOINT read_partner'); await client.query('RELEASE SAVEPOINT read_partner'); }
}
const queueSql = 'SELECT id,tire_size,tire_condition,photo_group_id,customer_name FROM commerce.partner_photo_queue';
describe('Fotos correlacionadas no banco e no bot', () => {
  it('a ferramenta cria dois cards no mesmo grupo e repetir não duplica', async () => {
    const cv = await conversation(), args = { product_ids: products, municipio: 'Rio de Janeiro' };
    const result = JSON.parse(await execute(client, 'test', cv.id, 'pedir_foto', args));
    expect(result).toMatchObject({ status: 'fotos_solicitadas', total_solicitado: 2 });
    const rows = await restricted(queueSql); expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.photo_group_id)).size).toBe(1);
    expect(rows.every(row => row.tire_condition === 'meia_vida')).toBe(true);
    expect(JSON.parse(await execute(client, 'test', cv.id, 'pedir_foto', args)).solicitacoes.every((row: any) => row.ja_pedida)).toBe(true);
    expect(await restricted(queueSql)).toHaveLength(2);
  });
  it('não mistura unidade, cliente homônimo ou ambiente e mantém dados Chatwoot ocultos', async () => {
    const cv = await conversation();
    for (const [environment, unitId, id, measure] of [['test', own.unitId, cv.chatwoot_conversation_id, '90/90-18'],
      ['test', other.unitId, cv.chatwoot_conversation_id, '80/100-14'], ['test', own.unitId, ++seq, '80/100-14'],
      ['prod', prodUnit, cv.chatwoot_conversation_id, '90/90-18']] as const) {
      await create(client, environment, { unitId, chatwootConversationId: Number(id), tireSize: measure, brand: null, customerLabel: 'Carlos' });
    }
    const rows = await restricted(queueSql); expect(rows).toHaveLength(2); expect(new Set(rows.map(row => row.photo_group_id)).size).toBe(2);
    expect(await restricted(queueSql, other)).toHaveLength(1); expect(await restricted(queueSql, null)).toEqual([]);
    await expect(restricted('SELECT conversation_id FROM commerce.photo_requests')).rejects.toThrow(/permission denied/);
    expect(await restricted('SELECT photo_group_id FROM commerce.photo_requests WHERE environment=\'prod\'')).toEqual([]);
  });
  it('pedido para foto dos dois espera TENHO e só então materializa ambas na unidade confirmada', async () => {
    const cv = await conversation();
    const routing = { items: products.map(product_id => ({ product_id, quantity: 1 })), unitId: own.unitId };
    const request = (await client.query(`INSERT INTO commerce.partner_stock_requests
      (environment,conversation_id,unit_id,basket_key,items,routing,sealed,status,expires_at)
      VALUES('test',$1,$2,'photo-pair',$4::jsonb,$3::jsonb,true,'pending',now()+interval '10 minutes') RETURNING *`,
      [cv.id, own.unitId, JSON.stringify(routing), JSON.stringify(products.map((product_id, i) => ({ product_id, tire_size: i ? '80/100-14' : '90/90-18', quantity: 1 })))])).rows[0];
    const result = JSON.parse(await execute(client, 'test', cv.id, 'pedir_foto', { product_ids: products }));
    expect(result.total_solicitado).toBe(2); expect(result.solicitacoes.every((row: any) => row.status === 'aguardando_parceiro')).toBe(true);
    expect(await restricted(queueSql)).toEqual([]);
    const updated = (await client.query(`UPDATE commerce.partner_stock_requests SET status='confirmed',answered_at=now(),valid_until=now()+interval '15 minutes' WHERE id=$1 RETURNING *`, [request.id])).rows[0];
    expect(await confirmed(client, updated)).toBe(true);
    const rows = await restricted(queueSql); expect(rows).toHaveLength(2); expect(rows[0].photo_group_id).toBe(rows[1].photo_group_id);
  });
  it('UUID de produto de outro ambiente não cria nenhum card', async () => {
    const cv = await conversation();
    const result = JSON.parse(await execute(client, 'test', cv.id, 'pedir_foto', { product_ids: [products[0], prodProduct] }));
    expect(result.status).toBe('precisa_produto'); expect(await restricted(queueSql)).toEqual([]);
  });
  it('backfill agrupa ativos antigos e preserva RLS em reaplicação', async () => {
    const cv = await conversation();
    await client.query(`INSERT INTO commerce.photo_requests(environment,unit_id,conversation_id,tire_size)
      VALUES('test',$1,$2,'90/90-18'),('test',$1,$2,'80/100-14')`, [own.unitId, cv.chatwoot_conversation_id]);
    await client.query(readFileSync('db/migrations/0269_partner_photo_groups.sql', 'utf8'));
    const rows = await restricted(queueSql); expect(rows).toHaveLength(2); expect(rows[0].photo_group_id).toBe(rows[1].photo_group_id);
    expect(await restricted(queueSql, other)).toEqual([]);
  });
});
