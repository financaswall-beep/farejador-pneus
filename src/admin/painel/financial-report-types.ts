export interface FinancialMovement {
  id:string;source_type:string;source_id:string;description:string;reference:string|null;party:string|null;
  competence_on:string;cash_on:string|null;category:string|null;payment_method:string|null;cash_account:string|null;
  reversal_of:string|null;reversed:boolean;revenue:number;cost:number;expense:number;gain:number;loss:number;cash_in:number;cash_out:number;
}
export interface FinancialTitle {
  id:string;source_id:string;obligation_id:string|null;side:'receivable'|'payable';type:string;name:string;
  amount:number;due_on:string|null;category:string|null;count:number;origin:string;
}
export interface FinancialSnapshot {
  as_of:string;today:string;integration_status:'green'|'yellow';movements:FinancialMovement[];
  opening:Array<{source_type:string;amount:number}>;titles:FinancialTitle[];
  pending_cost:Array<{day:string;amount:number;items:number}>;
}
