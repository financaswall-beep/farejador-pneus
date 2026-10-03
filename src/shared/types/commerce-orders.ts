import type { Environment } from './chatwoot.js';
import type { TireCondition } from '../tire-condition.js';

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'in_preparation'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'refunded';

export type OrderFulfillmentMode = 'delivery' | 'pickup';

export interface Order {
  id: string;
  environment: Environment;
  contact_id: string;
  conversation_id: string | null;
  order_number: string;
  status: OrderStatus;
  fulfillment_mode: OrderFulfillmentMode;
  delivery_address: string | null;
  geo_resolution_id: string | null;
  payment_method: string | null;
  subtotal: string; // NUMERIC
  delivery_fee: string; // NUMERIC
  discount: string;   // NUMERIC
  total_amount: string; // NUMERIC
  notes: string | null;
  closed_by: string | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ------------------------------------------------------------------
// commerce.order_items
// ------------------------------------------------------------------

export interface OrderItem {
  id: string;
  environment: Environment;
  order_id: string;
  product_id: string;
  tire_condition: TireCondition | null;
  quantity: number;
  unit_price: string; // NUMERIC
  line_total: string; // NUMERIC
  created_at: Date;
}
