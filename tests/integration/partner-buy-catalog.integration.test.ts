import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPartnerFixture, type PartnerFixture } from './helpers/partner-fixtures.js';
import { startPostgres, stopPostgres, applyMigrationFile, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb, client: PoolClient, partner: PartnerFixture;
const views = ['current_prices','matriz_current_prices','product_full'];
beforeAll(async () => {
  db = await startPostgres({throughMigration:'0267_catalog_wholesale_prices.sql'});
  const before = (await db.pool.query(`SELECT viewname,definition FROM pg_views
    WHERE schemaname='commerce' AND viewname=ANY($1::text[]) ORDER BY viewname`, [views])).rows;
  await applyMigrationFile(db.pool, '0268_partner_wholesale_catalog.sql');
  expect((await db.pool.query(`SELECT viewname,definition FROM pg_views
    WHERE schemaname='commerce' AND viewname=ANY($1::text[]) ORDER BY viewname`, [views])).rows).toEqual(before);
  partner = await createPartnerFixture(db.pool);
  client = await db.pool.connect();
}, 180_000);
afterAll(async () => { client?.release(); if (db) await stopPostgres(db); });
beforeEach(async () => { await client.query('BEGIN'); });
afterEach(async () => { await client.query('ROLLBACK'); });

async function product(options: {measure?:string;brand?:string;condition?:string;environment?:string;
  vehicle?:string|null;price?:number|null;quantity?:number;reserved?:number;stockMeasure?:string;stockBrand?:string} = {}) {
  const id=randomUUID(), environment=options.environment ?? 'test', measure=options.measure ?? '90/90-18';
  const brand=options.brand ?? 'Pirelli', condition=options.condition ?? 'meia_vida', vehicle=options.vehicle === undefined ? 'motorcycle' : options.vehicle;
  await client.query(`INSERT INTO commerce.products (id,environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES ($1,$2,$1::uuid::text,'Pneu integração','tire',$3,$4)`, [id,environment,brand,condition]);
  await client.query(`INSERT INTO commerce.tire_specs (environment,product_id,tire_size,vehicle_type)
    VALUES ($1,$2,$3,$4)`, [environment,id,measure,vehicle]);
  if (options.price !== null) await client.query(`INSERT INTO commerce.wholesale_product_prices
    (environment,product_id,price_amount,valid_from) VALUES ($1,$2,$3,now()-interval '1 second')`, [environment,id,options.price ?? 65]);
  await client.query(`INSERT INTO commerce.wholesale_stock
    (environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,vehicle_type,unit_cost)
    VALUES ($1,$2,$3,$4,$5,$6,$7,40)`, [environment,options.stockMeasure ?? measure,options.stockBrand ?? brand,condition,options.quantity ?? 12,options.reserved ?? 2,vehicle]);
  return id;
}
async function restricted(sql='SELECT * FROM commerce.partner_wholesale_catalog()', unit: string|null=partner.partnerUnitId) {
  await client.query('SAVEPOINT restricted_read');
  try {
    await client.query('SET LOCAL ROLE farejador_partner_app');
    await client.query("SELECT set_config('app.partner_unit_id',$1,true)", [unit ?? '']);
    return (await client.query(sql)).rows;
  } finally { await client.query('ROLLBACK TO SAVEPOINT restricted_read'); await client.query('RELEASE SAVEPOINT restricted_read'); }
}

describe('Comprar — oferta publicada para parceiro com role restrita', () => {
  it('retorna só variante, saldo livre e preço em centavos, sem custo/varejo ou dados pessoais', async () => {
    const id = await product();
    expect(await restricted()).toEqual([{offer_key:id,measure:'90/90-18',brand:'Pirelli',tire_condition:'meia_vida',
      vehicle_type:'motorcycle',quantity_available:10,price_cents:'6500'}]);
    for (const sql of ['SELECT unit_cost FROM commerce.wholesale_stock',
      'SELECT * FROM commerce.wholesale_product_prices','SELECT * FROM commerce.wholesale_current_prices']) {
      await expect(restricted(sql)).rejects.toThrow(/permission denied/);
    }
  });
  it('não mistura ambiente nem atende contexto ausente, desconhecido ou unidade/parceiro suspenso', async () => {
    await product(); await product({environment:'prod',price:55});
    expect(await restricted()).toHaveLength(1);
    expect(await restricted(undefined,null)).toEqual([]);
    expect(await restricted(undefined,randomUUID())).toEqual([]);
    await client.query("UPDATE network.partner_units SET status='suspended' WHERE id=$1", [partner.partnerUnitId]);
    expect(await restricted()).toEqual([]);
    await client.query("UPDATE network.partner_units SET status='active' WHERE id=$1", [partner.partnerUnitId]);
    await client.query("UPDATE network.partners SET status='suspended' WHERE id=$1", [partner.partnerId]);
    expect(await restricted()).toEqual([]);
  });
  it('oculta oferta sem preço vigente, produto arquivado ou saldo inteiramente reservado', async () => {
    await product({price:null}); await product({measure:'110/90-17',quantity:2,reserved:2});
    const future = await product({measure:'2.75-18',price:null});
    await client.query(`INSERT INTO commerce.wholesale_product_prices (environment,product_id,price_amount,valid_from)
      VALUES ('test',$1,50,now()+interval '1 day')`, [future]);
    const archived = await product({measure:'80/100-14'});
    await client.query('UPDATE commerce.products SET deleted_at=now() WHERE id=$1', [archived]);
    expect(await restricted()).toEqual([]);
    await client.query("UPDATE commerce.wholesale_product_prices SET valid_from=now()-interval '1 day',valid_until=now()-interval '1 hour' WHERE product_id=$1", [future]);
    expect(await restricted()).toEqual([]);
  });
  it('separa marca, condição e carro/moto sem inferir categoria pelo formato da medida', async () => {
    await product(); await product({brand:'Michelin',price:70,quantity:4,reserved:1});
    await product({condition:'novo',price:120,quantity:3,reserved:0});
    await product({measure:'195/65-15',vehicle:'car',price:110,quantity:7,reserved:0});
    await product({measure:'80/100-14',vehicle:null});
    const rows = await restricted(); expect(rows).toHaveLength(4);
    expect(rows.find(row => row.brand==='Michelin')).toMatchObject({quantity_available:3,price_cents:'7000'});
    expect(rows.find(row => row.tire_condition==='novo')).toMatchObject({quantity_available:3,price_cents:'12000'});
    expect(rows.find(row => row.vehicle_type==='car')).toMatchObject({measure:'195/65-15'});
  });
  it('normaliza medida/marca, mas bloqueia estoque duplicado', async () => {
    await product({stockMeasure:'909018',stockBrand:'PIRELLI'});
    expect(await restricted()).toHaveLength(1);
    await client.query(`INSERT INTO commerce.wholesale_stock (environment,measure,brand,tire_condition,quantity_on_hand)
      VALUES ('test','90/90-18','Pirelli','meia_vida',3)`);
    expect(await restricted()).toEqual([]);
  });
  it('mantém EXECUTE fora do acesso público e não cria permissões de escrita', async () => {
    const row = (await client.query(`SELECT proacl::text acl FROM pg_proc
      WHERE oid='commerce.partner_wholesale_catalog()'::regprocedure`)).rows[0];
    expect(row.acl).not.toMatch(/(?:\{|,)=X\//);
    expect((await client.query(`SELECT has_table_privilege('farejador_partner_app',
      'commerce.wholesale_product_prices','INSERT,UPDATE,DELETE') access`)).rows[0].access).toBe(false);
  });
});
