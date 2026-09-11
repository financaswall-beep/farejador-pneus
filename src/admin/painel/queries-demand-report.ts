import { demandComparison,type DemandReportFilter } from './demand-report-filter.js';
import { demandCity,demandMeasureKey,demandMeasureName,demandConversations,demandCounts,demandDays,type DemandConversation } from './demand-report-aggregate.js';
import { readDemandSnapshot } from './demand-report-data.js';
import { DEMAND_UNKNOWN,type DemandSnapshot,type DemandCity,type DemandMeasure } from './demand-report-types.js';
export function buildDemandReport(data:DemandSnapshot,f:DemandReportFilter){
  const comparison=demandComparison(f),current=demandConversations(data.current,f),previous=comparison?demandConversations(data.previous,comparison):[];
  const cityKey=f.city===DEMAND_UNKNOWN?f.city:f.city?demandCity(f.city).key:'';
  const scope=current.filter(r=>!cityKey||r.city.key===cityKey),prior=previous.filter(r=>!cityKey||r.city.key===cityKey);
  const groupCities=(rows:DemandConversation[])=>{const groups=new Map<string,DemandConversation[]>();for(const r of rows){const group=groups.get(r.city.key)||[];group.push(r);groups.set(r.city.key,group);}return groups;};
  const byCity=groupCities(current),previousByCity=groupCities(previous);
  const cityMap=new Map([...previous,...current].map(r=>[r.city.key,r.city.name]));
  const cityOptions=[...cityMap].map(([key,name]):DemandCity=>({key,name,...demandCounts(byCity.get(key)||[]),
    previous:comparison?demandCounts(previousByCity.get(key)||[]):null})).sort((a,b)=>b.conversations-a.conversations||a.name.localeCompare(b.name,'pt-BR'));
  const normalized=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const cities=cityOptions.filter(c=>normalized(c.name).includes(normalized(f.citySearch))).sort((a,b)=>
    f.sort==='name'?a.name.localeCompare(b.name,'pt-BR'):(b[f.sort]??-1)-(a[f.sort]??-1)||a.name.localeCompare(b.name,'pt-BR'));
  const stock=new Map<string,number>();for(const s of data.stock){const key=demandMeasureKey(s.measure);stock.set(key,(stock.get(key)||0)+s.quantity);}
  const measuresMap=new Map<string,DemandMeasure>();for(const r of scope)for(const [key,item] of r.measures){const old=measuresMap.get(key);
    if(old)old.consultations++;else measuresMap.set(key,{key,measure:demandMeasureName(item.measure),consultations:1,stock:stock.get(key)??null});}
  const measures=[...measuresMap.values()].filter(m=>normalized(m.measure).includes(normalized(f.search))).sort((a,b)=>b.consultations-a.consultations||a.measure.localeCompare(b.measure));
  const selected=f.measure?measures.find(m=>m.key===demandMeasureKey(f.measure))||null:measures[0]||null;
  const measureCities=selected?cityOptions.map(c=>({key:c.key,name:c.name,consultations:(byCity.get(c.key)||[]).filter(r=>r.measures.has(selected.key)).length})).filter(c=>c.consultations>0).sort((a,b)=>b.consultations-a.consultations):[];
  const makeSeries=(measure='')=>{const now=demandDays(scope,f,f.metric,measure),old=comparison?demandDays(prior,comparison,f.metric,measure):[];
    const result=[],size=f.grain==='week'?7:1;for(let i=0;i<now.length;i+=size){const batch=now.slice(i,i+size),prev=old.slice(i,i+size);
      result.push({from:batch[0]!.day,to:batch.at(-1)!.day,current:batch.reduce((n,r)=>n+r.value,0),previous:comparison?prev.reduce((n,r)=>n+r.value,0):null,
        previous_from:prev[0]?.day||null,previous_to:prev.at(-1)?.day||null});}return result;};
  return{filters:{...f,city:cityKey},as_of:data.as_of,comparison,summary:{...demandCounts(current),municipalities:cityOptions.filter(c=>c.key!==DEMAND_UNKNOWN&&c.conversations>0).length,
    unidentified:current.filter(r=>r.city.key===DEMAND_UNKNOWN).length},scope:demandCounts(scope),previous:comparison?demandCounts(prior):null,
    city_name:cityKey?cityMap.get(cityKey)||'Município sem registros':'Todos os municípios',city_options:cityOptions,cities,measures,selected_measure:selected,measure_cities:measureCities,
    measures_summary:{measures:measures.length,consultations:measures.reduce((n,m)=>n+m.consultations,0),out_of_stock:measures.filter(m=>m.stock===0).length},
    series:makeSeries(),measure_series:selected?makeSeries(selected.key):[]};
}
export async function getDemandReport(f:DemandReportFilter){return buildDemandReport(await readDemandSnapshot(f),f);}
