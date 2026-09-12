import { tireSizeKey } from '../../shared/tire-size.js';
import { readShortageSnapshot } from './shortage-report-data.js';
import { shortageOpportunities,shortagePotential,shortageReference } from './shortage-report-potential.js';
import type { ShortageSnapshot,ShortageTrace } from './shortage-report-types.js';
import type { ShortageReportFilter } from './shortage-report-filter.js';
const countConversations=(rows:ShortageTrace[])=>new Set(rows.map(t=>t.conversation_id)).size;
const conversationMeasure=(t:ShortageTrace)=>t.conversation_id+'|'+tireSizeKey(t.measure);
export function buildShortageReport(data:ShortageSnapshot,f:ShortageReportFilter){
  const traces=data.traces.filter(t=>t.stores.some(s=>s.available===false));
  const stores=new Map<string,{id:string;name:string;city:string|null;shortages:number;consultations:number}>();
  const seen=new Set<string>();
  for(const t of traces)for(const s of t.stores.filter(s=>s.available===false)){
    const key=s.id+'|'+conversationMeasure(t);if(seen.has(key))continue;seen.add(key);
    const old=stores.get(s.id);if(old)old.shortages++;else stores.set(s.id,{id:s.id,name:s.name,city:data.cities.find(c=>c.id===s.id)?.city||null,shortages:1,consultations:0});
  }
  const list=[...stores.values()].sort((a,b)=>b.shortages-a.shortages||a.name.localeCompare(b.name,'pt-BR'));
  for(const s of list)s.consultations=countConversations(traces.filter(t=>t.stores.some(x=>x.id===s.id&&x.available===false)));
  const selected=f.store?list.find(s=>s.id===f.store)||null:list[0]||null;
  const rows=selected?traces.filter(t=>t.stores.some(s=>s.id===selected.id&&s.available===false)):[];
  const productsByMeasure=new Map<string,typeof data.products>();
  for(const p of data.products){const key=tireSizeKey(p.measure),items=productsByMeasure.get(key)||[];items.push(p);productsByMeasure.set(key,items);}
  const opportunities=shortageOpportunities(rows,selected?.id||'',data.products);
  const searches=new Map<string,number>();
  for(const t of rows){const key=conversationMeasure(t);searches.set(key,(searches.get(key)||0)+1);}
  const grouped=new Map<string,ShortageTrace[]>();
  for(const t of rows){const key=tireSizeKey(t.measure),items=grouped.get(key)||[];items.push(t);grouped.set(key,items);}
  const allMeasures=[...grouped].map(([key,items])=>{
    const stock=data.stock.filter(s=>s.store_id===selected!.id&&tireSizeKey(s.measure)===key);
    return{key,measure:items[0]!.measure,shortages:countConversations(items),
      stock:!stock.length||stock.some(s=>s.unknown)?null:stock.reduce((n,s)=>n+s.available,0),
      potential:shortagePotential(opportunities.filter(o=>tireSizeKey(o.measure)===key))};
  }).sort((a,b)=>b.shortages-a.shortages||a.measure.localeCompare(b.measure));
  const query=f.search.replace(/[^a-z0-9]/gi,'').toLowerCase();
  const measures=allMeasures.filter(m=>!query||m.measure.replace(/[^a-z0-9]/gi,'').toLowerCase().includes(query));
  const measure=f.measure?measures.find(m=>m.key===tireSizeKey(f.measure))||null:measures[0]||null;
  const selectedRows=rows.filter(t=>f.view==='consultations'&&!f.measure?measures.some(m=>m.key===tireSizeKey(t.measure)):measure?.key===tireSizeKey(t.measure));
  const consultations=selectedRows.map(({conversation_id,search_key:_,...t})=>({...t,measure_key:tireSizeKey(t.measure),
    searches:searches.get(conversation_id+'|'+tireSizeKey(t.measure))||1,
    available_elsewhere:t.stores.some(s=>s.available===true),reference:shortageReference(t,selected!.id,productsByMeasure.get(tireSizeKey(t.measure))||[])}));
  return{filters:{...f,store:selected?.id||f.store},as_of:data.as_of,tracking_since:data.tracking_since,legacy_records:data.legacy_records,
    summary:{consultations:countConversations(traces),shortages:list.reduce((n,s)=>n+s.shortages,0),stores:list.length,measures:new Set(traces.map(t=>tireSizeKey(t.measure))).size},
    stores:list,store:selected?{...selected,potential:shortagePotential(opportunities)}:null,measures,selected_measure:measure,consultations,
    opportunities:opportunities.filter(o=>measures.some(m=>m.key===tireSizeKey(o.measure))&&(!f.measure||tireSizeKey(o.measure)===tireSizeKey(f.measure)))};
}
export async function getShortageReport(f:ShortageReportFilter){return buildShortageReport(await readShortageSnapshot(f),f);}
