import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { reportAddDays } from './report-period.js';
import { readLogisticsSnapshot } from './logistics-report-data.js';
import type { LogisticsReportFilter } from './logistics-report-filter.js';
import type { LogisticsSnapshot, LogisticsDelivery, LogisticsReceipt } from './logistics-report-types.js';

const money=(n:number)=>Math.round(n*100)/100;
const sum=<T>(rows:T[],value:(r:T)=>number)=>money(rows.reduce((n,r)=>n+value(r),0));
export const logisticsDeliveryStatus=(r:LogisticsDelivery)=>r.cancelled?'cancelled':r.status==='dispatched'?'pending':r.status;
export const logisticsReceiptStatus=(r:LogisticsReceipt)=>r.missing_expense?'pending':
  r.workflow==='linked'?'linked':r.workflow==='legacy_linked'?'legacy':r.workflow==='rejected'?'rejected':'pending';

export function buildLogisticsReport(data:LogisticsSnapshot,filter:LogisticsReportFilter){
  const expenseTrips=new Map<string,Set<string>>();
  for(const row of data.expenses){const ids=expenseTrips.get(row.id)||new Set<string>();ids.add(row.trip_id);expenseTrips.set(row.id,ids);}
  const deliveries=data.deliveries.map(row=>({...row,result:logisticsDeliveryStatus(row)}));
  const receipts=data.receipts.map(row=>({...row,state:logisticsReceiptStatus(row)}));
  const trips=data.trips.map(trip=>{
    const items=deliveries.filter(row=>row.trip_id===trip.id),expenses=data.expenses.filter(row=>row.trip_id===trip.id);
    const docs=receipts.filter(row=>row.trip_id===trip.id),completed=items.filter(row=>row.result==='delivered');
    const occurrences=items.filter(row=>['failed','cancelled'].includes(row.result));
    const expensesAmount=sum(expenses,row=>row.amount),freight=sum(completed,row=>row.freight??0);
    const missingFreight=completed.filter(row=>row.freight===null).length;
    const km=trip.km_start!==null&&trip.km_end!==null&&trip.km_end>=trip.km_start?money(trip.km_end-trip.km_start):null;
    const duration=trip.ended_at?Math.round((Date.parse(trip.ended_at)-Date.parse(trip.started_at))/60000):null;
    const shared=expenses.some(row=>(expenseTrips.get(row.id)?.size||0)>1);
    const pending=docs.filter(row=>row.state==='pending').length;
    return {...trip,courier_key:trip.courier_id||'legacy:'+trip.courier,km,duration_minutes:duration!==null&&duration>=0?duration:null,
      deliveries:items.length,delivered:completed.length,occurrences:occurrences.length,pending:items.filter(row=>row.result==='pending').length,
      expenses:expensesAmount,freight,freight_balance:money(freight-expensesAmount),missing_freight:missingFreight,
      receipt_pending:pending,receipt_approved:docs.filter(row=>row.state==='linked').length,receipt_legacy:docs.filter(row=>row.state==='legacy').length,
      shared_expense:shared,partial:trip.status!=='closed'||trip.financial_status!=='reconciled'||pending>0||missingFreight>0||shared,
      reasons:[...new Set(occurrences.map(row=>row.reason?.trim()|| (row.cancelled?'Pedido cancelado':'Motivo não informado')))]
        .map(reason=>({reason,count:occurrences.filter(row=>(row.reason?.trim()||(row.cancelled?'Pedido cancelado':'Motivo não informado'))===reason).length}))};
  });
  const couriers=[...new Map(trips.slice().reverse().map(row=>[row.courier_key,{id:row.courier_key,name:row.courier}])).values()].sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
  const selected=trips.filter(row=>(!filter.courier||row.courier_key===filter.courier)
    &&(!filter.search||(row.number+' '+row.courier).toLocaleLowerCase('pt-BR').includes(filter.search.toLocaleLowerCase('pt-BR')))
    &&(filter.status==='all'||filter.status==='occurrences'&&row.occurrences>0||filter.status==='financial_pending'&&row.partial||row.status===filter.status));
  const byId=new Map(selected.map(row=>[row.id,row])),ids=new Set(byId.keys()),closed=selected.filter(row=>row.status==='closed');
  const closedIds=new Set(closed.map(row=>row.id)),allExpenses=data.expenses.filter(row=>ids.has(row.trip_id));
  const distinctExpenses=[...new Map(allExpenses.filter(row=>closedIds.has(row.trip_id)).map(row=>[row.id,row])).values()];
  const closedDeliveries=sum(closed,row=>row.delivered),closedExpenses=sum(distinctExpenses,row=>row.amount);
  const dates=[];for(let day=filter.from;day<=filter.to;day=reportAddDays(day,1))dates.push(day);
  const daily=dates.map(day=>({day,delivered:sum(selected.filter(row=>row.day===day),row=>row.delivered),occurrences:sum(selected.filter(row=>row.day===day),row=>row.occurrences)}));
  const withTrip=<T extends {trip_id:string}>(row:T)=>({...row,trip_number:byId.get(row.trip_id)!.number,courier:byId.get(row.trip_id)!.courier});
  const matchesTrip=(row:{trip_id:string})=>ids.has(row.trip_id)&&(!filter.trip||row.trip_id===filter.trip);
  const tripOrder=new Map(selected.map((row,index)=>[row.id,index]));
  const selectedDeliveries=deliveries.filter(row=>matchesTrip(row)&&(filter.delivery==='all'||row.result===filter.delivery)).map(withTrip)
    .sort((a,b)=>tripOrder.get(a.trip_id)!-tripOrder.get(b.trip_id)!||(a.number||a.order_id).localeCompare(b.number||b.order_id,'pt-BR',{numeric:true})||a.id.localeCompare(b.id));
  const selectedReceipts=receipts.filter(row=>ids.has(row.trip_id)).map(withTrip);
  const costs=[...allExpenses.map(row=>({...withTrip(row),key:'expense:'+row.trip_id+':'+row.id,
    state:row.legacy?'legacy':'linked',missing_expense:false,partial:byId.get(row.trip_id)!.partial})),
    ...selectedReceipts.filter(row=>row.state==='pending'||row.state==='rejected').map(row=>({id:row.id,trip_id:row.trip_id,
      trip_number:row.trip_number,courier:row.courier,key:'receipt:'+row.id,category:'comprovante',amount:null,
      occurred_at:row.created_at,receipt_ids:[row.id],legacy:false,state:row.state,missing_expense:row.missing_expense,partial:true}))]
    .filter(row=>matchesTrip(row)&&(filter.receipt==='all'||row.state===filter.receipt))
    .sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)||tripOrder.get(a.trip_id)!-tripOrder.get(b.trip_id)!||a.key.localeCompare(b.key));
  return {filters:filter,as_of:data.as_of,couriers,trips:selected,deliveries:selectedDeliveries,receipts:selectedReceipts,expenses:allExpenses,costs,daily,
    summary:{delivered:sum(selected,row=>row.delivered),occurrences:sum(selected,row=>row.occurrences),closed:closed.length,open:selected.length-closed.length,
      km:closed.some(row=>row.km!==null)?sum(closed,row=>row.km??0):null,km_missing:closed.filter(row=>row.km===null).length,
      expenses:closedExpenses,closed_deliveries:closedDeliveries,cost_per_delivery:closedDeliveries?money(closedExpenses/closedDeliveries):null,
      partial:closed.some(row=>row.partial),pending_receipts:selectedReceipts.filter(row=>row.state==='pending').length},
  };
}
export async function getLogisticsReport(filter:LogisticsReportFilter,environment=env.FAREJADOR_ENV,db:Pool=pool){
  return buildLogisticsReport(await readLogisticsSnapshot(db,environment,filter),filter);
}
