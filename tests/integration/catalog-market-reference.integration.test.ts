import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
type Service = typeof import('../../src/shared/catalog-market-reference.js');
let getMarketReference: Service['getMarketReference'], marketReferenceSchema: Service['marketReferenceSchema'],
  readApprovedMarketReference: Service['readApprovedMarketReference'], setMarketReference: Service['setMarketReference'];

let db: IntegrationDb;
let client: PoolClient;
const sku = randomUUID();
let today: string;
let tomorrow: string;
const sources = ['https://loja-a.example/pneu', 'https://loja-b.example/pneu'];
const draft = () => ({product_id:sku,model:'Modelo fictício',amount:130,sources,
  observed_on:today,valid_until:tomorrow,bot_enabled:true});

beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env,{FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',DATABASE_SSL:'false'});
  ({getMarketReference,marketReferenceSchema,readApprovedMarketReference,setMarketReference}
    = await import('../../src/shared/catalog-market-reference.js'));
  client = await db.pool.connect();
  const date = await client.query("SELECT d::text today,(d+1)::text tomorrow FROM (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date d) x");
  today = date.rows[0].today;
  tomorrow = date.rows[0].tomorrow;
  await client.query(`INSERT INTO commerce.products (id,environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES ($1,'test',$2,'Pneu fictício','tire','Teste','meia_vida')`, [sku,sku]);
  await client.query(`INSERT INTO commerce.tire_specs (environment,product_id,tire_size,vehicle_type,tread_pattern)
    VALUES ('test',$1,'205/55 R16','car','Modelo fictício')`,[sku]);
},180_000);
afterAll(async () => { client?.release(); if (db) await stopPostgres(db); });

describe('referência comercial de pneu novo', () => {
  it('recusa duplicações por fragmento, URLs inválidas e valores fracionários de centavo', () => {
    for (const patch of [{sources:['invalid']},{sources:[sources[0]!,sources[0]+'#foto']},
      {sources:['javascript:alert(1)']},{amount:29.999}]) {
      expect(marketReferenceSchema.safeParse({...draft(),...patch}).success).toBe(false);
    }
  });

  it('confere o modelo, não afeta preço de venda e expõe só dados aprovados do ambiente',async () => {
    await expect(setMarketReference({...draft(),model:'Versão desconhecida'},'Teste','test',db.pool))
      .rejects.toThrow('market_reference_model_mismatch');
    await expect(setMarketReference({...draft(),observed_on:tomorrow},'Teste','test',db.pool))
      .rejects.toThrow('market_reference_dates_invalid');
    const privateReference = {...draft(),bot_enabled:false};
    const original = await setMarketReference(privateReference,'Teste','test',db.pool);
    const replay = await setMarketReference(privateReference,'Teste','test',db.pool);
    expect(replay.id).toBe(original.id);
    expect(await readApprovedMarketReference(client,'test',sku)).toBeNull();
    await setMarketReference(draft(),'Teste','test',db.pool);
    expect(await readApprovedMarketReference(client,'test',sku)).toEqual(
      {amount:130, model:'Modelo fictício', observed_on:today, comparison:'media'});
    expect(await getMarketReference(sku,'prod',db.pool)).toBeNull();
    expect(await readApprovedMarketReference(client,'prod',sku)).toBeNull();
    expect((await client.query('SELECT 1 FROM commerce.matriz_product_prices WHERE product_id=$1',[sku])).rowCount).toBe(0);
    await setMarketReference({...draft(),sources:[sources[0]!]},'Teste','test',db.pool);
    expect((await readApprovedMarketReference(client,'test',sku))?.comparison).toBe('cotacao');
    await client.query("UPDATE commerce.tire_specs SET speed_rating='V' WHERE environment='test' AND product_id=$1",[sku]);
    expect(await readApprovedMarketReference(client,'test',sku)).toBeNull();
    await setMarketReference(privateReference,'Teste','test',db.pool);
    expect(await readApprovedMarketReference(client,'test',sku)).toBeNull();
    expect((await getMarketReference(sku,'test',db.pool))?.bot_enabled).toBe(false);
  });

  it('respeita transação externa e publicação expirada',async () => {
    await client.query('BEGIN');
    try {
      await setMarketReference(draft(),'Teste','test',db.pool,client);
      expect((await readApprovedMarketReference(client,'test',sku))?.amount).toBe(130);
      await client.query(`UPDATE commerce.catalog_market_references SET observed_on=$1::date-3,valid_until=$1::date-1
        WHERE bot_enabled AND environment='test' AND product_id=$2`,[today,sku]);
      expect(await readApprovedMarketReference(client,'test',sku)).toBeNull();
    } finally {await client.query('ROLLBACK');}
    expect((await getMarketReference(sku,'test',db.pool))?.bot_enabled).toBe(false);
  });

  it('permite referência interna de moto e impede sua publicação no atendimento', async () => {
    await client.query('BEGIN');
    try {
      await client.query("UPDATE commerce.tire_specs SET vehicle_type='motorcycle' WHERE environment='test' AND product_id=$1", [sku]);
      const internal = await setMarketReference({...draft(),bot_enabled:false},'Teste','test',db.pool,client);
      expect(internal.amount).toBe(130);
      await expect(setMarketReference(draft(),'Teste','test',db.pool,client)).rejects.toThrow('market_reference_model_mismatch');
      expect(await readApprovedMarketReference(client,'test',sku)).toBeNull();
    } finally { await client.query('ROLLBACK'); }
  });
});
