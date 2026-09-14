import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {describe,it,expect,beforeAll,vi} from 'vitest';
let buildGeography:typeof import('../../../src/admin/painel/queries-marketing-geography.js').buildGeography;
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgresql://a:b@example.test/db',CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test'});
  ({buildGeography}=await import('../../../src/admin/painel/queries-marketing-geography.js'));
});
function front(){
  const sandbox=vm.createContext({window:{PAINEL_MODULES:{}},URLSearchParams,location:{search:''},document:{},setTimeout,crypto:{randomUUID:()=> 'request-test'}});
  for(const file of ['app.marketing.geography.js','app.marketing.geography.actions.js','app.marketing.geography.mock.js'])vm.runInContext(readFileSync('painel/public/'+file,'utf8'),sandbox);
  const app=Object.assign(sandbox.window.PAINEL_MODULES.marketingGeography(),sandbox.window.PAINEL_MODULES.marketingGeographyActions(),{
    $nextTick:()=>{},marketingPeriod:'30d',marketingIsMock:()=>false,formatCurrency:(v:number)=>String(v),$refs:{},
  });
  app.mgData=sandbox.marketingGeographyMockPayload('30d',40);app.mgReconcile();return app;
}
describe('Geografia: seleção, filtro e rascunhos',()=>{
  it('prioriza oportunidades e mantém seleção coerente com a campanha e a região',()=>{
    const a=front();expect(a.mgSelected).toBe('São Gonçalo');expect(a.mgCanPlan()).toBe(true);
    a.mgSearch='Niterói';a.mgFiltersChanged();expect(a.mgSelected).toBe('Niterói');expect(a.mgCanPlan()).toBe(false);
    a.mgSearch='inexistente';a.mgFiltersChanged();expect(a.mgSelectedRecord()).toBeNull();
  });
  it('usa o agregado do servidor sem somar conversas repetidas entre campanhas',()=>{
    const a=front();const first=a.mgData.records[0];a.mgData.records.push({...first,id:'another'});
    expect(a.mgRegions().find((r:any)=>r.name===first.region).totals.conversations).toBe(120);
  });
  it('não deixa o carregamento antigo substituir o período novo',async()=>{
    const a=front(),resolve:any[]=[];a.apiGet=()=>new Promise(r=>resolve.push(r));
    const old=a.loadMarketingGeography();a.marketingPeriod='7d';const latest=a.loadMarketingGeography();
    resolve[1]({records:[],regions:[],catalog:[],marker:'new'});await latest;resolve[0]({marker:'old'});await old;
    expect(a.mgData.marker).toBe('new');expect(a.mgLoading).toBe(false);
  });
  it('meta inválida interrompe a tela de carregamento e um erro não vira dados vazios',async()=>{
    const a=front();a.mgLoading=true;a.mgTarget=0;await a.loadMarketingGeography();expect(a.mgLoading).toBe(false);expect(a.mgData).toBeNull();
    a.mgTarget=40;a.apiGet=async()=>{throw Error('offline');};await a.loadMarketingGeography();expect(a.mgError).toContain('Não foi possível');
  });
  it('congela a campanha no plano e envia apenas um rascunho ao Farejador',async()=>{
    const a=front();a.mgOpenPlan();const id=a.mgPlanCampaign.id;a.mgSelectedCampaign='different';
    a.apiPost=vi.fn().mockResolvedValue({id:'plan',payload:{}});await a.mgSavePlan();
    expect(a.apiPost).toHaveBeenCalledWith(`/admin/api/marketing/geography/${id}/plans`,expect.objectContaining({percent:10,days:7,region:'São Gonçalo'}));
    await a.mgSavePlan();expect(a.apiPost).toHaveBeenCalledTimes(1);
  });
  it('prévia ilustrativa nunca grava vínculos ou planos',async()=>{
    const a=front();a.marketingIsMock=()=>true;a.apiPost=vi.fn();a.mgOpenPlan();await a.mgSavePlan();
    expect(a.apiPost).not.toHaveBeenCalled();expect(a.mgPlanError).toContain('ilustrativa');
  });
});
describe('Geografia: agregação por campanha',()=>{
  const window={since:'2026-09-01',until:'2026-09-14',previousSince:'2026-08-18',previousUntil:'2026-08-31'};
  it('não trata a oferta de um anúncio como estoque confirmado da campanha inteira',()=>{
    const offer={ad_id:'11',measure:'130/70-13',brand:'Pirelli',condition:'novo'};
    const data:any={catalog:[{id:'1',name:'A',scope:'matrix'}],refs:[],sales:[],offers:[],snapshots:[],
      delivery:{pickup_enabled:true},stock:[{...offer,available:5}],
      bindings:[{id:'1',campaign_id:'1',allocation:'dedicated',municipality:'São Gonçalo',valid_from:'2026-09-01',valid_until:'2026-09-30',coverage:'pickup',offers:[offer]}],
      ads:[{id:'11',campaign_id:'1',last_spend_day:'2026-09-05'},{id:'12',campaign_id:'1',last_spend_day:'2026-09-05'}],
      insights:[{campaign_id:'1',day:'2026-09-05',spend:30,currency:'BRL',collected_at:'2026-09-14T12:00:00Z'}]};
    const result=buildGeography(data,window,{state:'unavailable',campaigns:[],current:[],previous:[]},true,40,'act_1',new Date('2026-09-14T12:00:00Z'));
    expect(result.records[0]!.availability.state).toBe('unknown');
    expect(result.records[0]!.availability.coverage).toContain('ofertas ainda não verificadas');
  });
  it('não mistura campanhas externas e não duplica municípios com variação de nome',()=>{
    const data:any={catalog:[{id:'1',name:'A',scope:'matrix'},{id:'2',name:'B',scope:'matrix'},{id:'3',name:'C',scope:'external'}],refs:[],sales:[],bindings:[],stock:[],snapshots:[],ads:[],offers:[],delivery:null,
      insights:['1','2','3'].map(id=>({campaign_id:id,day:'2026-09-05',spend:30,currency:'BRL',collected_at:'2026-09-14T12:00:00Z'}))};
    data.refs=[{campaign_id:'1',conversation_id:'c1',id:'r1',day:'2026-09-05',municipality:'São Gonçalo'},
      {campaign_id:'2',conversation_id:'c1',id:'r2',day:'2026-09-05',municipality:'sao goncalo'}];
    const r=buildGeography(data,window,{state:'unavailable',campaigns:[],current:[],previous:[]},true,40,'act_1',new Date('2026-09-14T12:00:00Z'));
    expect(r.records).toHaveLength(2);expect(r.regions).toHaveLength(1);expect(r.regions[0]!.totals.conversations).toBe(1);
    expect(r.records.every(c=>c.decision==='wait')).toBe(true);
  });
  it('não compara orçamento sem os sete dias de investimento em cada lado',()=>{
    const payload={campaign_id:'1',daily_budget:30,budget_entity_id:'1'};
    const data:any={catalog:[{id:'1',name:'A',scope:'matrix'}],refs:[],sales:[],bindings:[],stock:[],ads:[],offers:[],delivery:null,
      snapshots:[{campaign_id:'1',observed_at:'2026-08-31T12:00:00Z',payload},{campaign_id:'1',observed_at:'2026-09-01T12:00:00Z',payload:{...payload,daily_budget:33}}],
      insights:[{campaign_id:'1',day:'2026-09-05',spend:30,currency:'BRL',collected_at:'2026-09-14T12:00:00Z'}]};
    expect(buildGeography(data,window,{state:'unavailable',campaigns:[],current:[],previous:[]},true,40,'act_1',new Date('2026-09-14T12:00:00Z')).records[0]!.budget_change).toBeNull();
  });
});
