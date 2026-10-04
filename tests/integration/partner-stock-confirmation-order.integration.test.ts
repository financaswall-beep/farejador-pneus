import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture,type PartnerFixture } from './helpers/partner-fixtures.js';

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
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    PARTNER_DATABASE_URL:db.connectionString,CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-admin-token',
    PARTNER_STOCK_CONFIRMATION:'true',BOT_OUTBOX:'false',ROUTING_GEO:'false',PHOTO_REQUESTS:'false'});
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Rede externa proibida neste teste');}));
  tools=await import('../../src/atendente-v2/tools.js');
  ({publishStockRequest:publish}=await import('../../src/atendente-v2/stock-confirmation.js'));
  pools=[(await import('../../src/persistence/db.js')).pool,(await import('../../src/parceiro/db.js')).partnerPool];
  unit=await createPartnerFixture(db.pool);
  product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES('test',$1,'Pneu 90/90-18','tire','Pirelli','meia_vida') RETURNING id`,['CONF-'+randomUUID()])).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'90/90-18')`,[product]);
  await db.pool.query(`INSERT INTO commerce.product_prices(environment,product_id,price_amount,price_type,valid_from)
    VALUES('test',$1,90,'regular',now()-interval '1 day')`,[product]);
  await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES('test',$1,90)`,[product]);
  await db.pool.query(`UPDATE commerce.partner_stock_levels SET product_id=$2,tire_size='90/90-18',
    tire_condition='meia_vida',quantity_on_hand=3 WHERE id=$1`,[unit.stockId,product]);
  await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz') ON CONFLICT DO NOTHING`);
},180_000);
afterAll(async()=>{vi.unstubAllGlobals();for(const p of pools)await p.end();if(db)await stopPostgres(db);});
async function customer() {
  const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
    VALUES('test',$1,'Cliente teste','+5521999990000') RETURNING id`,[++serial])).rows[0].id;
  return (await db.pool.query(`INSERT INTO core.conversations
    (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,contact_id,started_at)
    VALUES('test',$1,2,'open',$2,now()) RETURNING id`,[++serial,contact])).rows[0].id as string;
}
async function close(conversation:string,requestId:string) {
  const client=await db.pool.connect();
  try{await client.query('BEGIN');const result=JSON.parse(await tools.executeTool(client,'test',conversation,'criar_pedido',{
    nome_cliente:'Joao Cliente',modalidade:'delivery',forma_pagamento:'pix',municipio:'rio de janeiro',bairro:'Méier',
    endereco_entrega:'Rua Teste, 100, Méier, Rio de Janeiro',valor_frete:9.9,
    itens:[{product_id:product,quantidade:1,preco_unitario:90}],
  },undefined,{triggerMessageId:requestId}));await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
describe('TENHO ligado ao fechamento real do bot e à reserva existente',()=>{
  it('não cria venda antes do TENHO; depois cria e reserva uma única vez',async()=>{
    mocked.routing={unitId:unit.unitId,ctx:unit.ctx,items:[{product_id:product,partner_stock_id:unit.stockId,quantity:1,central_price:90}]};
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
    expect(result.ok).toBe(true);expect(result.aguardando_parceiro).toBeUndefined();
    expect((await db.pool.query('SELECT id FROM commerce.partner_stock_requests WHERE conversation_id=$1',[conversation])).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT partner_order_id FROM commerce.orders WHERE source_conversation_id=$1',[conversation])).rows[0].partner_order_id).toBeNull();
  });
});
