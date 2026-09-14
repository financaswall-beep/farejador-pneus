import {describe,it,expect} from 'vitest';
import {bindingAt,geographyTotals,geographyAvailability,decideGeography} from '../../../src/marketing/geography-rules.js';
import type {GeoData} from '../../../src/admin/painel/geography-data.js';
import type {GeoCampaign} from '../../../src/marketing/geography-types.js';
export function fixture():GeoData {
  return {catalog:[{id:'1',name:'Scooter',scope:'matrix'}],ads:[],offers:[],snapshots:[],delivery:null,
    bindings:[{id:'1',campaign_id:'1',allocation:'dedicated',municipality:'São Gonçalo',valid_from:'2026-08-01',valid_until:'2026-09-30',coverage:'unknown',offers:[],reason:'Teste'}],
    insights:[{campaign_id:'1',campaign_name:'Scooter',day:'2026-09-05',spend:60,currency:'BRL',conversations:10,collected_at:'2026-09-14T12:00:00Z'}],
    refs:[{id:'r1',conversation_id:'c1',campaign_id:'1',ad_id:'11',municipality:'São Gonçalo',captured_at:'2026-09-05T12:00:00Z',day:'2026-09-05',mature:true}],
    sales:[{id:'o1',referral_id:'r1',conversation_id:'c1',campaign_id:'1',ad_id:'11',municipality:'São Gonçalo',day:'2026-09-06',captured_at:'2026-09-05T12:00:00Z',realized_at:'2026-09-06T12:00:00Z',revenue:200,margin:100}],stock:[]};
}
const total=(d:GeoData,enabled=true)=>geographyTotals(d,['1'],'São Gonçalo','2026-09-01','2026-09-14',enabled);
describe('Geografia: resultados identificados',()=>{
  it('calcula custo e margem a partir dos valores, não de médias dos dias',()=>{
    const d=fixture();d.insights.push({...d.insights[0]!,day:'2026-09-06',spend:20});
    expect(total(d)).toMatchObject({spend:80,sales:1,revenue:200,gross_margin:100,margin:20,cpa:80,conversations:1,conversion:100});
  });
  it('conta a conversa uma vez mesmo com várias entradas e várias vendas',()=>{
    const d=fixture();d.refs.push({...d.refs[0]!,id:'r2'});d.sales.push({...d.sales[0]!,id:'o2',referral_id:'r2'});
    expect(total(d)).toMatchObject({conversations:1,converted:1,conversion:100,sales:2,cpa:30,mature_conversations:1});
  });
  it('deduplica conversas na região entre campanhas',()=>{
    const d=fixture();d.refs.push({...d.refs[0]!,id:'r2',campaign_id:'2'});
    d.bindings.push({...d.bindings[0]!,campaign_id:'2'});d.insights.push({...d.insights[0]!,campaign_id:'2'});
    expect(geographyTotals(d,['1','2'],'sao goncalo','2026-09-01','2026-09-14',true)).toMatchObject({spend:120,conversations:1});
  });
  it('acompanha a coorte anterior mesmo quando a venda ocorre no período seguinte',()=>{
    const d=fixture();d.refs[0]!.day='2026-08-31';d.refs[0]!.captured_at='2026-08-31T12:00:00Z';
    const result=geographyTotals(d,['1'],'São Gonçalo','2026-08-01','2026-08-31',true);
    expect(result).toMatchObject({sales:0,converted:1,conversion:100});
    expect(total(d)).toMatchObject({sales:1,converted:0,conversion:null});
  });
  it.each(['shared','currency','unknown-city','other-city','expired','unbound'] as const)('não estima verba regional com %s',kind=>{
    const d=fixture();
    if(kind==='shared')d.bindings[0]!.allocation='shared';
    if(kind==='currency')d.insights[0]!.currency='USD';
    if(kind==='unknown-city')d.refs[0]!.municipality=null;
    if(kind==='other-city')d.refs.push({...d.refs[0]!,id:'r2',municipality:'Maricá'});
    if(kind==='expired')d.bindings[0]!.valid_until='2026-08-31';
    if(kind==='unbound')d.bindings=[];
    expect(total(d)).toMatchObject({spend:null,cpa:null,margin:null});
  });
  it('custo desconhecido e atribuição desligada não viram zero',()=>{
    const d=fixture();d.sales[0]!.margin=null;
    expect(total(d)).toMatchObject({sales:1,gross_margin:null,margin:null});
    expect(total(d,false)).toMatchObject({sales:null,margin:null,converted:null,conversion:null});
    d.refs=[];d.sales=[];expect(total(d)).toMatchObject({sales:null,margin:null});
  });
  it('usa a versão mais recente dentro da validade sem apagar a anterior',()=>{
    const d=fixture();d.bindings.unshift({...d.bindings[0]!,id:'2',allocation:'shared',valid_from:'2026-09-10'});
    expect(bindingAt(d,'1','2026-09-09')?.id).toBe('1');expect(bindingAt(d,'1','2026-09-10')?.id).toBe('2');
  });
  it('saldo de outra marca/condição não atende à oferta e cobertura precisa estar habilitada',()=>{
    const d=fixture(),b=d.bindings[0]!;b.offers=[{ad_id:'11',measure:'130/70-13',brand:'Pirelli',condition:'novo'}];
    d.stock=[{measure:'130/70-13',brand:'Pirelli',condition:'meia_vida',available:50},{measure:'130/70-13',brand:'IRA',condition:'novo',available:40}];
    expect(geographyAvailability(d,b).state).toBe('unavailable');
    d.stock.push({measure:'130/70-13',brand:'Pirelli',condition:'novo',available:2});
    expect(geographyAvailability(d,b).state).toBe('unknown');
    d.delivery={pickup_enabled:true,delivery_enabled:false} as GeoData['delivery'];b.coverage='pickup';
    expect(geographyAvailability(d,b)).toMatchObject({state:'available',offers:[{available:2}]});
    b.coverage='confirmed';expect(geographyAvailability(d,b).state).toBe('unknown');
  });
});
function candidate():Pick<GeoCampaign,'totals'|'previous'|'availability'|'meta'|'diagnostics'> {
  const t={...total(fixture()),sales:24,spend:720,cpa:30,margin:960,mature_conversations:90};
  return {totals:t,previous:{...t,cpa:32},availability:{state:'available',coverage:'Retirada habilitada',offers:[]},
    meta:{campaign_id:'1',status:'ACTIVE',learning:'SUCCESS',daily_budget:30,budget_entity_id:'1',budget_level:'campaign'},
    diagnostics:{current:{campaign_id:'1',frequency:2.4,link_ctr:1.8},previous:{campaign_id:'1',frequency:1.8,link_ctr:1.9}}};
}
describe('Geografia: indicações conservadoras',()=>{
  it('sugere teste somente com margem, estabilidade, estoque e aprendizado confirmados',()=>{
    expect(decideGeography(candidate(),40,true).decision).toBe('increase');
  });
  it.each(['stale','thin','learning','inactive','cost','coverage','diagnostics'] as const)('aguarda: %s',kind=>{
    const c=candidate();if(kind==='thin')c.totals.mature_conversations=3;if(kind==='learning')c.meta!.learning='LEARNING';
    if(kind==='inactive')c.meta!.status='PAUSED';if(kind==='cost')c.totals.margin=null;
    if(kind==='coverage')c.availability.state='unknown';if(kind==='diagnostics')c.diagnostics.current=null;
    expect(decideGeography(c,40,kind!=='stale').decision).toBe('wait');
  });
  it('interpreta frequência e CTR em conjunto',()=>{
    const c=candidate();c.diagnostics.current!.link_ctr=1;
    expect(decideGeography(c,40,true).decision).toBe('review');
    c.diagnostics.current!.frequency=1.8;expect(decideGeography(c,40,true).decision).toBe('increase');
  });
  it('revisa falta de saldo, custo alto e prejuízo repetido sem alterar a Meta',()=>{
    const c=candidate();c.availability.state='unavailable';expect(decideGeography(c,40,true).decision).toBe('pause_offer');
    c.availability.state='available';c.totals.cpa=50;expect(decideGeography(c,40,true).decision).toBe('review');
    c.totals.margin=-50;c.previous.margin=-20;expect(decideGeography(c,40,true).reasons[0]).toContain('dois períodos');
  });
});
