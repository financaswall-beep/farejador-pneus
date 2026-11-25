import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCatalogProductStats } from '../../src/admin/painel/queries-catalogo-stats.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb;
let matrix: string, otherUnit: string, contact: string, tire: string, peer: string, used: string;
let car: string, tube: string, service: string, missingType: string;
const midnight = "((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - $1::int)::timestamp AT TIME ZONE 'America/Sao_Paulo'";

async function product(name: string, kind: string, brand: string | null, size?: string, condition?: string, vehicle?: string) {
  const { rows: [p] } = await db.pool.query(`INSERT INTO commerce.products
    (environment,product_code,product_name,product_type,brand,tire_condition) VALUES ('test',$1,$2,$3,$4,$5) RETURNING id`,
  [randomUUID(), name, kind, brand, condition ?? null]);
  if (size) await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type)
    VALUES ('test',$1,$2,$3)`, [p.id, size, vehicle ?? null]);
  return p.id as string;
}

type SaleLine = [product: string, quantity: number, price?: number, explicitDiscount?: number, reference?: number];
async function sale(daysAgo: number, items: SaleLine[], status = 'confirmed', unit = matrix) {
  const { rows: [order] } = await db.pool.query(`INSERT INTO commerce.orders
    (environment,contact_id,unit_id,total_amount,status,fulfillment_mode,idempotency_key,created_at)
    VALUES ('test',$2,$3,100,$4,'pickup',$5,${midnight}) RETURNING id`,
  [daysAgo, contact, unit, status, randomUUID()]);
  for (const [id, qty, price = 100, discount = 0, reference] of items) {
    // A null reference exercises the default trigger, which copies unit_price.
    await db.pool.query(`INSERT INTO commerce.order_items
      (environment,order_id,product_id,quantity,unit_price,discount_amount,reference_unit_price,created_at)
      VALUES ('test',$2,$3,$4,$5,$6,$7,${midnight})`, [daysAgo, order.id, id, qty, price, discount, reference ?? null]);
  }
  return order.id;
}

beforeAll(async () => {
  db = await startPostgres();
  matrix = (await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz')
    ON CONFLICT(environment,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id;
  otherUnit = (await db.pool.query("INSERT INTO core.units(environment,slug,name) VALUES('test','outra-estatistica','Outra') RETURNING id")).rows[0].id;
  contact = (await db.pool.query("INSERT INTO core.contacts(environment,chatwoot_contact_id) VALUES('test',991393) RETURNING id")).rows[0].id;
  tire = await product('Pneu escolhido','tire','Pirelli','90/90-18','novo','motorcycle');
  peer = await product('Pneu comparável','tire','Rinaldi','90/90 - 18','novo','motorcycle');
  used = await product('Seminovo','tire','Levorin','90/90-18','meia_vida','motorcycle');
  car = await product('Automóvel','tire','Michelin','90/90-18','novo','car');
  tube = await product('Câmara de ar','tube',null);
  service = await product('Montagem','service',null);
  missingType = await product('Pneu sem categoria','tire','Technic','100/90-18','novo');
  for (const [start,end,amount] of [[21,9,100],[9,null,110]]) {
    await db.pool.query(`INSERT INTO commerce.matriz_product_prices
      (environment,product_id,valid_from,valid_until,price_amount) VALUES('test',$2,${midnight},
         ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - $3::int)::timestamp AT TIME ZONE 'America/Sao_Paulo',$4)`,
    [start,tire,end,amount]);
  }
  await sale(56,[[tire,100]]);
  await sale(55,[[tire,1],[peer,3]]);
  await sale(27,[[tire,2],[peer,2],[service,1],[service,2],[tube,2]]);
  await sale(20,[[tire,2,85],[peer,6],[tube,1]]);
  await sale(13,[[tire,1,100],[service,1,20,5]]);
  await sale(0,[[tire,2,110],[tire,1,110,1]]);
  await sale(7,[[used,100],[car,99],[missingType,4]]);
  await sale(1,[[tire,99],[tube,5]],'cancelled');
  await sale(2,[[tire,99]],'open');
  await sale(3,[[tire,99]],'confirmed',otherUnit);
  await sale(-1,[[tire,99]]);
  const mirrored = await sale(2,[[tire,99],[tube,55]]);
  const partner = (await db.pool.query(`INSERT INTO commerce.partner_orders
    (environment,unit_id,total_amount,status,fulfillment_mode,awaiting_pickup)
    VALUES ('test',$1,100,'confirmed','pickup',true) RETURNING id`,[otherUnit])).rows[0].id;
  await db.pool.query('UPDATE commerce.orders SET partner_order_id=$2 WHERE id=$1',[mirrored,partner]);
}, 180000);

afterAll(async () => { if (db) await stopPostgres(db); });

describe('estatísticas do produto no varejo da Matriz', () => {
  it('compara períodos locais por unidades com a mesma medida, condição e tipo', async () => {
    const stats = await getCatalogProductStats(db.pool, 'test', tire);
    expect(stats?.weeks).toEqual([
      { units: 2, total: 4, percent: 50 }, { units: 2, total: 8, percent: 25 },
      { units: 1, total: 1, percent: 100 }, { units: 3, total: 3, percent: 100 },
    ]);
    expect(stats?.share).toEqual({units:8, total:16, percent:50, delta_pp:25});
  });
  it('conta pedidos distintos e inclui acessórios e serviços efetivamente registrados', async () => {
    const stats = await getCatalogProductStats(db.pool, 'test', tire);
    expect(stats?.basket.orders).toBe(4);
    expect(stats?.basket.items).toHaveLength(3);
    expect(stats?.basket.items).toEqual(expect.arrayContaining([
      { label:'Câmara de ar', orders:2 }, { label:'Montagem', orders:2 }, { label:'Pneu comparável', orders:2 },
    ]));
  });
  it('detecta preço negociado mesmo quando o trigger copia a referência e agrega desconto apenas deste item', async () => {
    const stats = await getCatalogProductStats(db.pool, 'test', tire);
    expect(stats?.discount).toEqual({eligible_orders:3, orders_without_discount:1, percent:33.3, unknown_orders:1});
  });
  it('preserva os pedidos do produto sem inventar uma comparação sem categoria conhecida', async () => {
    const stats = await getCatalogProductStats(db.pool,'test',missingType);
    expect(stats?.share).toEqual({ units:0, total:0, percent:null, delta_pp:null });
    expect(stats?.basket.orders).toBe(1);
    expect(stats?.discount).toEqual({eligible_orders:0,orders_without_discount:0,percent:null,unknown_orders:1});
  });
  it('considera referência negociada distinta e desconto explícito, mantendo indeterminado um pedido parcialmente conhecido', async () => {
    const target = await product('Com referência própria','tire','Kenda','100/80-17','novo','motorcycle');
    await sale(7,[[target,1,80,0,100],[target,1,100]]);
    await sale(6,[[target,1,110,0,100],[target,1,100]]);
    await sale(5,[[target,1,110,0,100]]);
    await sale(4,[[target,1,80,1]]);
    const stats = await getCatalogProductStats(db.pool,'test',target);
    expect(stats?.discount).toEqual({eligible_orders:3,orders_without_discount:1,percent:33.3,unknown_orders:1});
  });
  it('isola ambiente, produto removido e tipo, retornando zero somente para contagens sem registros', async () => {
    expect(await getCatalogProductStats(db.pool,'prod',tire)).toBeNull();
    expect(await getCatalogProductStats(db.pool,'test',service)).toBeNull();
    const empty = await product('Sem vendas','tire','Kenda','80/100-18','novo','motorcycle');
    const result = await getCatalogProductStats(db.pool,'test',empty);
    expect(result?.weeks).toEqual(Array.from({length:4},()=>({units:0,total:0,percent:null})));
    expect(result?.basket).toEqual({orders:0,items:[]});
    await db.pool.query('UPDATE commerce.products SET deleted_at=now() WHERE environment=$1 AND id=$2',['test',empty]);
    expect(await getCatalogProductStats(db.pool,'test',empty)).toBeNull();
  });
});
