import type { Pool } from 'pg';
import {pool} from '../../persistence/db.js';
import {env} from '../../shared/config/env.js';
import {marketingDateWindow,type MarketingPeriod} from './marketing-meta.js';
import {marketingCreativeConfig} from './queries-marketing-creatives.js';
import {getGeographyMeta,type MetaGeographyResult} from '../../marketing/geography-meta.js';
import {loadGeographyData,type GeoData} from './geography-data.js';
import {bindingAt,decideGeography,geographyAvailability,geographyTotals} from '../../marketing/geography-rules.js';
import {dayOf,geoKey,shiftDay,type GeoCampaign} from '../../marketing/geography-types.js';

export function buildGeography(data:GeoData,window:ReturnType<typeof marketingDateWindow>,meta:MetaGeographyResult,enabled:boolean,target:number,account:string,now:Date) {
  const records:GeoCampaign[]=[];
  const freshness=data.insights.map(r=>r.collected_at).sort().at(-1)??null;
  const fresh=!!freshness && now.getTime()-Date.parse(freshness)<48*3600000;
  const regionNames=new Map<string,string>();
  for(const campaign of data.catalog.filter(c=>c.scope==='matrix')) {
    if(!data.insights.some(i=>i.campaign_id===campaign.id&&i.day>=window.since)&&!data.sales.some(s=>s.campaign_id===campaign.id&&s.day>=window.since)&&!data.refs.some(r=>r.campaign_id===campaign.id&&r.day>=window.since))continue;
    const bindings=data.bindings.filter(b=>b.campaign_id===campaign.id&&b.valid_from<=window.until&&b.valid_until>=window.since);
    const names=[...data.refs.filter(r=>r.campaign_id===campaign.id&&r.day>=window.since).map(r=>r.municipality||'Sem município'),
      ...data.sales.filter(r=>r.campaign_id===campaign.id&&r.day>=window.since).map(r=>r.municipality||'Sem município'),
      ...bindings.map(b=>b.municipality).filter((n):n is string=>!!n)];
    if(!names.length)names.push('Sem município');
    for(const name of new Map(names.map(n=>[geoKey(n),n])).values()) {
      const region=regionNames.get(geoKey(name))??name;regionNames.set(geoKey(name),region);
      const binding=bindingAt(data,campaign.id,window.until);
      const current=geographyTotals(data,[campaign.id],region,window.since,window.until,enabled);
      const previous=geographyTotals(data,[campaign.id],region,window.previousSince,window.previousUntil,enabled);
      const availability=geographyAvailability(data,binding);
      const advertised=data.ads.filter(a=>a.campaign_id===campaign.id&&a.last_spend_day!=null&&a.last_spend_day>=window.since&&a.last_spend_day<=window.until);
      if(availability.state==='available'&&(!advertised.length||advertised.some(a=>!binding?.offers.some(o=>o.ad_id===a.id)))) {
        availability.state='unknown';availability.coverage='Há anúncios do período com ofertas ainda não verificadas';
      }
      const record:GeoCampaign={id:campaign.id,name:campaign.name||campaign.id,scope:campaign.scope,region,binding,
        totals:current,previous,availability,decision:'wait',reasons:[],
        meta:meta.campaigns.find(r=>r.campaign_id===campaign.id)??null,
        diagnostics:{current:meta.current.find(r=>r.campaign_id===campaign.id)??null,previous:meta.previous.find(r=>r.campaign_id===campaign.id)??null},
        budget_change:null,meta_url:`https://adsmanager.facebook.com/adsmanager/manage/campaigns?${new URLSearchParams({act:account.replace(/^act_/,''),selected_campaign_ids:campaign.id})}`};
      const history=data.snapshots.filter(s=>s.campaign_id===campaign.id).sort((a,b)=>a.observed_at.localeCompare(b.observed_at));
      for(let i=1;i<history.length;i++) {
        const before=history[i-1]!,after=history[i]!;
        if(before.payload.daily_budget==null||after.payload.daily_budget==null||before.payload.daily_budget>=after.payload.daily_budget
          ||before.payload.budget_entity_id!==after.payload.budget_entity_id)continue;
        const day=dayOf(after.observed_at),end=shiftDay(day,7);
        if(end>=window.until)continue;
        const days=new Set(data.insights.filter(r=>r.campaign_id===campaign.id).map(r=>r.day));
        if(Array.from({length:7},(_,n)=>n+1).some(n=>!days.has(shiftDay(day,-n))||!days.has(shiftDay(day,n))))continue;
        // O dia da observação é excluído; nenhuma data exata de edição é inferida.
        record.budget_change={observed_at:after.observed_at,days:7,
          before:geographyTotals(data,[campaign.id],region,shiftDay(day,-7),shiftDay(day,-1),enabled),
          after:geographyTotals(data,[campaign.id],region,shiftDay(day,1),end,enabled)};
      }
      const collected=data.insights.filter(i=>i.campaign_id===campaign.id).map(i=>i.collected_at).sort().at(-1);
      const campaignFresh=!!collected&&now.getTime()-Date.parse(collected)<48*3600000;
      Object.assign(record,decideGeography(record,target,campaignFresh));records.push(record);
    }
  }
  const regions=[...new Map(records.map(r=>[geoKey(r.region),r.region])).values()].map(name=>{
    const campaigns=records.filter(r=>geoKey(r.region)===geoKey(name));
    const ids=campaigns.map(r=>r.id);
    return {name,campaign_ids:ids,totals:geographyTotals(data,ids,name,window.since,window.until,enabled),
      previous:geographyTotals(data,ids,name,window.previousSince,window.previousUntil,enabled)};
  });
  return {records,regions,fresh,last_collected:freshness};
}
export async function getMarketingGeography(period:MarketingPeriod='30d',target=40,deps:{db?:Pool;now?:Date;metaProvider?:typeof getGeographyMeta}={}) {
  const db=deps.db??pool,now=deps.now??new Date(),window=marketingDateWindow(period,now),config=marketingCreativeConfig();
  const account=config?.adAccountId??env.META_ADS_ACCOUNT_ID;
  const base={environment:env.FAREJADOR_ENV,generated_at:now.toISOString(),period:{id:period,...window},target,
    attribution_enabled:env.MARKETING_ATTRIBUTION};
  if(!account)return {...base,available:false,state:'not_configured',records:[],catalog:[],ads:[],offers:[]};
  const data=await loadGeographyData(db,env.FAREJADOR_ENV,account,shiftDay(window.previousSince,-30),window.until,now);
  const meta=config?await(deps.metaProvider??getGeographyMeta)(config,window):{state:'unavailable',campaigns:[],current:[],previous:[]} as MetaGeographyResult;
  const built=buildGeography(data,window,meta,env.MARKETING_ATTRIBUTION,target,account,now);
  return {...base,available:true,state:'ready',meta_state:meta.state,...built,
    catalog:data.catalog,ads:data.ads,offers:data.offers,bindings:data.bindings.filter((b,i,a)=>a.findIndex(v=>v.campaign_id===b.campaign_id)===i),
    missing_scope:data.catalog.filter(c=>c.scope==='pending').length};
}
