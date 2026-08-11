export type OperationCommissionStatus = 'receivable' | 'paid' | 'reversed';

export interface OperationSalesSummary {
  sales_count: number;
  revenue: number;
  average_ticket: number;
  items_quantity: number;
  commission_amount: number;
}

export interface OperationSalesDay extends OperationSalesSummary {
  date: string;
}

export interface OperationSaleListItem {
  order_id: string;
  order_number: string;
  payment_method: string | null;
  total_amount: number;
  status: string;
  created_at: string;
  items_quantity: number;
  item_kind: 'pneu' | 'servico' | 'item';
  item_summary: string;
  commission_kind: 'percent' | 'fixed' | null;
  commission_basis: string | null;
  commission_value: number;
  commission_amount: number;
  commission_status: OperationCommissionStatus;
}

export interface OperationMySalesPayload {
  week_offset: number;
  summary: OperationSalesSummary;
  daily_series: OperationSalesDay[];
  sales: OperationSaleListItem[];
}

export interface OperationSaleDetail extends OperationSaleListItem {
  seller_name: string;
  items: Array<{
    product_name: string;
    quantity: number;
    unit_price: number;
    discount_amount: number;
    line_total: number;
    image_url: string | null;
  }>;
}

export function summarizeOperationDays(days: OperationSalesDay[]): OperationSalesSummary {
  const total = days.reduce((summary, day) => ({
    sales_count: summary.sales_count + day.sales_count,
    revenue: summary.revenue + day.revenue,
    average_ticket: 0,
    items_quantity: summary.items_quantity + day.items_quantity,
    commission_amount: summary.commission_amount + day.commission_amount,
  }), { sales_count: 0, revenue: 0, average_ticket: 0, items_quantity: 0, commission_amount: 0 });
  total.revenue = Math.round(total.revenue * 100) / 100;
  total.commission_amount = Math.round(total.commission_amount * 100) / 100;
  total.average_ticket = total.sales_count
    ? Math.round(total.revenue * 100 / total.sales_count) / 100
    : 0;
  return total;
}
