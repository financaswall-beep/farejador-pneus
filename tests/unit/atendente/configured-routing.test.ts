import type { PoolClient } from 'pg';
import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({stock:vi.fn(),shortfall:vi.fn(),env:{ROUTING_MATRIZ_AS_STORE:true,ROUTING_MATRIZ_COMPETES:true,
  ROUTING_PROXIMITY_FIRST:true,ROUTING_GEO_ROAD_DISTANCE:false,WHOLESALE_UNIFIED_STOCK:true}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:mocks.env}));
vi.mock('../../../src/atendente-v2/wholesale-stock-read.js',()=>({getMatrizWholesaleStockQty:mocks.stock,checkMatrizGalpaoShortfall:mocks.shortfall}));
vi.mock('../../../src/parceiro/queries.js',()=>({upsertPartnerCustomerWithClient:vi.fn()}));
import { decideConfiguredStore } from '../../../src/atendente-v2/configured-routing.js';
import { decideStoreForItemsGeo } from '../../../src/atendente-v2/fulfillment.js';
import type { DeliverySettings } from '../../../src/atendente-v2/matriz-delivery-settings.js';
const settings:DeliverySettings={delivery_enabled:true,pickup_enabled:true,radius_km:12,address:'Loja teste',latitude:0,longitude:0,
  days:[1,2,3,4,5],opens_at:'08:00',closes_at:'18:00',delivery_days:1};
const input={municipio:'Outra cidade',items:[{product_id:'p1',quantity:2}],modalidade:'delivery' as 'delivery'|'pickup',
  customerLocation:{lat:0,lng:0},clientNeighborhoodCanonical:null};
function clientFor(partners:{id:string;lng:number;radius?:number;stock?:boolean;leads?:number}[]){
  return {query:vi.fn(async(sql:string,values:unknown[])=>{
    let rows:unknown[]=[];
    if(sql.includes('FROM network.partner_units pu')&&sql.includes('COALESCE(pu.display_name'))rows=partners.map(p=>({
      unit_id:p.id,partner_id:p.id,partner_unit_id:p.id,slug:p.id,partner_name:p.id,unit_name:p.id,
      service_mode:'both',latitude:'0',longitude:String(p.lng),delivery_radius_km:String(p.radius??40),has_city_coverage:false,neighborhoods:[]}));
    else if(sql.includes('FROM commerce.partner_stock_levels')){
      if(partners.find(p=>p.id===values[1])?.stock!==false)rows=[{id:'stock-'+values[1],item_name:'Pneu'}];
    }else if(sql.includes('FROM commerce.product_prices'))rows=[{price_amount:'100'}];
    else if(sql.includes('AS lead_count'))rows=partners.map(p=>({unit_id:p.id,unit_created_at:new Date('2025-01-01'),lead_count:String(p.leads??0),last_lead_at:null}));
    else if(sql.includes('matriz_delivery_settings'))rows=[];
    else throw new Error('Consulta inesperada: '+sql.slice(0,100));
    return {rows,rowCount:rows.length};
  })} as unknown as PoolClient;
}
beforeEach(()=>{mocks.stock.mockReset().mockResolvedValue(10);mocks.shortfall.mockReset().mockResolvedValue([]);});
describe('cadastro de entrega sobre o motor real de distribuição',()=>{
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
