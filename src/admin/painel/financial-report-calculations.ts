import type { FinancialMovement,FinancialTitle } from './financial-report-types.js';
import { reportAddDays } from './report-period.js';
export const financialCents=(value:number)=>Math.round(value*100);
export const financialSum=<T>(rows:T[],value:(row:T)=>number)=>rows.reduce((total,row)=>total+financialCents(value(row)),0)/100;
export const financialMoney=(value:number)=>financialCents(value)/100;
export const financialOrigin=(value:string)=>{
  if(value.startsWith('commerce.wholesale_order.'))return'atacado';
  if(value.startsWith('commerce.order.'))return'varejo';
  if(value.startsWith('commerce.wholesale_purchase.'))return'compras';
  if(value.startsWith('commerce.matriz_expense.'))return'despesas';
  if(value.startsWith('network.commission'))return'comissao';
  if(value.startsWith('network.monthly_fee.'))return'mensalidades';
  if(value.startsWith('marketing.'))return'marketing';
  if(value.includes('inventory'))return'estoque';
  if(value.startsWith('finance.'))return'financeiro';return'outros';
};
export const financialResult=(r:FinancialMovement)=>financialMoney(r.revenue-r.cost-r.expense-r.loss+r.gain);
export const financialDays=(from:string,to:string)=>{const days=[];for(let day=from;day<=to;day=reportAddDays(day,1))days.push(day);return days;};
export const financialDue=(row:FinancialTitle,today:string)=>!row.due_on?'undated':row.due_on<today?'overdue':row.due_on===today?'today':'upcoming';
export function financialDueMatches(row:FinancialTitle,due:string,today:string){
  if(due==='all')return true;if(due==='next7'||due==='next30')return !!row.due_on&&row.due_on>=today&&row.due_on<=reportAddDays(today,due==='next7'?6:29);
  return financialDue(row,today)===due;
}
