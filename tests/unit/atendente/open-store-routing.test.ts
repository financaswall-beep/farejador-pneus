import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{ROUTING_PROXIMITY_FIRST:true,ROUTING_GEO_ROAD_DISTANCE:false,
  ROUTING_MATRIZ_AS_STORE:true,ROUTING_MATRIZ_COMPETES:true,WHOLESALE_UNIFIED_STOCK:true}}));
vi.mock('../../../src/parceiro/queries.js',()=>({upsertPartnerCustomerWithClient:vi.fn()}));
vi.mock('../../../src/atendente-v2/wholesale-stock-read.js',()=>({getMatrizWholesaleStockQty:async()=>10,checkMatrizGalpaoShortfall:async()=>[]}));
import { decideConfiguredStore } from '../../../src/atendente-v2/configured-routing.js';
import { withStoreOpeningScope, filterOpeningCandidates } from '../../../src/atendente-v2/routing-store-hours.js';
import { deliveryBlockResponse, type DeliverySettings } from '../../../src/atendente-v2/matriz-delivery-settings.js';
const at=new Date('2026-10-12T22:00:00Z'); // segunda 19h em Brasília
const hours=(close='18:00')=>[1,2,3,4,5].map(day=>({day,opens_at:'08:00',closes_at:close}));
const settings={delivery_enabled:true,pickup_enabled:true,radius_km:40,address:'Matriz fictícia',latitude:0,longitude:0,
  days:[1,2,3,4,5],opens_at:'08:00',closes_at:'18:00',delivery_days:1,store_hours:hours()} as DeliverySettings;
type Store={id:string;lng:number;hours:unknown;leads?:number};
function clientFor(stores:Store[]) {
  const query=vi.fn(async(sql:string,values:unknown[])=>{
    let rows:unknown[]=[];
    if(sql.includes('opening_hours_weekly'))rows=stores.filter(s=>(values[1] as string[]).includes(s.id)).map(s=>({unit_id:s.id,hours:s.hours}));
    else if(sql.includes('FROM network.partner_units pu'))rows=stores.map(s=>({unit_id:s.id,partner_id:s.id,
      partner_unit_id:s.id,slug:s.id,partner_name:s.id,unit_name:s.id,service_mode:'both',latitude:0,longitude:s.lng,
      delivery_radius_km:40,has_city_coverage:true,neighborhoods:[]}));
    else if(sql.includes('FROM commerce.partner_stock_levels'))rows=[{id:'stock-'+values[1],item_name:'Pneu',sale_price:'179.90'}];
    else if(sql.includes('AS lead_count'))rows=stores.map(s=>({unit_id:s.id,unit_created_at:new Date(0),lead_count:String(s.leads??0),last_lead_at:null}));
    else throw new Error('Consulta inesperada: '+sql);
    return {rows,rowCount:rows.length};
  });
  return {client:{query} as unknown as PoolClient,query};
}
const input={municipio:'Rio de Janeiro',items:[{product_id:'p',quantity:1}],modalidade:'pickup' as const,
  customerLocation:{lat:0,lng:0},clientNeighborhoodCanonical:null};
async function decide(stores:Store[],matrix:DeliverySettings=settings,time=at) {
  const {client,query}=clientFor(stores);
  const raw=await withStoreOpeningScope(client,'test','criar_pedido',async()=>JSON.stringify(await decideConfiguredStore(client,'test',input,matrix)),time);
  return {out:JSON.parse(raw),query};
}
describe('horários na escolha de atendimento agora',()=>{
  it('pula a loja fechada próxima e escolhe a aberta mantendo estoque e distância',async()=>{
    const {out}=await decide([{id:'fechada',lng:.02,hours:hours()},{id:'aberta',lng:.04,hours:hours('20:00')}]);
    expect(out).toMatchObject({kind:'partner',routing:{unitId:'aberta'}});
  });
  it('Matriz fechada não vence uma borracharia aberta',async()=>{
    expect((await decide([{id:'aberta',lng:.04,hours:hours('20:00')}])).out.kind).toBe('partner');
  });
  it('Matriz aberta atende quando parceiros próximos estão fechados',async()=>{
    expect((await decide([{id:'fechada',lng:.02,hours:hours()}],{...settings,store_hours:hours('20:00')})).out)
      .toMatchObject({kind:'matriz',canFulfill:true});
  });
  it('todas fechadas: informa próxima abertura sem prometer estoque ou pedido',async()=>{
    const {out}=await decide([{id:'fechada',lng:.02,hours:hours()}]);
    expect(out).toMatchObject({erro:'lojas_fechadas',disponivel:false,proxima_abertura:{days_ahead:1,opens_at:'08:00'}});
    expect(out.orientacao).toContain('escalar_humano');
  });
  it('horário ausente fica a confirmar; nunca é tratado como aberto',async()=>{
    expect((await decide([{id:'sem-cadastro',lng:.02,hours:null}],{...settings,store_hours:null})).out)
      .toMatchObject({erro:'horario_nao_confirmado',disponivel:false});
  });
  it('não troca um bloqueio de cobertura por horário quando a Matriz está fora do raio',async()=>{
    const {client}=clientFor([]);
    const out=JSON.parse(await withStoreOpeningScope(client,'test','calcular_frete',async()=>{
      const decision=await decideConfiguredStore(client,'test',{...input,modalidade:'delivery'},
        {...settings,radius_km:1,longitude:.1});
      return JSON.stringify(deliveryBlockResponse(decision.blockReason!));
    },at));
    expect(out.erro).toBe('outside_radius');expect(out).not.toHaveProperty('proxima_abertura');
  });
  it('consultar horário continua permitindo informar sobre uma loja fechada',async()=>{
    const {client,query}=clientFor([{id:'a',lng:.02,hours:hours()}]);
    const out=await withStoreOpeningScope(client,'test','consultar_horario_loja',async()=>
      JSON.stringify({count:(await filterOpeningCandidates(client,'test',[{ctx:{unitId:'a',unitName:'a'}}])).length}),at);
    expect(JSON.parse(out).count).toBe(1);expect(query).not.toHaveBeenCalled();
  });
  it('respeita abertura exata e exclui o instante do fechamento',async()=>{
    const {client}=clientFor([{id:'a',lng:.02,hours:hours()}]);
    const candidate={ctx:{unitId:'a',unitName:'a'}};
    for(const [time,expected] of [['2026-10-12T10:59:00Z',0],['2026-10-12T11:00:00Z',1],['2026-10-12T21:00:00Z',0]] as const) {
      let count=-1;
      await withStoreOpeningScope(client,'test','buscar_produto',async()=>{count=(await filterOpeningCandidates(client,'test',[candidate])).length;return '{}';},new Date(time));
      expect(count).toBe(expected);
    }
  });
});
