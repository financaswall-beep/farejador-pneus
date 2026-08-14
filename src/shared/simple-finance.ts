export interface SimpleFinancePayload {
  period: string;
  unit_name: string;
  cash_in: number;
  cash_out: number;
  cash_net: number;
  receivable_total: number;
  receivable_count: number;
  due_today_total: number;
  due_today_count: number;
  commission_total: number;
  commission_collaborators: number;
}
