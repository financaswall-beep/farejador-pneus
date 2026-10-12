import { atOpenStoreTime, configureTestOpeningHours, testOpeningHours } from './helpers/store-opening-fixtures.js';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture,type PartnerFixture } from './helpers/partner-fixtures.js';
import { MATRIZ_COORD } from '../../src/atendente-v2/matriz-freight.js';

const mocked=vi.hoisted(()=>({routing:null as any}));
vi.mock('../../src/atendente-v2/delivery-quote-routing.js',()=>({
  fillCityFromPin:async(_client:unknown,_env:unknown,_id:unknown,current:unknown)=>current,
  decideStoreGeoOrFallback:async()=>({routing:mocked.routing}),quoteFreteFromPin:async()=>null,
}));
let db:IntegrationDb;let unit:PartnerFixture;let product:string;let serial=982000000;
let tools:typeof import('../../src/atendente-v2/tools.js');
let publish:typeof import('../../src/atendente-v2/stock-confirmation.js')['publishStockRequest'];
let pools:Array<import('pg').Pool>=[];
beforeAll(async()=>{
  db=await startPostgres();
  await configureTestOpeningHours(db.pool);
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    PARTNER_DATABASE_URL:db.connectionString,CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin-token',
    PARTNER_STOCK_CONFIRMATION:'true',BOT_OUTBOX:'false',ROUTING_GEO:'false',PHOTO_REQUESTS:'false',WHOLESALE_UNIFIED_STOCK:'true'});
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Rede externa proibida neste teste');}));
  tools=await import('../../src/atendente-v2/tools.js');
  ({publishStockRequest:publish}=await import('../../src/atendente-v2/stock-confirmation.js'));
  pools=[(await import('../../src/persistence/db.js')).pool,(await import('../../src/parceiro/db.js')).partnerPool];
  unit=await createPartnerFixture(db.pool);
  await configureTestOpeningHours(db.pool,unit.unitId);
  product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES('test',$1,'Pneu 90/90-18','tire','Pirelli','meia_vida') RETURNING id`,['CONF-'+randomUUID()])).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'90/90-18')`,[product]);
  await db.pool.query(`INSERT INTO commerce.product_prices(environment,product_id,price_amount,price_type,valid_from)
    VALUES('test',$1,90,'regular',now()-interval '1 day')`,[product]);
  await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES('test',$1,90)`,[product]);
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
    VALUES('test','90/90-18','Pirelli','meia_vida',5,20)`);
  await db.pool.query(`UPDATE commerce.partner_stock_levels SET product_id=$2,tire_size='90/90-18',
    tire_condition='meia_vida',quantity_on_hand=3,sale_price=90 WHERE id=$1`,[unit.stockId,product]);
  await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz') ON CONFLICT DO NOTHING`);
},180_000);
afterAll(async()=>{vi.unstubAllGlobals();for(const p of pools)await p.end();if(db)await stopPostgres(db);});
async function customer() {
  const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
    VALUES('test',$1,'Cliente teste','+5521999990000') RETURNING id`,[++serial])).rows[0].id;
  const row=(await db.pool.query(`INSERT INTO core.conversations
    (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,contact_id,started_at)
    VALUES('test',$1,2,'open',$2,now()) RETURNING id,chatwoot_conversation_id`,[++serial,contact])).rows[0];
  const message=(await db.pool.query(`INSERT INTO core.messages
    (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
    VALUES('test',$1,$2,$3,'contact',0,false,'Localização fictícia de teste',now()) RETURNING id`,
    [row.id,row.chatwoot_conversation_id,++serial])).rows[0].id;
  await db.pool.query(`INSERT INTO core.message_attachments
    (environment,conversation_id,message_id,chatwoot_attachment_id,file_type,coordinates_lat,coordinates_lng)
    VALUES('test',$1,$2,$3,'location',$4,$5)`,[row.id,message,++serial,MATRIZ_COORD.lat,MATRIZ_COORD.lng]);
  return row.id as string;
}
async function close(conversation:string,requestId:string,price=90) {
  const client=await db.pool.connect();
  try{await client.query('BEGIN');const result=JSON.parse(await atOpenStoreTime(() => tools.executeTool(client,'test',conversation,'criar_pedido',{
    nome_cliente:'Joao Cliente',modalidade:'delivery',forma_pagamento:'pix',municipio:'rio de janeiro',bairro:'Méier',
    endereco_entrega:'Rua Teste, 100, Méier, Rio de Janeiro',valor_frete:9.9,
    itens:[{product_id:product,quantidade:1,preco_unitario:price}],
  },undefined,{triggerMessageId:requestId}), 'test'));await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
describe('TENHO ligado ao fechamento real do bot e à reserva existente',()=>{
  it('não cria venda antes do TENHO; depois cria e reserva uma única vez',async()=>{
    mocked.routing={unitId:unit.unitId,ctx:unit.ctx,items:[{product_id:product,partner_stock_id:unit.stockId,quantity:1,unit_price:90}]};
    const conversation=await customer();const trigger=randomUUID();
    const waiting=await close(conversation,trigger);expect(waiting.aguardando_parceiro).toBe(true);
    expect((await db.pool.query('SELECT id FROM commerce.orders WHERE source_conversation_id=$1',[conversation])).rows).toHaveLength(0);
    expect(Number((await db.pool.query('SELECT quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1',[unit.stockId])).rows[0].quantity_reserved)).toBe(0);
    const client=await db.pool.connect();try{
      await publish(client,'test',conversation);await client.query('BEGIN');
      await client.query("SELECT set_config('app.partner_unit_id',$1,true)",[unit.partnerUnitId]);
      expect((await client.query('SELECT commerce.answer_partner_stock_request($1,1,true) AS status',[waiting.solicitacao_id])).rows[0].status).toBe('confirmed');
      await client.query('COMMIT');
    }finally{client.release();}
    const sale=await close(conversation,trigger);expect(sale.ok).toBe(true);
    const retry=await close(conversation,trigger);expect(retry.order_number).toBe(sale.order_number);
    const orders=(await db.pool.query('SELECT partner_order_id FROM commerce.orders WHERE source_conversation_id=$1',[conversation])).rows;
    expect(orders).toHaveLength(1);expect(orders[0].partner_order_id).toBeTruthy();
    expect(Number((await db.pool.query('SELECT quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1',[unit.stockId])).rows[0].quantity_reserved)).toBe(1);
  });
  it('fecha a venda da Matriz sem exigir TENHO mesmo com a flag ligada',async()=>{
    mocked.routing=null;const conversation=await customer();const result=await close(conversation,randomUUID());
    expect(result).toMatchObject({ok:true});expect(result.aguardando_parceiro).toBeUndefined();
    expect((await db.pool.query('SELECT id FROM commerce.partner_stock_requests WHERE conversation_id=$1',[conversation])).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT partner_order_id FROM commerce.orders WHERE source_conversation_id=$1',[conversation])).rows[0].partner_order_id).toBeNull();
  });
  it('preço editado exige nova mensagem e o pedido/espelho usam o preço da loja após TENHO',async()=>{
    await db.pool.query('UPDATE commerce.partner_stock_levels SET sale_price=189.90 WHERE id=$1',[unit.stockId]);
    mocked.routing={unitId:unit.unitId,ctx:unit.ctx,items:[{product_id:product,partner_stock_id:unit.stockId,quantity:1,unit_price:189.9}]};
    const conversation=await customer(), oldTrigger=randomUUID();
    expect(await close(conversation,oldTrigger,90)).toMatchObject({preco_alterado:true});
    expect(await close(conversation,oldTrigger,189.9)).toMatchObject({nova_confirmacao_obrigatoria:true});
    expect((await db.pool.query('SELECT id FROM commerce.orders WHERE source_conversation_id=$1',[conversation])).rows).toHaveLength(0);
    const trigger=randomUUID(), waiting=await close(conversation,trigger,189.9);
    expect(waiting.aguardando_parceiro).toBe(true);
    const client=await db.pool.connect();try{
      await publish(client,'test',conversation);await client.query('BEGIN');
      await client.query("SELECT set_config('app.partner_unit_id',$1,true)",[unit.partnerUnitId]);
      await client.query('SELECT commerce.answer_partner_stock_request($1,1,true)',[waiting.solicitacao_id]);
      await client.query('COMMIT');
    }finally{client.release();}
    const sale=await close(conversation,trigger,189.9);
    expect(sale).toMatchObject({ok:true});expect(Number(sale.total)).toBe(199.8);
    const item=(await db.pool.query(`SELECT oi.unit_price,poi.unit_price partner_price
      FROM commerce.orders o JOIN commerce.order_items oi ON oi.order_id=o.id
      JOIN commerce.partner_order_items poi ON poi.order_id=o.partner_order_id
      WHERE o.environment='test' AND o.source_conversation_id=$1`,[conversation])).rows[0];
    expect(item).toEqual({unit_price:'189.90',partner_price:'189.90'});
  });
  it('loja que fechou após TENHO não recebe pedido nem nova reserva',async()=>{
    mocked.routing={unitId:unit.unitId,ctx:unit.ctx,items:[{product_id:product,partner_stock_id:unit.stockId,quantity:1,unit_price:189.9}]};
    const conversation=await customer(), trigger=randomUUID();
    const waiting=await close(conversation,trigger,189.9);
    expect(waiting.aguardando_parceiro).toBe(true);
    const client=await db.pool.connect();try{
      await publish(client,'test',conversation);await client.query('BEGIN');
      await client.query("SELECT set_config('app.partner_unit_id',$1,true)",[unit.partnerUnitId]);
      await client.query('SELECT commerce.answer_partner_stock_request($1,1,true)',[waiting.solicitacao_id]);
      await client.query('COMMIT');
    }finally{client.release();}
    const before=(await db.pool.query('SELECT quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1',[unit.stockId])).rows;
    await db.pool.query(`UPDATE network.partner_units SET opening_hours_weekly=$2::jsonb WHERE environment='test' AND unit_id=$1`,
      [unit.unitId,JSON.stringify(testOpeningHours.map(row=>({...row,closes_at:'11:00'})))]);
    try{
      expect(await close(conversation,trigger,189.9)).toMatchObject({erro:'lojas_fechadas',proxima_abertura:{days_ahead:1,opens_at:'08:00'}});
      expect((await db.pool.query('SELECT id FROM commerce.orders WHERE source_conversation_id=$1',[conversation])).rows).toHaveLength(0);
      expect((await db.pool.query('SELECT quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1',[unit.stockId])).rows).toEqual(before);
    }finally{await configureTestOpeningHours(db.pool,unit.unitId);}
  });
  it('Matriz fechada informa abertura sem criar pedido; pedido existente continua consultável',async()=>{
    mocked.routing=null;const existing=await customer(), fresh=await customer();
    const trigger=randomUUID(), first=await close(existing,trigger);
    expect(first).toMatchObject({ok:true});
    await db.pool.query(`UPDATE commerce.matriz_delivery_settings SET settings=jsonb_set(settings,'{store_hours}',$1::jsonb)
      WHERE environment='test'`,[JSON.stringify(testOpeningHours.map(row=>({...row,closes_at:'11:00'})))]);
    try{
      expect(await close(fresh,randomUUID())).toMatchObject({erro:'lojas_fechadas',proxima_abertura:{days_ahead:1,opens_at:'08:00'}});
      expect((await db.pool.query('SELECT id FROM commerce.orders WHERE source_conversation_id=$1',[fresh])).rows).toHaveLength(0);
      expect(await close(existing,trigger)).toMatchObject({ok:true,repetido:true,order_number:first.order_number});
    }finally{await configureTestOpeningHours(db.pool);}
  });
});
