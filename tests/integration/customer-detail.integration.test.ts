import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('ficha lateral — dados reais no PostgreSQL temporário',() => {
  let db:IntegrationDb;
  let detail:typeof import('../../src/admin/painel/customer-detail.js').getCustomerDetail;
  let contactId:string, otherContactId:string, walkinId:string, partnerCustomerId:string, wholesaleId:string;
  let unitId:string, productId:string;
  const insertId = async (sql:string,args:unknown[]=[]):Promise<string> =>
    (await db.pool.query<{id:string}>(sql,args)).rows[0]!.id;

  beforeAll(async () => {
    Object.assign(process.env,{ NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin' });
    db = await startPostgres(); process.env.DATABASE_URL=db.connectionString; vi.resetModules();
    ({ getCustomerDetail:detail } = await import('../../src/admin/painel/customer-detail.js'));
    unitId = await insertId(`INSERT INTO core.units(environment,slug,name) VALUES('test','customer-drawer','Loja da ficha') RETURNING id`);
    const partnerId = await insertId(`INSERT INTO network.partners(environment,legal_name,trade_name,status)
      VALUES('test','Ficha Ltda','Parceiro da ficha','active') RETURNING id`);
    await db.pool.query(`INSERT INTO network.partner_units(environment,partner_id,unit_id,slug,display_name,status)
      VALUES('test',$1,$2,'customer-drawer','Loja da ficha','active')`,[partnerId,unitId]);
    contactId = await insertId(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
      VALUES('test',980701,'Ana Silva','+5521999991111') RETURNING id`);
    otherContactId = await insertId(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
      VALUES('test',980702,'Ana Silva','+5521999992222') RETURNING id`);
    await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
      contact_id,current_status,channel_type,started_at) VALUES('test',980701,2,$1,'open','Channel::Whatsapp',now())`,[contactId]);
    walkinId = await insertId(`INSERT INTO commerce.customers(environment,name,phone_e164)
      VALUES('test','Bruno Souza','+5521999993333') RETURNING id`);
    partnerCustomerId = await insertId(`INSERT INTO commerce.partner_customers(environment,unit_id,name,phone,address_street,
      address_number,address_neighborhood,address_city) VALUES('test',$1,'Carla Lima','+5521999994444','Rua Exemplo','12','Centro','Maricá') RETURNING id`,[unitId]);
    wholesaleId = await insertId(`INSERT INTO commerce.wholesale_customers(environment,name,phone)
      VALUES('test','Borracharia da ficha','+5521999995555') RETURNING id`);
    productId = await insertId(`INSERT INTO commerce.products(environment,product_code,product_name,product_type)
      VALUES('test','DRAWER-TEST','Pneu Vipal 110/90-17','tire') RETURNING id`);
    const orderId = await insertId(`INSERT INTO commerce.orders(environment,contact_id,unit_id,total_amount,status,fulfillment_mode)
      VALUES('test',$1,$2,100,'confirmed','pickup') RETURNING id`,[contactId,unitId]);
    await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price)
      VALUES('test',$1,$2,2,50)`,[orderId,productId]);
    await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,total_amount,status,fulfillment_mode,delivery_status,delivery_address,delivered_at,created_at)
      VALUES('test',$1,200,'confirmed','delivery','delivered','Rua da entrega, 20',now(),now()-interval '1 day'),
      ('test',$1,300,'confirmed','delivery','pending','Rua pendente, 30',NULL,now()),
      ('test',$1,500,'cancelled','delivery','pending','Endereço cancelado',NULL,now()+interval '1 day'),
      ('test',$2,900,'confirmed','pickup','pending',NULL,NULL,now())`,[contactId,otherContactId]);
    await db.pool.query(`INSERT INTO commerce.orders(environment,customer_id,source,total_amount,status,fulfillment_mode,delivery_address,delivery_status,delivered_at)
      VALUES('test',$1,'walkin_balcao',80,'confirmed','delivery','Rua do balcão, 8','delivered',now())`,[walkinId]);
    await db.pool.query(`INSERT INTO commerce.partner_orders(environment,unit_id,customer_id,total_amount,status,fulfillment_mode,delivery_status,awaiting_pickup)
      VALUES('test',$1,$2,50,'confirmed','pickup','pending',false),
      ('test',$1,$2,100,'confirmed','pickup','pending',false),
      ('test',$1,$2,150,'confirmed','pickup','pending',false),
      ('test',$1,$2,300,'confirmed','pickup','pending',true),
      ('test',$1,$2,400,'confirmed','delivery','pending',false),
      ('test',$1,$2,500,'cancelled','pickup','pending',false)`,[unitId,partnerCustomerId]);
    const partnerOrderId = (await db.pool.query<{id:string}>(`SELECT id FROM commerce.partner_orders
      WHERE environment='test' AND customer_id=$1 AND total_amount=50`,[partnerCustomerId])).rows[0]!.id;
    await db.pool.query(`INSERT INTO commerce.partner_order_items(environment,order_id,item_name,quantity,unit_price)
      VALUES('test',$1,'Pneu parceiro',1,50)`,[partnerOrderId]);
    const wholesaleOrderId = await insertId(`INSERT INTO commerce.wholesale_orders(environment,buyer_id,total_amount)
      VALUES('test',$1,240) RETURNING id`,[wholesaleId]);
    await db.pool.query(`INSERT INTO commerce.wholesale_order_items(environment,order_id,measure,brand,quantity,unit_price)
      VALUES('test',$1,'90/90-18','Vipal',2,120)`,[wholesaleOrderId]);
  },180_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  it('consulta o Chatwoot por contato exato, exclui pendentes/cancelados dos totais e preserva itens',async () => {
    const data = await detail('test','chatwoot',contactId,{},db.pool);
    expect(data?.customer).toMatchObject({ name:'Ana Silva',phone:'+5521999991111',origin:'Channel::Whatsapp',
      address:'Rua pendente, 30',address_source:'order',chatwoot_account_id:2,chatwoot_conversation_id:980701 });
    expect(data?.summary).toMatchObject({ purchases:2,total_spent:300,avg_ticket:150 });
    expect(data?.history_total).toBe(4);
    expect(data?.orders.some(o => o.total_amount===900)).toBe(false);
    expect(data?.orders.flatMap(o => o.items)).toContainEqual({ label:'Pneu Vipal 110/90-17',quantity:2,unit_price:50 });
  });
  it('lê os dados de balcão e o endereço do pedido sem mesclar pelo nome',async () => {
    const data = await detail('test','balcao',walkinId,{},db.pool);
    expect(data?.customer).toMatchObject({ name:'Bruno Souza',address:'Rua do balcão, 8',origin:'Balcão' });
    expect(data?.summary).toMatchObject({ purchases:1,total_spent:80 });
  });
  it('parceiro: usa cadastro da unidade, VIP matemático e paginação sem inflar os indicadores',async () => {
    const data = await detail('test','parceiro',partnerCustomerId,{ limit:2 },db.pool);
    expect(data?.customer).toMatchObject({ name:'Carla Lima',unit_name:'Loja da ficha',is_vip:true,
      address:'Rua Exemplo, 12, Centro, Maricá',address_source:'customer' });
    expect(data?.summary).toMatchObject({ purchases:3,total_spent:300,avg_ticket:100 });
    expect(data?.orders).toHaveLength(2); expect(data?.next_offset).toBe(2);
    const second = await detail('test','parceiro',partnerCustomerId,{ limit:2,offset:2 },db.pool);
    expect(second?.orders.some(o => data?.orders.some(first => first.id===o.id))).toBe(false);
    expect(second?.summary).toEqual(data?.summary);
    const last = await detail('test','parceiro',partnerCustomerId,{ limit:2,offset:4 },db.pool);
    expect(last?.next_offset).toBeNull();
  });
  it('atacado: mantém itens e valores da venda na ficha correta',async () => {
    const data = await detail('test','atacado',wholesaleId,{},db.pool);
    expect(data?.summary).toMatchObject({ purchases:1,total_spent:240,avg_ticket:240 });
    expect(data?.orders[0]?.items).toEqual([{ label:'Vipal 90/90-18',quantity:2,unit_price:120 }]);
    expect(data?.customer.address).toBeNull();
  });
  it('não cruza ambiente, fonte ou clientes excluídos',async () => {
    expect(await detail('prod','chatwoot',contactId,{},db.pool)).toBeNull();
    expect(await detail('test','balcao',contactId,{},db.pool)).toBeNull();
    await db.pool.query(`UPDATE core.contacts SET deleted_at=now() WHERE id=$1`,[otherContactId]);
    expect(await detail('test','chatwoot',otherContactId,{},db.pool)).toBeNull();
  });
});
