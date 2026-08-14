import type { SimpleFinanceRange } from './simple-finance.js';

export type OperationFinanceEntryKind = 'sale' | 'receivable' | 'other';

export interface OperationFinanceEntry {
  id: string;
  kind: OperationFinanceEntryKind;
  title: string;
  subtitle: string;
  origin: string;
  payment_method: string | null;
  amount: number;
  entry_date: string;
  occurred_at: string;
}

export interface OperationFinanceEntriesPayload {
  range: SimpleFinanceRange;
  total: number;
  count: number;
  visible_count: number;
  rows: OperationFinanceEntry[];
}
