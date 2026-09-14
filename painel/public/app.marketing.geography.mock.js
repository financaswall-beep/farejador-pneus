// Somente ?mock=1. Não grava exemplos no banco nem chama a Meta.
function marketingGeographyMockPayload(period='30d',target=40){
  const total=(sales,spend,margin,conversations,converted=sales)=>({sales,spend,margin,revenue:margin==null?null:sales*200,
    gross_margin:margin==null?null:margin+spend,cpa:spend==null?null:spend/sales,conversations,converted,
    conversion:conversations?converted/conversations*100:null,mature_conversations:conversations-8,mature_converted:converted});
  const rows=[['São Gonçalo','NMAX e scooters',24,720,960,120,'increase'],['Niterói','Retirada na Matriz',12,480,360,80,'maintain'],
    ['Rio de Janeiro','Oferta meia-vida',10,600,-100,100,'review'],['Maricá','Campanha regional',3,null,null,30,'wait']];
  const records=rows.map(([region,name,sales,spend,margin,conversations,decision],i)=>({
    id:String(100+i),name,region,scope:'matrix',binding:null,totals:total(sales,spend,margin,conversations),
    previous:total(sales-2,spend==null?null:spend-40,margin==null?null:margin-50,conversations+10),
    decision,reasons:i===0?['Margem positiva, custo abaixo da meta e estabilidade entre períodos. Estoque e atendimento verificados.']:i===3?['Verba compartilhada: custo regional indisponível.']:['Acompanhar resultado e rever a oferta antes de aumentar.'],
    availability:{state:i===3?'partial':'available',coverage:'Retirada habilitada',offers:[{ad_id:String(200+i),measure:'130/70-13',brand:'Pirelli',condition:'novo',available:i===3?0:24}]},
    meta:{campaign_id:String(100+i),status:'ACTIVE',daily_budget:30,budget_entity_id:String(100+i),budget_level:'campaign',learning:'SUCCESS'},
    diagnostics:{previous:{frequency:1.8,link_ctr:1.9},current:{frequency:2.4,link_ctr:1.8}},
    budget_change:i===0?{observed_at:'2026-09-01T12:00:00Z',days:7,before:total(5,150,150,25),after:total(6,180,180,30)}:null,
    meta_url:'https://adsmanager.facebook.com/adsmanager/manage/campaigns',
  }));
  if(target<30)records[0].decision='review';
  return {available:true,state:'ready',meta_state:'ready',fresh:true,attribution_enabled:true,last_collected:'2026-09-14T12:00:00Z',
    period:{id:period,since:'2026-08-16',until:'2026-09-14',previousSince:'2026-07-17',previousUntil:'2026-08-15'},target,
    records,regions:records.map(r=>({name:r.region,totals:r.totals,previous:r.previous,campaign_ids:[r.id]})),
    catalog:records.map(r=>({id:r.id,name:r.name,scope:'matrix'})),bindings:[],offers:[{measure:'130/70-13',brand:'Pirelli',condition:'novo'}],
    ads:records.map((r,i)=>({id:String(200+i),name:r.name,campaign_id:r.id})),missing_scope:0};
}
