export type SimpleFinanceRange = 'today' | '7d' | '15d' | '30d';

export function simpleFinanceRangeDays(range: SimpleFinanceRange): number {
  if (range === 'today') return 1;
  if (range === '7d') return 7;
  if (range === '15d') return 15;
  return 30;
}

export interface SimpleFinancePayload {
  period: string;
  range: SimpleFinanceRange;
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
