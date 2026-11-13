import type { SalePaymentSnapshot } from './sale-payment-plan.js';

export type FinanceiroSettlementMode =
  | 'wholesale_sale' | 'retail_sale' | 'commission' | 'monthly_fee'
  | 'wholesale_purchase' | 'expense' | 'commission_refund'
  | 'central_obligation' | 'central_account';

export interface FinanceiroReceivableItem {
  tipo: 'servico' | 'fiado' | 'varejo' | 'comissao' | 'mensalidade'
    | 'devolucao_fornecedor' | 'devolucao_despesa';
  id: string;
  nome: string;
  valor: string;
  due_date: string | null;
  overdue: boolean;
  phone: string | null;
  count?: number;
  sale_installment?: number;
  order_id?: string;
  categoria?: string;
  obligation_id?: string;
  account_code?: string;
  settlement_mode?: FinanceiroSettlementMode;
}

export interface FinanceiroPayableItem {
  tipo: 'fornecedor' | 'despesa' | 'folha' | 'estorno_comissao'
    | 'marketing' | 'devolucao_cliente';
  id: string;
  nome: string;
  categoria?: string;
  valor: string;
  parcela_compra?: number;
  due_date: string | null;
  overdue: boolean;
  obligation_id?: string;
  account_code?: string;
  settlement_mode?: FinanceiroSettlementMode;
}

export interface MatrizLedgerOpenItems {
  a_receber: { total: string; vencidos_count: number; itens: FinanceiroReceivableItem[] };
  a_pagar: { total: string; vencidos_count: number; itens: FinanceiroPayableItem[] };
}

export interface OpenRow {
  order_id?: string;
  obligation_id: string;
  source_type: string;
  source_id: string;
  account_code: string;
  balance: string;
  due_date: string | null;
  overdue: boolean;
  description: string;
  category: string | null;
  partner_id: string | null;
  partner_name: string | null;
  partner_phone: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  supplier_name: string | null;
  sale_plan?: SalePaymentSnapshot | null;
  installment_number?: number;
  installments_count?: number;
}
