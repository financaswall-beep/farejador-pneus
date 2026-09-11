import { readFinancialSnapshot } from './financial-report-data.js';
import type { FinancialSnapshot } from './financial-report-types.js';
import type { FinancialReportFilter } from './financial-report-filter.js';
import { reportAddDays } from './report-period.js';
import { financialOrigin,financialResult,financialDays,financialDue,financialDueMatches,financialMoney as money,financialSum as sum } from './financial-report-calculations.js';

export function buildFinancialReport(data:FinancialSnapshot,filter:FinancialReportFilter){
  const originMatches=(origin:string)=>filter.origin==='all'||origin===filter.origin;
  const rows=data.movements.map(row=>({...row,origin:financialOrigin(row.source_type),result:financialResult(row)})).filter(row=>originMatches(row.origin));
  const competence=rows.filter(row=>row.competence_on>=filter.from&&row.competence_on<=filter.to&&(row.revenue||row.cost||row.expense||row.gain||row.loss));
  const cash=rows.filter(row=>row.cash_on&&row.cash_on>=filter.from&&row.cash_on<=filter.to&&(row.cash_in||row.cash_out));
  const pending=data.pending_cost.filter(()=>originMatches('varejo'));
  const opening=sum(data.opening.filter(row=>originMatches(financialOrigin(row.source_type))),row=>row.amount);
  const revenue=sum(competence,r=>r.revenue),cost=sum(competence,r=>r.cost),expense=sum(competence,r=>r.expense),gain=sum(competence,r=>r.gain),loss=sum(competence,r=>r.loss);
  const pendingRevenue=sum(pending,r=>r.amount),result=money(revenue-pendingRevenue-cost-expense-loss+gain);
  const incoming=sum(cash,r=>r.cash_in),outgoing=sum(cash,r=>r.cash_out);
  let cumulative=0;
  const daily=financialDays(filter.from,filter.to).map(day=>{
    const items=competence.filter(r=>r.competence_on===day),payments=cash.filter(r=>r.cash_on===day);
    const value=money(sum(items,r=>r.result)-sum(pending.filter(r=>r.day===day),r=>r.amount));cumulative=money(cumulative+value);
    return{day,result:value,cumulative,cash_in:sum(payments,r=>r.cash_in),cash_out:sum(payments,r=>r.cash_out)};
  });
  const origins=[...new Set(competence.map(row=>row.origin))].map(origin=>{
    const items=competence.filter(row=>row.origin===origin),unpriced=origin==='varejo'?pendingRevenue:0;
    return{origin,revenue:sum(items,r=>r.revenue),cost:sum(items,r=>r.cost),expense:sum(items,r=>r.expense+r.loss),
      gain:sum(items,r=>r.gain),pending_revenue:unpriced,result:money(sum(items,r=>r.result)-unpriced)};
  });
  const expenses=[...new Set(competence.filter(r=>r.expense||r.loss).map(r=>r.category||r.origin))].map(category=>({category,
    amount:sum(competence.filter(r=>(r.category||r.origin)===category),r=>r.expense+r.loss)})).sort((a,b)=>b.amount-a.amount||a.category.localeCompare(b.category));
  const titleBase=data.titles.filter(row=>originMatches(row.origin)).map(row=>({...row,status:financialDue(row,data.today)}));
  const search=filter.search.toLocaleLowerCase('pt-BR'),searchMatches=(text:string)=>!search||text.toLocaleLowerCase('pt-BR').includes(search);
  const titles=titleBase.filter(row=>(filter.title_side==='all'||row.side===filter.title_side)&&financialDueMatches(row,filter.due,data.today)
    &&searchMatches(row.name+' '+row.source_id+' '+(row.category||'')))
    .sort((a,b)=>Number(!a.due_on)-Number(!b.due_on)||(a.due_on||'').localeCompare(b.due_on||'')||a.id.localeCompare(b.id));
  const agenda=[...titleBase].sort((a,b)=>Number(!a.due_on)-Number(!b.due_on)||(a.due_on||'').localeCompare(b.due_on||'')||a.id.localeCompare(b.id));
  const titleAmount=(side:string,condition=(r:typeof titleBase[number])=>true)=>sum(titleBase.filter(r=>r.side===side&&condition(r)),r=>r.amount);
  const position={receivable:titleAmount('receivable'),payable:titleAmount('payable'),overdue_receivable:titleAmount('receivable',r=>r.status==='overdue'),
    overdue_payable:titleAmount('payable',r=>r.status==='overdue'),undated_receivable:titleAmount('receivable',r=>!r.due_on),undated_payable:titleAmount('payable',r=>!r.due_on),
    next7_receivable:titleAmount('receivable',r=>financialDueMatches(r,'next7',data.today)),next7_payable:titleAmount('payable',r=>financialDueMatches(r,'next7',data.today))};
  const forecastEnd=reportAddDays(data.today,filter.horizon-1);
  const projected=titleBase.filter(row=>row.due_on&&row.due_on>=data.today&&row.due_on<=forecastEnd);
  const forecast=financialDays(data.today,forecastEnd).map(day=>({day,cash_in:sum(projected.filter(r=>r.due_on===day&&r.side==='receivable'),r=>r.amount),
    cash_out:sum(projected.filter(r=>r.due_on===day&&r.side==='payable'),r=>r.amount)}));
  const movementMatches=(row:typeof rows[number])=>searchMatches(row.description+' '+(row.reference||row.source_id)+' '+(row.party||'')+' '+(row.category||row.origin));
  const resultRows=competence.filter(row=>movementMatches(row)&&(filter.result_kind==='all'||filter.result_kind==='revenue'&&row.revenue!==0
    ||filter.result_kind==='cost'&&row.cost!==0||filter.result_kind==='expense'&&(row.expense!==0||row.loss!==0)||filter.result_kind==='adjustment'&&(row.gain!==0||row.loss!==0)))
    .sort((a,b)=>b.competence_on.localeCompare(a.competence_on)||b.id.localeCompare(a.id));
  const cashRows=cash.filter(row=>(!filter.cash_day||row.cash_on===filter.cash_day)&&(filter.direction==='all'||filter.direction==='in'&&row.cash_in>0||filter.direction==='out'&&row.cash_out>0)&&movementMatches(row))
    .sort((a,b)=>b.cash_on!.localeCompare(a.cash_on!)||b.id.localeCompare(a.id));
  const projectedRows=projected.filter(row=>(filter.direction==='all'||filter.direction==='in'&&row.side==='receivable'||filter.direction==='out'&&row.side==='payable')
    &&searchMatches(row.name+' '+row.source_id)).sort((a,b)=>a.due_on!.localeCompare(b.due_on!)||a.id.localeCompare(b.id));
  return{filters:filter,as_of:data.as_of,today:data.today,integration_status:data.integration_status,
    summary:{revenue,cost,expense,inventory_gain:gain,inventory_loss:loss,pending_revenue:pendingRevenue,pending_items:sum(pending,r=>r.items),
      result,margin:revenue>0?money(result/revenue*100):null,partial:pending.length>0||data.integration_status==='yellow',
      opening,incoming,outgoing,net:money(incoming-outgoing),closing:money(opening+incoming-outgoing)},
    daily,origins,expenses,position,agenda,titles,result_rows:resultRows,cash_rows:cashRows,
    cash_filtered:{incoming:sum(cashRows,r=>r.cash_in),outgoing:sum(cashRows,r=>r.cash_out)},
    projection:{from:data.today,to:forecastEnd,daily:forecast,rows:projectedRows,
      incoming:sum(projected,r=>r.side==='receivable'?r.amount:0),outgoing:sum(projected,r=>r.side==='payable'?r.amount:0)},
  };
}
export async function getFinancialReport(filter:FinancialReportFilter){return buildFinancialReport(await readFinancialSnapshot(filter),filter);}
