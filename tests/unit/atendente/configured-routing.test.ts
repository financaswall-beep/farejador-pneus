import type { Pool,PoolClient } from 'pg';
import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({stock:vi.fn(),shortfall:vi.fn(),location:vi.fn(),env:{FAREJADOR_ENV:'test',ROUTING_MATRIZ_AS_STORE:true,ROUTING_MATRIZ_COMPETES:true,
  ROUTING_PROXIMITY_FIRST:true,ROUTING_GEO_ROAD_DISTANCE:false,WHOLESALE_UNIFIED_STOCK:true}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:mocks.env}));
vi.mock('../../../src/atendente-v2/wholesale-stock-read.js',()=>({getMatrizWholesaleStockQty:mocks.stock,checkMatrizGalpaoShortfall:mocks.shortfall}));
vi.mock('../../../src/parceiro/queries.js',()=>({upsertPartnerCustomerWithClient:vi.fn()}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/atendente-v2/customer-location.js',()=>({resolveCustomerLocation:mocks.location,getLatestCustomerLocation:vi.fn()}));
vi.mock('../../../src/atendente-v2/routing-decisions.js',()=>({recordGeoRoutingDecision:vi.fn(),recordPartnerRoutingDecision:vi.fn()}));
vi.mock('../../../src/shared/geo/google-maps.js',async original=>({
  ...await original<typeof import('../../../src/shared/geo/google-maps.js')>(),geocodeAddress:mocks.location,
}));
import { decideConfiguredStore } from '../../../src/atendente-v2/configured-routing.js';
import { decideStoreForItemsGeo } from '../../../src/atendente-v2/fulfillment.js';
import type { DeliverySettings } from '../../../src/atendente-v2/matriz-delivery-settings.js';
import { DEFAULT_MATRIZ_FREIGHT } from '../../../src/atendente-v2/matriz-freight.js';
import { decideStoreGeoOrFallback } from '../../../src/atendente-v2/delivery-quote-routing.js';
import { simulateBotDelivery } from '../../../src/admin/painel/bot-delivery-simulation.js';
const settings:DeliverySettings={delivery_enabled:true,pickup_enabled:true,radius_km:12,address:'Loja teste',latitude:0,longitude:0,
  days:[1,2,3,4,5],opens_at:'08:00',closes_at:'18:00',delivery_days:1,freight:{...DEFAULT_MATRIZ_FREIGHT}};
const input={municipio:'Outra cidade',items:[{product_id:'p1',quantity:2}],modalidade:'delivery' as 'delivery'|'pickup',
  customerLocation:{lat:0,lng:0},clientNeighborhoodCanonical:null};
function clientFor(partners:{id:string;lng:number;radius?:number;stock?:boolean;leads?:number}[],saved?:DeliverySettings){
  return {release:vi.fn(),query:vi.fn(async(sql:string,values:unknown[])=>{
    let rows:unknown[]=[];
    if(sql.includes('FROM network.partner_units pu')&&sql.includes('COALESCE(pu.display_name'))rows=partners.map(p=>({
      unit_id:p.id,partner_id:p.id,partner_unit_id:p.id,slug:p.id,partner_name:p.id,unit_name:p.id,
      service_mode:'both',latitude:'0',longitude:String(p.lng),delivery_radius_km:String(p.radius??40),has_city_coverage:false,neighborhoods:[]}));
    else if(sql.includes('FROM commerce.partner_stock_levels')){
      if(partners.find(p=>p.id===values[1])?.stock!==false)rows=[{id:'stock-'+values[1],item_name:'Pneu'}];
    }else if(sql.includes('FROM commerce.product_prices'))rows=[{price_amount:'100'}];
    else if(sql.includes('AS lead_count'))rows=partners.map(p=>({unit_id:p.id,unit_created_at:new Date('2025-01-01'),lead_count:String(p.leads??0),last_lead_at:null}));
    else if(sql.includes('matriz_delivery_settings'))rows=saved?[{settings:saved,version:1,updated_at:new Date()}]:[];
    else if(sql.includes('SELECT id FROM commerce.products'))rows=[{id:'p1'}];
    else if(['BEGIN','ROLLBACK'].includes(sql)||sql.startsWith('SET LOCAL'))rows=[];
    else throw new Error('Consulta inesperada: '+sql.slice(0,100));
    return {rows,rowCount:rows.length};
  })} as unknown as PoolClient;
}
beforeEach(()=>{mocks.stock.mockReset().mockResolvedValue(10);mocks.shortfall.mockReset().mockResolvedValue([]);
  mocks.location.mockReset().mockResolvedValue({...input.customerLocation,confidence:'ROOFTOP'});});
describe('cadastro de entrega sobre o motor real de distribuição',()=>{
  it.each([{partners:[]},{partners:[{id:'longe',lng:.6,radius:100}]}])('Matriz pode atender a 50 km, inclusive quando existe somente parceiro distante: %j',async({partners})=>{
    expect(await decideConfiguredStore(clientFor(partners),'test',input,{...settings,radius_km:55,longitude:.45}))
      .toMatchObject({kind:'matriz',canFulfill:true});
  });
  it('a última faixa de preço não autoriza entrega acima dos 55 km',async()=>{
    expect(await decideConfiguredStore(clientFor([]),'test',input,{...settings,radius_km:55,longitude:.5}))
      .toMatchObject({kind:'matriz',canFulfill:false,blockReason:'outside_radius'});
  });
  it.each([[.1,0],[.25,17.25],[.45,32.5]])('simulação e decisão usada na cotação/fechamento cobram a tabela salva a %s graus',async(longitude,price)=>{
    const saved={...settings,radius_km:55,longitude,freight:{first_limit_km:20,first_price_brl:0,second_limit_km:40,second_price_brl:17.25,above_price_brl:32.5}};
    const client=clientFor([{id:'longe',lng:.6,radius:100}],saved);
    const db={connect:async()=>client} as unknown as Pool;
    const simulation=await simulateBotDelivery({address:'Rua de teste, 10',settings:saved,items:input.items},db);
    const quote=await decideStoreGeoOrFallback(client,'test','conversation',{municipio:null,items:input.items,bairro:null,modality:'quote'});
    const order=await decideStoreGeoOrFallback(client,'test','conversation',{municipio:null,items:input.items,bairro:null,modality:'delivery'});
    expect(simulation).toMatchObject({selected:'matriz',freight:price});
    expect(quote).toMatchObject({routing:null,matrizFreight:price});
    expect(order).toMatchObject({routing:null,matrizFreight:price});
  });
  it('o frete editado da Matriz não muda a cobrança dos parceiros',async()=>{
    const saved={...settings,delivery_enabled:false,freight:{...settings.freight,first_price_brl:55}};
    const client=clientFor([{id:'a',lng:.05}],saved);
    const result=await simulateBotDelivery({address:'Rua de teste, 10',settings:saved,items:input.items},{connect:async()=>client} as unknown as Pool);
    expect(result).toMatchObject({selected:'a',freight:9.9});
  });
  it('sem cadastro mantém exatamente a decisão anterior',async()=>{
    const client=clientFor([{id:'a',lng:.05}]);
    expect(await decideConfiguredStore(client,'test',input,null)).toEqual(await decideStoreForItemsGeo(client,'test',input));
  });
  it('Matriz mais próxima participa quando tem cobertura e o pedido completo',async()=>{
    expect(await decideConfiguredStore(clientFor([{id:'a',lng:.05}]),'test',input,settings)).toMatchObject({kind:'matriz',canFulfill:true});
  });
  it.each([{delivery_enabled:false},{radius_km:1,longitude:.1}])('restrição da Matriz preserva o parceiro apto: %j',async patch=>{
    expect(await decideConfiguredStore(clientFor([{id:'a',lng:.05}]),'test',input,{...settings,...patch})).toMatchObject({kind:'partner',routing:{unitId:'a'}});
  });
  it('empate de distância mantém o parceiro',async()=>{
    expect(await decideConfiguredStore(clientFor([{id:'a',lng:0}]),'test',input,settings)).toMatchObject({kind:'partner',routing:{unitId:'a'}});
  });
  it('justiça continua escolhendo dentro do anel mais próximo',async()=>{
    const client=clientFor([{id:'a',lng:.02,leads:20},{id:'b',lng:.05,leads:0},{id:'c',lng:.2,leads:0}]);
    expect(await decideConfiguredStore(client,'test',input,{...settings,delivery_enabled:false})).toMatchObject({kind:'partner',routing:{unitId:'b'},ringKm:10});
  });
  it('não usa cidade para escapar do raio nem cai na Matriz pausada',async()=>{
    expect(await decideConfiguredStore(clientFor([]),'test',input,{...settings,delivery_enabled:false})).toMatchObject({kind:'matriz',canFulfill:false,blockReason:'delivery_paused'});
    expect(await decideConfiguredStore(clientFor([]),'test',input,{...settings,longitude:1})).toMatchObject({canFulfill:false,blockReason:'outside_radius'});
  });
  it('pedido com consumo compartilhado acima do saldo não entra na Matriz',async()=>{
    mocks.shortfall.mockResolvedValue([{available:2,needed:4}]);
    expect(await decideConfiguredStore(clientFor([]),'test',input,settings)).toMatchObject({canFulfill:false,blockReason:'insufficient_stock'});
  });
  it('pausa de entrega preserva retirada; desabilitar retirada a bloqueia',async()=>{
    expect(await decideConfiguredStore(clientFor([]),'test',{...input,modalidade:'pickup'},{...settings,delivery_enabled:false})).toMatchObject({canFulfill:true});
    expect(await decideConfiguredStore(clientFor([]),'test',{...input,modalidade:'pickup'},{...settings,pickup_enabled:false})).toMatchObject({canFulfill:false,blockReason:'pickup_disabled'});
  });
});
