import type { SalePaymentPlan } from './sale-payment-plan.js';
import type { TireCondition } from '../../shared/tire-condition.js';

export interface SaleItemInput {
  measure: string;
  brand?: string | null;
  tire_condition: TireCondition | string;
  quantity: number;
  unit_price: number;
}

export interface RegisterWholesaleSaleInput {
  environment?: 'prod' | 'test';
  customer_id?: string | null;
  partner_id?: string | null;
  new_customer?: { name: string; phone?: string | null } | null;
  items: SaleItemInput[];
  sold_at?: string | null;
  paid_at?: string | null;
  notes?: string | null;
  created_by: string;
  seller_collaborator_id?: string | null;
  payment_status?: 'paid' | 'pending';
  due_date?: string | null;
  idempotency_key: string;
  payment_plan?: SalePaymentPlan;
  parent_order_id?: string | null;
  partner_unit_id?: string | null;
}

export interface RegisterWholesaleSaleResult {
  order_id: string;
  buyer_id: string;
  buyer_name: string;
  total_amount: string;
  items_count: number;
  parent_order_id: string | null;
  partner_unit_id: string | null;
  linked_partner_purchase_id: string | null;
  status: 'pending' | 'confirmed';
  payment_status: 'pending' | 'paid';
  partner_payment_terms: 'cash_on_arrival' | 'credit' | null;
}
