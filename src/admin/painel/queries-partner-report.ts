import { readPartnerSnapshot } from './partner-report-data.js';
import type { PartnerSnapshot } from './partner-report-types.js';
import type { PartnerReportFilter } from './partner-report-filter.js';
import { reportAddDays,reportComparison } from './report-period.js';
import { resolveNetworkMunicipality } from '../../network/municipality-catalog.js';
const money=(n:number)=>Math.round(n*100)/100;
const sum=<T>(rows:T[],value:(row:T)=>number)=>rows.reduce((total,row)=>total+Math.round(value(row)*100),0)/100;
const inside=(day:string|null,from:string,to:string)=>!!day&&day>=from&&day<=to;
export const partnerReportChannel=(source:string|null)=>source==='2w'?'farejador':!source||['porta','walkin_balcao','walkin_telefone','walkin_outro','outro'].includes(source)?'direct':'other';
export function buildPartnerReport(data:PartnerSnapshot,f:PartnerReportFilter){
  const comparison=reportComparison(f),cityName=(value:string|null)=>value?(resolveNetworkMunicipality(value)?.name||value.trim()):'Sem município cadastrado';
  const allUnits=data.units.map(u=>({...u,city:cityName(u.city)}));
  const cityOptions=[...new Set(allUnits.map(u=>u.city))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  const units=allUnits.filter(u=>!f.city||u.city===f.city),unitMap=new Map(units.map(u=>[u.unit_id,u]));
  const saleBase=data.sales.filter(s=>unitMap.has(s.unit_id)).map(s=>({...s,partner_id:unitMap.get(s.unit_id)!.partner_id,unit_name:unitMap.get(s.unit_id)!.name,channel:partnerReportChannel(s.source)}));
  const commissionBase=data.commissions.filter(c=>unitMap.get(c.unit_id)?.partner_id===c.partner_id).map(c=>({...c,unit_name:unitMap.get(c.unit_id)!.name}));
  const current=saleBase.filter(s=>inside(s.day,f.from,f.to)),previous=comparison?saleBase.filter(s=>inside(s.day,comparison.from,comparison.to)):[];
  const generated=commissionBase.filter(c=>inside(c.day,f.from,f.to));
  const partnerIds=[...new Set(units.map(u=>u.partner_id))];
  let partners=partnerIds.map(id=>{
    const stores=units.filter(u=>u.partner_id===id),sales=current.filter(s=>s.partner_id===id),prior=previous.filter(s=>s.partner_id===id),entries=commissionBase.filter(c=>c.partner_id===id),cohort=generated.filter(c=>c.partner_id===id);
    const archived=stores.every(u=>u.archived),live=stores.filter(u=>!u.archived),status=archived?'archived':live.some(u=>u.status==='active')?'active':live[0]?.status||stores[0]!.status;
    const revenue=sum(sales,s=>s.total),past=sum(prior,s=>s.total),commission=(rows:typeof entries)=>data.commission_enabled?sum(rows,c=>c.amount):null;
    return{id,name:stores.length===1?stores[0]!.name:stores[0]!.partner_name,units:stores,city:[...new Set(stores.map(u=>u.city))].join(' · '),status,archived,
      sales:revenue,orders:sales.length,previous:comparison?past:null,delta:comparison&&past>0?money((revenue-past)/past*100):null,ticket:sales.length?money(revenue/sales.length):null,
      farejador:sum(sales.filter(s=>s.channel==='farejador'),s=>s.total),direct:sum(sales.filter(s=>s.channel==='direct'),s=>s.total),other:sum(sales.filter(s=>s.channel==='other'),s=>s.total),
      generated:commission(cohort),cohort_received:commission(cohort.filter(c=>!!c.settled_on)),cohort_reversed:commission(cohort.filter(c=>c.status==='reversed')),
      received:commission(entries.filter(c=>inside(c.settled_on,f.from,f.to))),reversed:commission(entries.filter(c=>inside(c.reversed_on,f.from,f.to))),
      open:commission(entries.filter(c=>c.status==='open')),refund:data.commission_enabled?sum(entries.filter(c=>c.refund_status==='pending'),c=>c.refund_amount):null,
      undated:saleBase.filter(s=>s.partner_id===id&&!s.day).length,history:sales.length+prior.length+entries.length,
      unlinked:data.commission_enabled?sales.filter(s=>s.channel==='farejador'&&!s.commission_id).length:0};
  }).filter(p=>(!p.archived||p.history>0)&&(f.status==='all'||p.status===f.status));
  const search=f.search.toLocaleLowerCase('pt-BR');
  partners=partners.filter(p=>(!search||(p.name+' '+p.city).toLocaleLowerCase('pt-BR').includes(search))&&(f.activity==='all'||(f.activity==='selling'?p.orders>0:p.orders===0)));
  partners.sort((a,b)=>f.sort==='name'?a.name.localeCompare(b.name,'pt-BR'):Number(b[f.sort==='commission'?'generated':f.sort]||0)-Number(a[f.sort==='commission'?'generated':f.sort]||0)||a.name.localeCompare(b.name,'pt-BR'));
  const ids=new Set(partners.map(p=>p.id)),sales=current.filter(s=>ids.has(s.partner_id)),commissions=commissionBase.filter(c=>ids.has(c.partner_id));
  const total=sum(partners,p=>p.sales),old=sum(partners,p=>p.previous||0),partnerMap=new Map(partners.map(p=>[p.id,p]));
  const summary={sales:total,orders:sales.length,partners:partners.length,selling:partners.filter(p=>p.orders>0).length,idle:partners.filter(p=>p.orders===0).length,
    delta:comparison&&old>0?money((total-old)/old*100):null,previous:comparison?old:null,generated:data.commission_enabled?sum(partners,p=>p.generated||0):null,
    received:data.commission_enabled?sum(partners,p=>p.received||0):null,reversed:data.commission_enabled?sum(partners,p=>p.reversed||0):null,
    open:data.commission_enabled?sum(partners,p=>p.open||0):null,refund:data.commission_enabled?sum(partners,p=>p.refund||0):null,undated:sum(partners,p=>p.undated),unlinked:sum(partners,p=>p.unlinked)};
  let index=0;const daily=[];
  for(let day=f.from;day<=f.to;day=reportAddDays(day,1),index++){
    const oldDay=comparison?reportAddDays(comparison.from,index):null;
    daily.push({day,sales:sum(sales.filter(s=>s.day===day),s=>s.total),previous:oldDay&&oldDay<=comparison!.to?sum(previous.filter(s=>ids.has(s.partner_id)&&s.day===oldDay),s=>s.total):null});
  }
  const salesRows=sales.filter(s=>(!f.partner||s.partner_id===f.partner)&&(f.channel==='all'||s.channel===f.channel)).map(s=>({...s,partner_name:partnerMap.get(s.partner_id)!.name,
    commission:data.commission_enabled?commissions.find(c=>c.id===s.commission_id)?.amount??null:null})).sort((a,b)=>b.day!.localeCompare(a.day!)||a.id.localeCompare(b.id));
  const commissionRows=commissions.filter(c=>(!f.partner||c.partner_id===f.partner)&&(f.commission_scope==='open'?c.status==='open':f.commission_scope==='refund'?c.refund_status==='pending':
    inside(f.commission_scope==='received'?c.settled_on:f.commission_scope==='reversed'?c.reversed_on:c.day,f.from,f.to))).map(c=>({...c,partner_name:partnerMap.get(c.partner_id)!.name}));
  commissionRows.sort((a,b)=>b.day.localeCompare(a.day)||a.id.localeCompare(b.id));
  return{filters:f,comparison,as_of:data.as_of,today:data.today,commission_enabled:data.commission_enabled,cities:cityOptions,summary,daily,
    partners:partners.map(p=>({...p,share:total>0?money(p.sales/total*100):null})),sales:salesRows,commissions:commissionRows};
}
export async function getPartnerReport(f:PartnerReportFilter){return buildPartnerReport(await readPartnerSnapshot(f),f);}
