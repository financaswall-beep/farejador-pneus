import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
import {configureTestOpeningHours} from './helpers/store-opening-fixtures.js';
import {MATRIZ_COORD} from '../../src/atendente-v2/matriz-freight.js';
let db:IntegrationDb,product:string,conversation:string,serial=99380000;
let execute:typeof import('../../src/atendente-v2/tools.js').executeTool;
let withTime:typeof import('../../src/atendente-v2/routing-store-hours.js').withStoreOpeningContext;
const midnight=new Date();midnight.setUTCDate(midnight.getUTCDate()+7+(7-midnight.getUTCDay())%7);midnight.setUTCHours(4,0,0,0);
const opening=new Date(midnight.getTime()+86400000);opening.setUTCHours(13,15,0,0);
const openingIso=opening.toISOString(),deliveryDate=new Date(opening.getTime()+86400000).toISOString().slice(0,10);
beforeAll(async()=>{
 db=await startPostgres();await configureTestOpeningHours(db.pool);
 Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
  CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',ROUTING_GEO:'false',PICKUP_TO_PARTNER:'false',
  PHOTO_REQUESTS:'false',PARTNER_STOCK_CONFIRMATION:'false',WHOLESALE_UNIFIED_STOCK:'true',
  WHOLESALE_MATRIZ_DECREMENT:'true',WHOLESALE_MATRIZ_OVERSELL_GUARD:'true',WHOLESALE_MATRIZ_RETAIL_COST:'true',MATRIZ_CENTRAL_LEDGER:'true'});
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Rede externa proibida');}));
 ({executeTool:execute}=await import('../../src/atendente-v2/tools.js'));
 ({withStoreOpeningContext:withTime}=await import('../../src/atendente-v2/routing-store-hours.js'));
 await db.pool.query("INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz') ON CONFLICT DO NOTHING");
 product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
  VALUES('test','24H-KENDA','Pneu Kenda 100/80-14','tire','Kenda','meia_vida') RETURNING id`)).rows[0].id;
 await db.pool.query("INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'100/80-14')",[product]);
 await db.pool.query("INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES('test',$1,89)",[product]);
 await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
  VALUES('test','100/80-14','Kenda','meia_vida',10,40)`);
 const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
  VALUES('test',$1,'Rafael Teste','+5521900000280') RETURNING id`,[++serial])).rows[0].id;
 const c=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_account_id,chatwoot_conversation_id,contact_id,current_status,started_at)
  VALUES('test',2,$1,$2,'open',now()) RETURNING id,chatwoot_conversation_id`,[++serial,contact])).rows[0];conversation=c.id;
 const message=(await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,
  sender_type,message_type,is_private,content,sent_at) VALUES('test',$1,$2,$3,'contact',0,false,'Quero um Kenda para retirar, no Pix',now()) RETURNING id`,
 [conversation,c.chatwoot_conversation_id,++serial])).rows[0].id;
 await db.pool.query(`INSERT INTO core.message_attachments(environment,conversation_id,message_id,chatwoot_attachment_id,file_type,coordinates_lat,coordinates_lng)
  VALUES('test',$1,$2,$3,'location',$4,$5)`,[conversation,message,++serial,MATRIZ_COORD.lat,MATRIZ_COORD.lng]);
 await db.pool.query(`UPDATE commerce.matriz_delivery_settings SET settings=jsonb_set(jsonb_set(settings,'{store_hours}',
  '[{"day":1,"opens_at":"10:15","closes_at":"15:00"}]'::jsonb),'{days}','[2]'::jsonb) WHERE environment='test'`);
},180000);
afterAll(async()=>{vi.unstubAllGlobals();if(db)await stopPostgres(db);});
async function close(mode='pickup',request=randomUUID()){
 const client=await db.pool.connect();try{await client.query('BEGIN');
  const result=JSON.parse(await withTime('test',()=>execute(client,'test',conversation,'criar_pedido',{
   nome_cliente:'Rafael Teste',modalidade:mode,forma_pagamento:'pix',valor_frete:mode==='delivery'?10:0,
   endereco_entrega:mode==='delivery'?'Rua Teste, 25, Centro, Rio de Janeiro, RJ':undefined,
   itens:[{product_id:product,quantidade:1,preco_unitario:89}],
  },undefined,{triggerMessageId:request}),midnight));await client.query('COMMIT');return {result,request};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
it('reserva à madrugada, preserva retry e consulta; só expira após abertura mais o prazo',async()=>{
 const {result,request}=await close();expect(result).toMatchObject({ok:true,atendimento_a_partir_de:openingIso});
 expect((await close('pickup',request)).result).toMatchObject({ok:true,repetido:true,order_number:result.order_number,atendimento_a_partir_de:result.atendimento_a_partir_de});
 const order=(await db.pool.query("SELECT * FROM commerce.orders WHERE environment='test' AND order_number=$1",[result.order_number])).rows[0];
 const canExpire=async(cutoff:string)=>(await db.pool.query(`SELECT commerce.bot_order_cancellation_allowed(o,NULL::commerce.partner_orders,$2::timestamptz) allowed
  FROM commerce.orders o WHERE id=$1`,[order.id,cutoff])).rows[0].allowed;
 expect(await canExpire(new Date(opening.getTime()-1000).toISOString())).toBe(false);expect(await canExpire(openingIso)).toBe(true);
 expect((await db.pool.query("SELECT quantity_reserved FROM commerce.wholesale_stock WHERE environment='test' AND measure='100/80-14'")).rows[0].quantity_reserved).toBe(1);
 const client=await db.pool.connect();try{
  const queried=JSON.parse(await execute(client,'test',conversation,'consultar_pedido',{numero_pedido:result.order_number}));
  expect(JSON.stringify(queried)).toContain(result.atendimento_a_partir_de);
 }finally{client.release();}
 await expect(db.pool.query('UPDATE commerce.orders SET retrieved_at=now() WHERE id=$1',[order.id])).rejects.toThrow('order_not_available_yet');
 await expect(db.pool.query("UPDATE commerce.orders SET fulfillment_not_before=NULL,retrieved_at=now() WHERE id=$1",[order.id])).rejects.toThrow('order_not_available_yet');
 const cancelling=await db.pool.connect();try{await cancelling.query('BEGIN');
  const {cancelOpenBotOrder}=await import('../../src/atendente-v2/cancel-open-order.js');
  await cancelOpenBotOrder(cancelling,'test',order.id,'fixture','Fim do teste 24h');await cancelling.query('COMMIT');
 }catch(error){await cancelling.query('ROLLBACK');throw error;}finally{cancelling.release();}
 expect((await db.pool.query("SELECT quantity_reserved FROM commerce.wholesale_stock WHERE environment='test' AND measure='100/80-14'")).rows[0].quantity_reserved).toBe(0);
});
it('entrega fora do expediente conserva reserva e agenda no dia de entrega após a abertura',async()=>{
 const {result}=await close('delivery');expect(result.ok).toBe(true);
 const order=(await db.pool.query(`SELECT fulfillment_not_before,scheduled_delivery_date::text scheduled FROM commerce.orders
  WHERE environment='test' AND order_number=$1`,[result.order_number])).rows[0];
 expect(order.fulfillment_not_before.toISOString()).toBe(openingIso);expect(order.scheduled).toBe(deliveryDate);
});
