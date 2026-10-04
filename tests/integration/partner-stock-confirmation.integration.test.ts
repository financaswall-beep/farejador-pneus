import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { startPostgres,stopPostgres,buildRestrictedConnectionString,type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture,type PartnerFixture } from './helpers/partner-fixtures.js';
import type { StockRequest } from '../../src/atendente-v2/stock-confirmation-store.js';

const mocks=vi.hoisted(()=>({db:null as any,route:vi.fn(),closing:vi.fn()}));
vi.mock('../../src/shared/config/env.js',()=>({env:{PARTNER_STOCK_CONFIRMATION:true,BOT_OUTBOX:true,
  AGENT_V2_WORKER_ENABLED:true,FAREJADOR_ENV:'test',AGENT_V2_CONVERSATION_IDS:['*']}}));
vi.mock('../../src/persistence/db.js',()=>({pool:{query:(...args:any[])=>mocks.db.query(...args),connect:()=>mocks.db.connect()}}));
vi.mock('../../src/atendente-v2/tools.js',()=>({executeTool:(...args:any[])=>mocks.closing(...args)}));
vi.mock('../../src/atendente-v2/conversation-control.js',()=>({syncHumanIntervention:async()=>({mode:'bot',resumed_at:null})}));
vi.mock('../../src/atendente-v2/stock-confirmation-routing.js',()=>({
  confirmationLocation:async()=>({municipio:'rio de janeiro',customerLocation:{lat:-22.9,lng:-43.2},clientNeighborhoodCanonical:null,modalidade:'pickup'}),
  routeStockConfirmation:(...args:any[])=>mocks.route(...args),
}));
import { gatePartnerSearch,publishStockRequest,sealStockRequestAndGuardText,requirePartnerStockConfirmation,cancelStockConfirmation } from '../../src/atendente-v2/stock-confirmation.js';
import { processStockConfirmations } from '../../src/atendente-v2/stock-confirmation-worker.js';
import { requestConfirms } from '../../src/atendente-v2/stock-confirmation-store.js';
import { validateStockConfirmationOutbound } from '../../src/atendente-v2/stock-confirmation-outbound.js';
import { deferPhotoUntilStockConfirmed } from '../../src/atendente-v2/stock-confirmation-photo.js';
import { getRecentProductIds } from '../../src/atendente-v2/conversation-products.js';
import { env } from '../../src/shared/config/env.js';

