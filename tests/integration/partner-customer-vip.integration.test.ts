import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildRestrictedConnectionString, startPostgres, stopPostgres, type IntegrationDb,
} from './helpers/postgres.js';

describe('VIP matemático do cliente parceiro', () => {
  let db: IntegrationDb;
  let unitId: string;
  let partnerUnitId: string;
  let partnerId: string;
  let customerId: string;
  let getCustomers: typeof import('../../src/parceiro/queries.js').getPartnerCustomers;
  let partnerPool: typeof import('../../src/parceiro/db.js').partnerPool;

  beforeAll(async () => {
    Object.assign(process.env,{
      NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'emergency-token',
    });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    process.env.PARTNER_DATABASE_URL = buildRestrictedConnectionString(db.connectionString);
    vi.resetModules();
    ({ getPartnerCustomers:getCustomers } = await import('../../src/parceiro/queries.js'));
    ({ partnerPool } = await import('../../src/parceiro/db.js'));
    unitId = (await db.pool.query<{ id:string }>(
      `INSERT INTO core.units(environment,slug,name) VALUES('test','vip-math','VIP Math') RETURNING id`,
    )).rows[0]!.id;
    partnerId = (await db.pool.query<{ id:string }>(
      `INSERT INTO network.partners(environment,legal_name,trade_name,status)
       VALUES('test','VIP Math Ltda','VIP Math','active') RETURNING id`,
    )).rows[0]!.id;
    partnerUnitId = (await db.pool.query<{ id:string }>(
      `INSERT INTO network.partner_units(environment,partner_id,unit_id,slug,display_name,status)
       VALUES('test',$1,$2,'vip-math','VIP Math','active') RETURNING id`,
      [partnerId,unitId],
    )).rows[0]!.id;
    customerId = (await db.pool.query<{ id:string }>(
      `INSERT INTO commerce.partner_customers(environment,unit_id,name,phone)
       VALUES('test',$1,'Cliente VIP Matemático','+5521999997777') RETURNING id`,[unitId],
    )).rows[0]!.id;
    await db.pool.query(
      `INSERT INTO commerce.partner_orders
         (environment,unit_id,customer_id,total_amount,status,fulfillment_mode,delivery_status,delivered_at,awaiting_pickup)
       VALUES
         ('test',$1,$2,100,'confirmed','pickup','pending',NULL,false),
         ('test',$1,$2,200,'confirmed','delivery','delivered',now(),false),
         ('test',$1,$2,300,'confirmed','delivery','pending',NULL,false),
         ('test',$1,$2,400,'confirmed','pickup','pending',NULL,true),
         ('test',$1,$2,500,'cancelled','pickup','pending',NULL,false)`,
      [unitId,customerId],
    );
  },180_000);

  afterAll(async () => {
    await partnerPool?.end().catch(() => undefined);
    delete process.env.PARTNER_DATABASE_URL;
    if (db) await stopPostgres(db);
  });

  const context = () => ({
    environment:'test' as const,partnerId,partnerUnitId,unitId,slug:'vip-math',
    partnerName:'VIP Math',unitName:'VIP Math',role:'admin' as const,tokenId:crypto.randomUUID(),
  });

  it('ignora cancelada, entrega aberta e retirada ainda reservada', async () => {
    const rows = await getCustomers(context()) as Array<{
      id:string;purchases:number;total_spent:number;is_vip:boolean;
    }>;
    expect(rows.find((row) => row.id===customerId)).toMatchObject({
      purchases:2,total_spent:300,is_vip:false,
    });
  });

  it('acende a estrela exatamente na terceira compra realizada', async () => {
    await db.pool.query(
      `INSERT INTO commerce.partner_orders
         (environment,unit_id,customer_id,total_amount,status,fulfillment_mode,awaiting_pickup)
       VALUES('test',$1,$2,50,'confirmed','pickup',false)`,[unitId,customerId],
    );
    const rows = await getCustomers(context()) as Array<{
      id:string;purchases:number;total_spent:number;is_vip:boolean;
    }>;
    expect(rows.find((row) => row.id===customerId)).toMatchObject({
      purchases:3,total_spent:350,is_vip:true,
    });
  });
});
