export interface LogisticsTrip {
  id:string; number:string; courier:string; courier_id:string|null; status:'open'|'closed';
  started_at:string; ended_at:string|null; day:string;
  km_start:number|null; km_end:number|null; fuel_recorded:number|null;
  financial_status:'pending'|'divergent'|'reconciled';
}
export interface LogisticsDelivery {
  id:string; trip_id:string; order_id:string; number:string|null; customer:string|null;
  status:'pending'|'dispatched'|'delivered'|'failed'; cancelled:boolean;
  reason:string|null; scheduled:string|null; dispatched_at:string|null; delivered_at:string|null;
  historical:boolean; freight:number|null;
}
export interface LogisticsExpense {
  id:string; trip_id:string; category:string; amount:number; occurred_at:string;
  receipt_ids:string[]; legacy:boolean;
}
export interface LogisticsReceipt {
  id:string; trip_id:string; created_at:string; workflow:string; expense_id:string|null; missing_expense:boolean;
}
export interface LogisticsSnapshot {
  as_of:string; trips:LogisticsTrip[]; deliveries:LogisticsDelivery[]; expenses:LogisticsExpense[]; receipts:LogisticsReceipt[];
}
