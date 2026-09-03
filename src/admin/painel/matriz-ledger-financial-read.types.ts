export interface LedgerTruthRow {
  revenue: string; known_cost: string; operating_expenses: string;
  inventory_gain: string; inventory_loss: string; cash_in: string;
  cash_out: string; cash_opening: string; cash_retail: string;
  cash_wholesale: string; cash_network: string; cash_monthly: string;
  cash_purchases: string; cash_expenses: string; cash_commission_refund: string;
  pending_revenue: string; pending_items: number; pending_orders: number;
  receivables: string; payables: string; retail_receivable: string;
  cancelled_retail: number; cancelled_wholesale: number; cancelled_purchases: number;
  reversed_commissions: number; deleted_expenses: number;
  reversed_after_settlement: number; suspected_test_rows: number;
  source_wholesale: string; ledger_wholesale: string; source_retail: string;
  ledger_retail: string; source_freight: string; source_commission: string;
  ledger_commission: string; source_monthly: string; ledger_monthly: string;
  source_expenses: string; ledger_expenses: string; source_marketing: string;
  ledger_marketing: string; source_purchases: string; ledger_purchases: string;
  source_inventory: string; ledger_inventory: string;
}
