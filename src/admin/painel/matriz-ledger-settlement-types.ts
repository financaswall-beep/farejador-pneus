export type Environment = 'prod' | 'test';
type Target = { obligation_id: string; account_code?: never } |
  { obligation_id?: never; account_code: 'marketing_payable' };
export type MatrizLedgerSettlementInput = Target & {
  amount?: number;
  supplier_credit_amount?: number;
  sale_installment?: { order_id: string; number: number };
  purchase_installment?: number;
  purchase_id?: string;
  payment_method?: string;
  paid_at?: string;
  cash_account?: string;
  note?: string;
  actor_label?: string | null;
  idempotency_key: string;
  environment?: Environment;
};
export interface MatrizLedgerSettlementResult {
  target_id: string;
  direction: 'receivable' | 'payable';
  amount: string;
  remaining_balance: string;
  installment_remaining_balance?: string;
  payment_ids: string[];
  settled_at: string;
  credit_applied?: string;
  cash_paid?: string;
}
