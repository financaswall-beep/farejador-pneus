import type { PoolClient } from 'pg';
import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({road:vi.fn(),env:{ROUTING_PROXIMITY_FIRST:true,ROUTING_GEO_ROAD_DISTANCE:false,GOOGLE_MAPS_API_KEY:'fake',GEO_ROAD_TOPK:1}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:mocks.env}));
vi.mock('../../../src/parceiro/queries.js',()=>({upsertPartnerCustomerWithClient:vi.fn()}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/shared/geo/geo-cache.js',()=>({cachedRoadDistanceKm:mocks.road,cachedMatrizRoadInfo:vi.fn()}));
import { resolveProductAvailabilityByProximity } from '../../../src/atendente-v2/fulfillment.js';
import { observeSearchProducts,withStockSearchTrace } from '../../../src/atendente-v2/stock-search-trace.js';

type Store={id:string;mode:'pickup'|'delivery'|'both';lng:number|null;radius:number|null;stock:number;coverage?:boolean};
async function search(stores:Store[]){
  const query=vi.fn(async(sql:string,values:unknown[])=>{
    if(sql.includes('FROM network.partner_units pu')||sql.includes('FROM network.unit_coverage uc'))return {rows:stores.map(s=>({
      unit_id:s.id,partner_id:s.id,partner_unit_id:s.id,slug:s.id,partner_name:s.id,unit_name:s.id,
      service_mode:s.mode,latitude:s.lng===null?null:'0',longitude:s.lng===null?null:String(s.lng),
      delivery_radius_km:s.radius===null?null:String(s.radius),has_city_coverage:s.coverage??false,neighborhoods:[],
    }))};
    if(sql.includes('FROM commerce.partner_stock_levels'))return {rows:stores.filter(s=>(values[1] as string[]).includes(s.id)&&s.stock>0)
      .map(s=>({unit_id:s.id,product_id:'p1',disponivel:String(s.stock)}))};
    if(sql.includes('INSERT INTO ops.bot_stock_searches'))return {rows:[]};
    throw new Error('Consulta inesperada');
  });
  const client={query} as unknown as PoolClient;
  let availability=new Map<string,{unitId:string;available:number}>();
  await withStockSearchTrace(client,'test','conversation',{key:'job:0:0',tool:'buscar_produto',args:{}},async()=>{
    observeSearchProducts([{id:'p1',measure:'180/55-17',matrixAvailable:0}]);
    availability=await resolveProductAvailabilityByProximity(client,'test',{municipio:'Rio de Janeiro',
      customerLocation:{lat:0,lng:0},clientNeighborhoodCanonical:'meier',productIds:['p1']});
    return JSON.stringify({encontrado:true});
  });
  const recorded=query.mock.calls.find(c=>c[0].includes('INSERT INTO ops.bot_stock_searches'))!;
  return {availability,query,observations:JSON.parse(recorded[1][6] as string)[0].stores};
}
beforeEach(()=>{mocks.env.ROUTING_PROXIMITY_FIRST=true;mocks.env.ROUTING_GEO_ROAD_DISTANCE=false;mocks.road.mockReset();});
describe('procura local em lojas aptas à retirada',()=>{
  it('observa a falta na loja both sem raio e a disponibilidade da pickup sem prometer entrega delas',async()=>{
    const result=await search([{id:'teste',mode:'both',lng:.02,radius:null,stock:0},
      {id:'retirada',mode:'pickup',lng:.03,radius:null,stock:2}]);
    expect([...result.availability]).toEqual([]);
    expect(result.observations).toEqual([
      {id:'teste',name:'teste',kind:'partner',available:false},
      {id:'retirada',name:'retirada',kind:'partner',available:true},
      {id:'matriz',name:'Matriz',kind:'matrix',available:false},
    ]);
    const stock=result.query.mock.calls.find(c=>c[0].includes('FROM commerce.partner_stock_levels'))!;
    expect(stock[1]).toEqual(['test',['teste','retirada'],['p1']]);
  });
  it('mantém o estoque da loja que pode entregar, mesmo com retirada mais próxima e com mais estoque',async()=>{
    const result=await search([{id:'retirada',mode:'pickup',lng:.02,radius:null,stock:10},
      {id:'entrega',mode:'delivery',lng:.05,radius:10,stock:2}]);
    expect(result.availability.get('p1')).toEqual({unitId:'entrega',available:2});
    expect(result.observations.filter((s:{kind:string})=>s.kind==='partner')).toHaveLength(2);
  });
  it('não atribui demanda acima dos 15 km de retirada, sem coordenadas ou à entrega sem raio',async()=>{
    const result=await search([{id:'longe',mode:'pickup',lng:.2,radius:null,stock:0},
      {id:'fora-raio',mode:'both',lng:.2,radius:1,stock:0},
      {id:'sem-raio',mode:'delivery',lng:.02,radius:null,stock:0},
      {id:'sem-coordenada',mode:'pickup',lng:null,radius:null,stock:0}]);
    expect(result.observations).toEqual([{id:'matriz',name:'Matriz',kind:'matrix',available:false}]);
    expect(result.query.mock.calls.some(c=>c[0].includes('FROM commerce.partner_stock_levels'))).toBe(false);
  });
  it('preserva o filtro de cobertura da entrega quando a proximidade está desligada',async()=>{
    mocks.env.ROUTING_PROXIMITY_FIRST=false;
    const result=await search([{id:'retirada',mode:'both',lng:.02,radius:null,stock:10},
      {id:'entrega',mode:'delivery',lng:.05,radius:null,stock:2,coverage:true}]);
    expect(result.availability.get('p1')).toEqual({unitId:'entrega',available:2});
    expect(result.observations.find((s:{id:string})=>s.id==='retirada')).toMatchObject({available:true});
  });
  it('medir a retirada não desloca a entrega do limite TOPK nem altera sua distância de rua',async()=>{
    mocks.env.ROUTING_GEO_ROAD_DISTANCE=true;
    mocks.road.mockResolvedValueOnce([8]).mockResolvedValueOnce([2]);
    const result=await search([{id:'retirada',mode:'pickup',lng:.01,radius:null,stock:0},
      {id:'entrega',mode:'delivery',lng:.04,radius:6,stock:2}]);
    expect([...result.availability]).toEqual([]);
    expect(mocks.road.mock.calls[0]![2]).toEqual([{lat:0,lng:.04}]);
    expect(result.observations.some((s:{id:string})=>s.id==='entrega')).toBe(false);
  });
});
