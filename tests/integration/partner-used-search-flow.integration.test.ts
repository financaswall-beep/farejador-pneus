import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {startPostgres,stopPostgres,buildRestrictedConnectionString,type IntegrationDb} from './helpers/postgres.js';
import {createPartnerFixture,type PartnerFixture} from './helpers/partner-fixtures.js';
import type {ChatMessage} from '../../src/atendente-v2/types.js';
import type {StockRequest} from '../../src/atendente-v2/stock-confirmation-store.js';

// Só a coordenada é fixa; estoque, preço, horário, roteamento, confirmação e outbox são reais no banco descartável.
vi.mock('../../src/atendente-v2/customer-location.js',()=>({resolveCustomerLocation:async()=>({lat:-22.9,lng:-43.2})}));
let db:IntegrationDb,store:PartnerFixture,stockId:string,productId:string;
let tools:typeof import('../../src/atendente-v2/tools.js');
let partnerDb:typeof import('../../src/parceiro/db.js');
let confirmation:typeof import('../../src/atendente-v2/stock-confirmation.js');
let worker:typeof import('../../src/atendente-v2/stock-confirmation-worker.js');
let opening:typeof import('./helpers/store-opening-fixtures.js');
let env:typeof import('../../src/shared/config/env.js')['env'];
const location={bairro:'Méier',municipio:'Rio de Janeiro'};
let native=992731000;
beforeAll(async()=>{
  db=await startPostgres();
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    PARTNER_DATABASE_URL:buildRestrictedConnectionString(db.connectionString),CHATWOOT_HMAC_SECRET:'test-only',ADMIN_AUTH_TOKEN:'test-only',
    PARTNER_STOCK_CONFIRMATION:'true',WHOLESALE_UNIFIED_STOCK:'true',PICKUP_TO_PARTNER:'true',ROUTING_GEO:'true',
    ROUTING_PROXIMITY_FIRST:'true',ROUTING_GEO_ROAD_DISTANCE:'false',ROUTING_MATRIZ_AS_STORE:'false',
    ROUTING_MATRIZ_COMPETES:'false',PHOTO_REQUESTS:'false',BOT_OUTBOX:'true',AGENT_V2_CONVERSATION_IDS:'*'});
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Sem chamadas externas no teste descartável');}));
  tools=await import('../../src/atendente-v2/tools.js');
  partnerDb=await import('../../src/parceiro/db.js');
  confirmation=await import('../../src/atendente-v2/stock-confirmation.js');
  worker=await import('../../src/atendente-v2/stock-confirmation-worker.js');
  opening=await import('./helpers/store-opening-fixtures.js');
  env=(await import('../../src/shared/config/env.js')).env;
  store=await createPartnerFixture(db.pool);
  await opening.configureTestOpeningHours(db.pool,store.unitId);
  await db.pool.query("UPDATE network.partner_units SET service_mode='both',delivery_radius_km=NULL,latitude=-22.9,longitude=-43.2,accepts_network_orders=true WHERE id=$1",[store.partnerUnitId]);
  const simple=await import('../../src/parceiro/operation-stock-simple.js');
  const stock=await simple.createSimpleOperationTire({...store.ctx,role:'owner'},'Teste local',{
    tire_size:'110/90-17',vehicle_type:'motorcycle',tire_width_mm:110,tire_aspect_ratio:90,tire_rim_diameter:17,
    tire_condition:'meia_vida',brand:null,quantity_on_hand:2,sale_price:63.5});
  stockId=stock.stock_id;
  productId=(await db.pool.query('SELECT product_id FROM commerce.partner_stock_levels WHERE id=$1',[stockId])).rows[0].product_id;
},180_000);
afterAll(async()=>{
  vi.unstubAllGlobals();
  if(partnerDb)await partnerDb.partnerPool.end();
  if(tools)await(await import('../../src/persistence/db.js')).pool.end();
  if(db)await stopPostgres(db);
});
async function conversation(){
  const id=(await db.pool.query("INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at) VALUES('test',$1,2,'open',now()) RETURNING id",[++native])).rows[0].id;
  const trigger=(await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
    VALUES('test',$1,$2,$3,'contact',0,false,'Quero meia-vida 110/90-17 para retirar',now()) RETURNING id`,[id,native,++native])).rows[0].id;
  return {id,trigger};
}
async function execute(id:string,trigger:string,name:string,args:Record<string,unknown>,stockHistory:ChatMessage[]=[]){
  const client=await db.pool.connect();try{return JSON.parse(await opening.atOpenStoreTime(()=>tools.executeTool(client,'test',id,name,args,undefined,{triggerMessageId:trigger,stockHistory})));}
  finally{client.release();}
}
async function requests(id:string):Promise<StockRequest[]>{return(await db.pool.query("SELECT * FROM commerce.partner_stock_requests WHERE environment='test' AND conversation_id=$1 ORDER BY created_at,id",[id])).rows;}
describe('busca completa de meia-vida sem marca antes do TENHO',()=>{
  it.each([undefined,'pickup'] as const)('busca %s chega ao app da loja sem raio de entrega; TENHO informa preço e condição sem repetir modalidade',async modalidade=>{
    const {id,trigger}=await conversation();
    const result=await execute(id,trigger,'buscar_produto',{...location,medida_pneu:'110/90-17',condicao_pneu:'meia_vida',quantidade:1,...(modalidade?{modalidade}:{})});
    expect(result).toMatchObject({aguardando_parceiro:true,disponibilidade_confirmada:false});
    const request=(await requests(id))[0]!;
    expect(request.unit_id).toBe(store.unitId);
    expect(request.items).toEqual([{tire_size:'110/90-17',tire_condition:'meia_vida',quantity:1,price:63.5}]);
    const client=await db.pool.connect();try{await confirmation.publishStockRequest(client,'test',id);}finally{client.release();}
    await partnerDb.withPartnerContext(store.partnerUnitId,async scoped=>{
      expect((await scoped.query('SELECT commerce.answer_partner_stock_request($1,1,true) status',[request.id])).rows[0].status).toBe('confirmed');
    });
    await opening.atOpenStoreTime(()=>worker.processStockConfirmations());
    const notices=(await db.pool.query("SELECT body FROM ops.outbound_messages WHERE environment='test' AND conversation_id=$1 AND kind='stock_text'",[id])).rows;
    expect(notices).toHaveLength(1);expect(notices[0].body).toContain('Meia-vida');expect(notices[0].body).toContain('63,50');
    expect(notices[0].body).not.toMatch(/prefere|buscar|receber|\?/i);
    expect((await db.pool.query('SELECT quantity_on_hand,quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1',[stockId])).rows[0])
      .toEqual({quantity_on_hand:2,quantity_reserved:0});
    expect((await db.pool.query("SELECT id FROM commerce.orders WHERE environment='test' AND source_conversation_id=$1",[id])).rows).toHaveLength(0);
  });
  it('entrega explícita não aproveita a retirada da loja sem raio e não cria consulta',async()=>{
    const {id,trigger}=await conversation();
    const result=await execute(id,trigger,'buscar_produto',{...location,medida_pneu:'110/90-17',condicao_pneu:'meia_vida',modalidade:'delivery'});
    expect(result).toMatchObject({sem_estoque_loja_perto:true});expect(result.aguardando_parceiro).toBeUndefined();
    expect(await requests(id)).toHaveLength(0);
  });
  it('busca com marca e consulta posterior de localização mantêm Pirelli e quantidade 2',async()=>{
    const {id,trigger}=await conversation();
    const result=await execute(id,trigger,'buscar_produto',{...location,medida_pneu:'110/90-17',condicao_pneu:'meia_vida',modalidade:'pickup',marca:'Pirelli',quantidade:2});
    expect(result.aguardando_parceiro).toBe(true);
    const first=(await requests(id))[0]!;expect(first.items[0]).toMatchObject({requested_brand:'Pirelli',brand:'Pirelli',quantity:2});
    const history:ChatMessage[]=[{role:'assistant',content:null,tool_calls:[{id:'prior-search',type:'function',function:{name:'buscar_produto',arguments:'{"marca":"Pirelli","quantidade":2}'}}]},
      {role:'tool',tool_call_id:'prior-search',content:JSON.stringify({produtos:[{product_id:productId,partner_generic:true,requested_brand:'Pirelli',total_stock_available:0}]})}];
    expect((await execute(id,trigger,'localizacao_loja',{...location,product_ids:[productId]},history)).aguardando_parceiro).toBe(true);
    const current=await requests(id);expect(current).toHaveLength(1);expect(current[0]!.id).toBe(first.id);
    expect(current[0]!.routing.items).toEqual([{product_id:productId,quantity:2,requested_brand:'Pirelli'}]);
    const changeArgs={...location,medida_pneu:'110/90-17',condicao_pneu:'meia_vida',modalidade:'pickup',marca:'Michelin',quantidade:1};
    const changed=await execute(id,trigger,'buscar_produto',changeArgs,history);
    expect(changed.aguardando_parceiro).toBe(true);expect(changed.solicitacao_id).not.toBe(first.id);
    history.push({role:'assistant',content:null,tool_calls:[{id:'change-brand',type:'function',function:{name:'buscar_produto',arguments:JSON.stringify(changeArgs)}}]},
      {role:'tool',tool_call_id:'change-brand',content:JSON.stringify(changed)});
    const located=await execute(id,trigger,'localizacao_loja',{...location,product_ids:[productId]},history);
    expect(located.solicitacao_id).toBe(changed.solicitacao_id);
    const latest=(await requests(id)).find(row=>row.id===changed.solicitacao_id)!;
    expect(latest.routing.items).toEqual([{product_id:productId,quantity:1,requested_brand:'Michelin'}]);
  });
  it('sem confirmação do parceiro mantém o caminho anterior e o SKU genérico fora da Matriz',async()=>{
    env.PARTNER_STOCK_CONFIRMATION=false;
    try{
      const {id,trigger}=await conversation();
      const result=await execute(id,trigger,'buscar_produto',{...location,medida_pneu:'110/90-17',condicao_pneu:'meia_vida',modalidade:'pickup'});
      expect(result.encontrado).toBe(false);expect(await requests(id)).toHaveLength(0);
      expect((await db.pool.query("SELECT product_id FROM commerce.product_full WHERE environment='test' AND product_id=$1",[productId])).rows).toHaveLength(0);
    }finally{env.PARTNER_STOCK_CONFIRMATION=true;}
  });
});
