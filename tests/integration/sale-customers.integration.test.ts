import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import type { RegisterWalkinOrderInput } from '../../src/admin/painel/queries-pedidos.js';
import { operationFingerprint } from '../../src/admin/painel/stage5-integrity.js';

describe('cliente explícito na venda de balcão', () => {
  let db: IntegrationDb, product: string, customer: string, contact: string, prodCustomer: string;
  let service: typeof import('../../src/admin/painel/sale-customers.js');
  let sell: typeof import('../../src/admin/painel/walkin-order.js').registerWalkinOrder;
  beforeAll(async () => {
    Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-token',MATRIZ_CENTRAL_LEDGER:'true'});
    db=await startPostgres();process.env.DATABASE_URL=db.connectionString;vi.resetModules();
    service=await import('../../src/admin/painel/sale-customers.js');
    ({registerWalkinOrder:sell}=await import('../../src/admin/painel/walkin-order.js'));
    const id=async(sql:string,args:unknown[]=[]) => (await db.pool.query(sql,args)).rows[0].id;
    await db.pool.query(`INSERT INTO core.units(environment,slug,name,is_active) VALUES('test','main','Matriz',true)
      ON CONFLICT(environment,slug) DO UPDATE SET is_active=true`);
    customer=await id(`INSERT INTO commerce.customers(environment,name,phone_e164,source)
      VALUES('test','Maria da Silva','+5521999998888','walkin') RETURNING id`);
    prodCustomer=await id(`INSERT INTO commerce.customers(environment,name,phone_e164,source)
      VALUES('prod','Maria produção','+5521999998888','walkin') RETURNING id`);
    contact=await id(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
      VALUES('test',889,'Maria WhatsApp','+5521999997777') RETURNING id`);
    product=await id(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand)
      VALUES('test','SALE-CUSTOMER','Pneu cliente','tire','Sem marca') RETURNING id`);
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'90/90-18')`,[product]);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,quantity_on_hand,unit_cost)
      VALUES('test','90/90-18',100,40)`);
    await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount,currency,valid_from)
      VALUES('test',$1,120,'BRL','2026-01-01')`,[product]);
  },180000);
  afterAll(async()=>{if(db)await stopPostgres(db);vi.resetModules();});
  const input=(extra:Partial<RegisterWalkinOrderInput>={}):RegisterWalkinOrderInput=>({environment:'test',
    items:[{product_id:product,quantity:1,unit_price:120}],payment_method:'Pix',fulfillment_mode:'pickup',
    actor_label:'Teste',idempotency_key:randomUUID(),source_tag:'walkin_balcao',...extra});
  const order=async(id:string)=>(await db.pool.query('SELECT customer_id,contact_id,delivery_address FROM commerce.orders WHERE id=$1',[id])).rows[0];
  it('busca nome e telefone formatado, limita e isola ambiente',async()=>{
    const byName=await service.searchSaleCustomers('test','Maria',db.pool);
    expect(byName.rows.map(r=>r.id)).toEqual(expect.arrayContaining([customer,contact]));
    expect(byName.rows.map(r=>r.id)).not.toContain(prodCustomer);
    expect((await service.searchSaleCustomers('test','(21) 99999-8888',db.pool)).rows.map(r=>r.id)).toContain(customer);
    expect((await service.searchSaleCustomers('test','M',db.pool)).rows).toEqual([]);
    expect((await service.searchSaleCustomers('test',"%' OR 1=1 --",db.pool)).rows).toEqual([]);
  });
  it('vincula pelo UUID sem modificar nome e retry não duplica venda',async()=>{
    const data=input({customer_mode:'existing',customer_ref:{source:'balcao',id:customer},customer_name:'Não sobrescrever'});
    const result=await sell(data,db.pool);expect(await sell(data,db.pool)).toEqual(result);
    expect(await order(result.order_id)).toMatchObject({customer_id:customer,contact_id:null});
    expect((await db.pool.query('SELECT name FROM commerce.customers WHERE id=$1',[customer])).rows[0].name).toBe('Maria da Silva');
    await expect(sell({...data,customer_ref:{source:'chatwoot',id:contact}},db.pool)).rejects.toThrow('walkin_idempotency_conflict');
  });
  it('vincula cliente do WhatsApp por contact_id sem criar cliente duplicado',async()=>{
    const count=async()=>Number((await db.pool.query('SELECT count(*) FROM commerce.customers')).rows[0].count);
    const before=await count();
    const result=await sell(input({customer_mode:'existing',customer_ref:{source:'chatwoot',id:contact}}),db.pool);
    expect(await order(result.order_id)).toMatchObject({customer_id:null,contact_id:contact});expect(await count()).toBe(before);
  });
  it('rejeita cadastro de outro ambiente, apagado e seleção ausente sem baixar estoque',async()=>{
    const before=(await db.pool.query("SELECT quantity_on_hand FROM commerce.wholesale_stock WHERE environment='test' AND measure='90/90-18'")).rows[0];
    for(const id of [prodCustomer,randomUUID()])await expect(sell(input({customer_mode:'existing',customer_ref:{source:'balcao',id}}),db.pool)).rejects.toThrow('sale_customer_not_found');
    await expect(sell(input({customer_mode:'existing'}),db.pool)).rejects.toThrow('sale_customer_required');
    const deleted=(await db.pool.query(`INSERT INTO commerce.customers(environment,name,source,deleted_at) VALUES('test','Apagado','walkin',now()) RETURNING id`)).rows[0].id;
    await expect(sell(input({customer_ref:{source:'balcao',id:deleted}}),db.pool)).rejects.toThrow('sale_customer_not_found');
    expect((await db.pool.query("SELECT quantity_on_hand FROM commerce.wholesale_stock WHERE environment='test' AND measure='90/90-18'")).rows[0]).toEqual(before);
  });
  it('não cria duplicata por telefone existente no balcão ou Chatwoot',async()=>{
    for(const phone of ['(21) 99999-8888','+5521999997777'])await expect(sell(input({customer_mode:'new',customer_name:'Outro nome',customer_phone:phone}),db.pool)).rejects.toThrow('sale_customer_phone_exists');
    await expect(sell(input({customer_mode:'new',customer_name:'Nome',customer_phone:'123'}),db.pool)).rejects.toThrow('sale_customer_phone_invalid');
  });
  it('cria novo cliente com espaços limpos e endereço composto pelo servidor',async()=>{
    const result=await sell(input({customer_mode:'new',customer_name:'  José   de Sá  ',customer_phone:'(21) 98888-6666',fulfillment_mode:'delivery',
      delivery_address:'Texto divergente',delivery_address_fields:{street:' Rua   Um ',number:'',no_number:true,complement:'Casa',district:'Centro',city:'Niterói',uf:'RJ',cep:'24000-000'}}),db.pool);
    const o=await order(result.order_id);expect(o.delivery_address).toBe('Rua Um, s/n, Casa, Centro, Niterói - RJ, 24000-000');
    expect((await db.pool.query('SELECT name,phone_e164 FROM commerce.customers WHERE id=$1',[o.customer_id])).rows[0]).toMatchObject({name:'José de Sá',phone_e164:'+5521988886666'});
  });
  it('venda anônima preserva parte sem identificação e legado reutiliza telefone sem renomear',async()=>{
    const result=await sell(input({customer_mode:'anonymous'}),db.pool);
    const anonymous=await order(result.order_id);expect(anonymous.contact_id).toBeNull();
    expect((await db.pool.query('SELECT name,phone_e164 FROM commerce.customers WHERE id=$1',[anonymous.customer_id])).rows[0]).toEqual({name:null,phone_e164:null});
    const legacyInput=input({customer_name:'Nome digitado errado',customer_phone:'21999998888'});
    const legacy=await sell(legacyInput,db.pool);
    const oldFingerprint=operationFingerprint({customer_name:legacyInput.customer_name,customer_phone:'+5521999998888',unit_id:null,
      items:[{product_id:product,quantity:1,unit_price:120,reference_unit_price:120,discount_amount:0}],payment_method:'Pix',
      payment_due_on:null,fulfillment_mode:'pickup',delivery_address:null,source_tag:'walkin_balcao'});
    expect((await db.pool.query(`SELECT payload_after->>'request_fingerprint' fp FROM audit.events
      WHERE entity_id=$1 AND event_type='walkin_order_created'`,[legacy.order_id])).rows[0].fp).toBe(oldFingerprint);
    expect(await sell(legacyInput,db.pool)).toEqual(legacy);
    expect((await order(legacy.order_id)).customer_id).toBe(customer);
    expect((await db.pool.query('SELECT name FROM commerce.customers WHERE id=$1',[customer])).rows[0].name).toBe('Maria da Silva');
  });
  it('duas criações concorrentes com mesmo telefone geram um cliente',async()=>{
    const base={customer_mode:'new' as const,customer_name:'Concorrente',customer_phone:'21977776666'};
    const result=await Promise.allSettled([sell(input(base),db.pool),sell(input(base),db.pool)]);
    expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((await db.pool.query("SELECT count(*)::int n FROM commerce.customers WHERE environment='test' AND phone_e164='+5521977776666'")).rows[0].n).toBe(1);
  });
});
