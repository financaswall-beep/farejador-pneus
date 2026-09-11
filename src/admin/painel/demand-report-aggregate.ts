import { normalizeMunicipalityKey,resolveNetworkMunicipality } from '../../network/municipality-catalog.js';
import { tireSizeKey } from '../../shared/tire-size.js';
import { reportAddDays } from './report-period.js';
import { DEMAND_UNKNOWN,type DemandEvent,type DemandCounts,type DemandMetric } from './demand-report-types.js';
export const demandCity=(name:string|null)=>{const clean=name?.trim();return clean?
  {key:normalizeMunicipalityKey(clean),name:resolveNetworkMunicipality(clean)?.name||clean}:{key:DEMAND_UNKNOWN,name:'Sem município identificado'};};
export const demandMeasureKey=(v:string)=>tireSizeKey(v)||v.trim().toUpperCase();
export const demandMeasureName=(v:string)=>{const key=demandMeasureKey(v);return /^\d+-\d+-\d+$/.test(key)?key.replace('-', '/'):v.trim().toUpperCase();};
export interface DemandConversation {city:{key:string;name:string};days:Partial<Record<DemandMetric,string>>;measures:Map<string,{measure:string;day:string}>}
export function demandConversations(events:DemandEvent[],range:{from:string;to:string}){
  const rows=new Map<string,DemandConversation>();
  for(const e of events){if(e.day<range.from||e.day>range.to)continue;
    let row=rows.get(e.conversation_id);if(!row){row={city:demandCity(e.municipality),days:{},measures:new Map()};rows.set(e.conversation_id,row);}
    const earliest=(metric:DemandMetric)=>{if(!row!.days[metric]||row!.days[metric]!>e.day)row!.days[metric]=e.day;};
    earliest('conversations');if(e.kind==='order')earliest('orders');if(e.kind==='delivery')earliest('deliveries');if(e.kind==='shortage')earliest('shortages');
    if(e.kind==='measure'&&e.measure){const key=demandMeasureKey(e.measure),old=row.measures.get(key);if(!old||old.day>e.day)row.measures.set(key,{measure:demandMeasureName(e.measure),day:e.day});}
  }return [...rows.values()];
}
export function demandCounts(rows:DemandConversation[]):DemandCounts{
  const count=(key:DemandMetric)=>rows.filter(r=>r.days[key]).length,conversations=rows.length,orders=count('orders');
  return{conversations,orders,deliveries:count('deliveries'),shortages:count('shortages'),conversion:conversations?orders/conversations*100:null};
}
export function demandDays(rows:DemandConversation[],range:{from:string;to:string},metric:DemandMetric,measure=''){
  const counts=new Map<string,number>();for(const r of rows){const day=measure?r.measures.get(measure)?.day:r.days[metric];if(day)counts.set(day,(counts.get(day)||0)+1);}
  const days=[];for(let day=range.from;day<=range.to;day=reportAddDays(day,1))days.push({day,value:counts.get(day)||0});return days;
}