let db:IntegrationDb;let restricted:Pool;let a:PartnerFixture;let b:PartnerFixture;
const productA=randomUUID();const productB=randomUUID();let conversation:string;let message:string;let native=890000000;
const secondStocks=new Map<string,string>();
beforeAll(async()=>{
  db=await startPostgres();mocks.db=db.pool;
  restricted=new Pool({connectionString:buildRestrictedConnectionString(db.connectionString),max:3});
  a=await createPartnerFixture(db.pool);b=await createPartnerFixture(db.pool);
  for(const unit of [a,b]) {
    await db.pool.query("UPDATE commerce.partner_stock_levels SET tire_size='90/90-18',tire_condition='meia_vida' WHERE id=$1",[unit.stockId]);
    const second=(await db.pool.query(`INSERT INTO commerce.partner_stock_levels
      (environment,unit_id,item_name,tire_size,tire_condition,is_tracked,quantity_on_hand)
      VALUES('test',$1,'Pneu 80/100-14','80/100-14','meia_vida',true,10) RETURNING id`,[unit.unitId])).rows[0].id;
    secondStocks.set(unit.unitId,second);
  }
  for(const [id,measure] of [[productA,'90/90-18'],[productB,'80/100-14']])await db.pool.query(`INSERT INTO commerce.products
    (id,environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES($1,'test',$2,$3,'tire','Pirelli','meia_vida')`,[id,'CONF-'+id,'Pneu '+measure]);
},180_000);
afterAll(async()=>{if(restricted)await restricted.end();if(db)await stopPostgres(db);});
beforeEach(async()=>{
  env.PHOTO_REQUESTS=false;
  conversation=(await db.pool.query(`INSERT INTO core.conversations
    (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at)
    VALUES('test',$1,2,'open',now()) RETURNING id`,[++native])).rows[0].id;
  message=(await db.pool.query(`INSERT INTO core.messages
    (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
    VALUES('test',$1,$2,$3,'contact',0,false,'Tem 90/90-18 e 80/100-14?',now()) RETURNING id`,[conversation,native,++native])).rows[0].id;
  mocks.closing.mockReset();mocks.route.mockReset();
  mocks.route.mockImplementation(async(_client,_env,_location,items,excluded=[])=>{
    const unit=excluded.includes(a.unitId)?b:a;
    if(excluded.includes(b.unitId))return {kind:'matriz',canFulfill:false};
    return {kind:'partner',routing:{unitId:unit.unitId,ctx:unit.ctx,
      items:items.map((item:any)=>({...item,partner_stock_id:item.product_id===productA?unit.stockId:secondStocks.get(unit.unitId),central_price:90}))}};
  });
});
async function withRestricted<T>(unit:PartnerFixture,action:(client:import('pg').PoolClient)=>Promise<T>) {
  const client=await restricted.connect();
  try{await client.query('BEGIN');await client.query("SELECT set_config('app.partner_unit_id',$1,true)",[unit.partnerUnitId]);
    const result=await action(client);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function answer(unit:PartnerFixture,id:string,available:boolean,revision=1) {
  return withRestricted(unit,async client=>(await client.query('SELECT commerce.answer_partner_stock_request($1,$2,$3) AS status',
    [id,revision,available])).rows[0].status as string);
}
async function request():Promise<StockRequest> {
  return (await db.pool.query('SELECT * FROM commerce.partner_stock_requests WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1',[conversation])).rows[0];
}
async function search(product=productA) {
  const client=await db.pool.connect();
  try{return JSON.parse(await gatePartnerSearch(client,'test',conversation,'buscar_produto',{bairro:'méier'},
    JSON.stringify({encontrado:true,produtos:[{product_id:product,tire_size:product===productA?'90/90-18':'80/100-14',total_stock_available:3}]})));}
  finally{client.release();}
}
describe('Confirmação do parceiro em PostgreSQL real',()=>{
  it('agrupa duas medidas, não publica antes do texto de espera e não reserva estoque',async()=>{
    expect((await search()).aguardando_parceiro).toBe(true);await search(productB);
    const row=await request();expect(row.routing.items).toHaveLength(2);expect(row.sealed).toBe(false);
    expect(await answer(a,row.id,true)).toBe('changed');
    const client=await db.pool.connect();try{
      expect(await sealStockRequestAndGuardText(client,'test',conversation,'Tenho sim!')).toContain('Estou confirmando');
      await publishStockRequest(client,'test',conversation);
    }finally{client.release();}
    expect(await answer(a,row.id,true)).toBe('confirmed');
    const stock=(await db.pool.query('SELECT quantity_on_hand,quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1',[a.stockId])).rows[0];
    expect(Number(stock.quantity_on_hand)).toBe(10);expect(Number(stock.quantity_reserved)).toBe(0);
  });
  it('RLS oculta outra loja e grants impedem leitura da conversa e alteração direta',async()=>{
    await search();const row=await request();await publishStockRequest(awaitClient,'test',conversation);
    expect(await answer(b,row.id,true)).toBe('not_found');
    expect(await withRestricted(b,async c=>(await c.query('SELECT id FROM commerce.partner_stock_requests')).rows)).toEqual([]);
    await expect(withRestricted(a,c=>c.query('SELECT conversation_id FROM commerce.partner_stock_requests'))).rejects.toThrow(/permission denied/);
    await expect(withRestricted(a,c=>c.query("UPDATE commerce.partner_stock_requests SET status='confirmed' WHERE id=$1",[row.id]))).rejects.toThrow(/permission denied/);
  });
  it('dois toques concorrentes aceitam uma resposta e não permitem invertê-la',async()=>{
    await search();await publishStockRequest(awaitClient,'test',conversation);const row=await request();
    const results=await Promise.all([answer(a,row.id,true),answer(a,row.id,false)]);
    expect(new Set(results).size).toBe(1);
    expect(await answer(a,row.id,(await request()).status==='confirmed')).toBe(results[0]);
  });
  it('rejeita resposta vencida e manda a consulta para outra loja, sem dividir o conjunto',async()=>{
    await search();await search(productB);await publishStockRequest(awaitClient,'test',conversation);const row=await request();
    await db.pool.query("UPDATE commerce.partner_stock_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[row.id]);
    expect(await answer(a,row.id,true)).toBe('expired');await processStockConfirmations();
    const next=await request();expect(next.id).not.toBe(row.id);expect(next.unit_id).toBe(b.unitId);
    expect(next.routing.items).toHaveLength(2);expect(next.excluded_unit_ids).toContain(a.unitId);expect(next.sealed).toBe(true);
  });
  it('NÃO TENHO procura a segunda loja; TENHO notifica o cliente uma vez pela outbox',async()=>{
    await search();await publishStockRequest(awaitClient,'test',conversation);const first=await request();
    await answer(a,first.id,false);await processStockConfirmations();const next=await request();
    expect(next.unit_id).toBe(b.unitId);await answer(b,next.id,true);await processStockConfirmations();await processStockConfirmations();
    const outbound=(await db.pool.query("SELECT * FROM ops.outbound_messages WHERE conversation_id=$1 AND kind='stock_text'",[conversation])).rows;
    expect(outbound).toHaveLength(1);expect(outbound[0].body).toContain('A loja confirmou');
    expect(await validateStockConfirmationOutbound(awaitClient,outbound[0])).toBe(true);
    await cancelStockConfirmation(awaitClient,'test',conversation);
    expect(await validateStockConfirmationOutbound(awaitClient,outbound[0])).toBe(false);
  });
  it('não cria outra consulta para a mesma confirmação, mas não autoriza mais unidades que as confirmadas',async()=>{
    await search();await publishStockRequest(awaitClient,'test',conversation);const row=await request();await answer(a,row.id,true);
    expect((await search()).disponibilidade_confirmada).toBe(true);expect((await request()).id).toBe(row.id);
    const confirmed=await request();expect(requestConfirms(confirmed,a.unitId,[{product_id:productA,quantity:2}])).toBe(false);
    expect(requestConfirms(confirmed,b.unitId,[{product_id:productA,quantity:1}])).toBe(false);
  });
  it('preserva a consulta publicada e seu relógio quando o JSONB reordena campos',async()=>{
    await search();await publishStockRequest(awaitClient,'test',conversation);const before=await request();
    await search();const after=await request();
    expect(after.id).toBe(before.id);expect(after.expires_at).toEqual(before.expires_at);expect(after.sealed).toBe(true);
  });
  it('fecha pelo motor existente apenas sem nova mensagem do cliente',async()=>{
    await search();await publishStockRequest(awaitClient,'test',conversation);const row=await request();
    await db.pool.query('UPDATE commerce.partner_stock_requests SET closing_args=$2::jsonb WHERE id=$1',
      [row.id,JSON.stringify({nome_cliente:'Cliente teste',modalidade:'pickup',forma_pagamento:'pix'})]);
    mocks.closing.mockResolvedValue(JSON.stringify({ok:true,order_number:'PED-TESTE',total:'90',retirada:{nome_loja:'Loja teste'}}));
    await answer(a,row.id,true);await processStockConfirmations();
    expect(mocks.closing).toHaveBeenCalledTimes(1);expect((await request()).status).toBe('completed');
    expect((await db.pool.query('SELECT body FROM ops.outbound_messages WHERE conversation_id=$1',[conversation])).rows[0].body).toContain('PED-TESTE');
  });
  it('a Matriz mantém o resultado original sem criar uma consulta',async()=>{
    mocks.route.mockResolvedValue({kind:'matriz',canFulfill:true});const result=await search();
    expect(result.aguardando_parceiro).toBeUndefined();expect(result.produtos).toHaveLength(1);
    expect(await request()).toBeUndefined();
  });
  it('não fecha automaticamente se o cliente mandou outra mensagem enquanto esperava',async()=>{
    await search();await publishStockRequest(awaitClient,'test',conversation);const row=await request();
    await db.pool.query('UPDATE commerce.partner_stock_requests SET closing_args=$2::jsonb WHERE id=$1',
      [row.id,JSON.stringify({nome_cliente:'Cliente teste',modalidade:'pickup',forma_pagamento:'pix'})]);
    await db.pool.query(`INSERT INTO core.messages
      (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
      VALUES('test',$1,$2,$3,'contact',0,false,'Mudei de ideia',clock_timestamp()+interval '1 second')`,[conversation,native,++native]);
    await answer(a,row.id,true);await processStockConfirmations();expect(mocks.closing).not.toHaveBeenCalled();
  });
  it('nega revisão antiga, retira confirmação vencida da outbox e cancela consulta sem tocar no estoque',async()=>{
    await search();await publishStockRequest(awaitClient,'test',conversation);const row=await request();
    expect(await answer(a,row.id,true,2)).toBe('changed');await answer(a,row.id,true);await processStockConfirmations();
    const outbound=(await db.pool.query("SELECT * FROM ops.outbound_messages WHERE conversation_id=$1 AND kind='stock_text'",[conversation])).rows[0];
    await db.pool.query("UPDATE commerce.partner_stock_requests SET valid_until=now()-interval '1 second' WHERE id=$1",[row.id]);
    expect(await validateStockConfirmationOutbound(awaitClient,outbound)).toBe(false);
    await cancelStockConfirmation(awaitClient,'test',conversation);expect((await request()).status).toBe('cancelled');
  });
  it('guarda a foto pedida uma vez e a encaminha somente à loja que confirmou depois de rerotear',async()=>{
    env.PHOTO_REQUESTS=true;
    await search();await search(productB);await publishStockRequest(awaitClient,'test',conversation);const original=await request();
    expect(await getRecentProductIds(awaitClient,conversation,'test')).toEqual([productA,productB]);
    expect(JSON.parse((await deferPhotoUntilStockConfirmed(awaitClient,'test',conversation,productA))!).foto_solicitada).toBe(true);
    expect((await db.pool.query('SELECT id FROM commerce.photo_requests WHERE conversation_id=$1',[native-1])).rows).toHaveLength(0);
    await answer(a,original.id,false);await processStockConfirmations();const next=await request();
    expect(next.routing.photoProductIds).toContain(productA);await answer(b,next.id,true);await processStockConfirmations();
    const photos=(await db.pool.query(`SELECT unit_id FROM commerce.photo_requests WHERE conversation_id=
      (SELECT chatwoot_conversation_id FROM core.conversations WHERE id=$1)`,[conversation])).rows;
    expect(photos).toHaveLength(1);expect(photos[0].unit_id).toBe(b.unitId);
  });
  it('usa a última autorização de fechamento sem reiniciar o prazo da consulta',async()=>{
    await search();await publishStockRequest(awaitClient,'test',conversation);const row=await request();
    const latest=(await db.pool.query(`INSERT INTO core.messages
      (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
      VALUES('test',$1,$2,$3,'contact',0,false,'Pode fechar, vou pagar Pix',clock_timestamp()+interval '1 second') RETURNING id`,
      [conversation,native,++native])).rows[0].id;
    const client=await db.pool.connect();try {
      const routing=(await mocks.route(client,'test',row.routing.location,row.routing.items)).routing;
      expect(JSON.parse((await requirePartnerStockConfirmation(client,'test',conversation,routing,
        {nome_cliente:'Joao Cliente',modalidade:'pickup',forma_pagamento:'pix'},latest))!).aguardando_parceiro).toBe(true);
    }finally{client.release();}
    const updated=await request();expect(updated.request_message_id).toBe(latest);expect(updated.expires_at).toEqual(row.expires_at);
    mocks.closing.mockResolvedValue(JSON.stringify({ok:true,order_number:'PED-FECHAMENTO',total:90}));
    await answer(a,row.id,true);await processStockConfirmations();expect(mocks.closing).toHaveBeenCalledTimes(1);
  });
  it('não oferece as duas medidas separadas quando nenhuma loja atende o conjunto',async()=>{
    await search();mocks.route.mockResolvedValue({kind:'matriz',canFulfill:false});
    const result=await search(productB);expect(result).toMatchObject({encontrado:false,conjunto_nao_confirmado:true});
    expect((await request()).status).toBe('cancelled');
  });
});
// Queryable separado permite usar os helpers sem manter conexão reservada no teste.
const awaitClient={query:(...args:any[])=>mocks.db.query(...args)} as import('pg').PoolClient;
