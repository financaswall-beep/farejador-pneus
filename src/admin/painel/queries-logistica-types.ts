export interface MatrizDeliveryRow {
  order_id: string; order_number: string | null;
  customer_name: string | null; customer_phone: string | null;
  delivery_address: string | null; total_amount: string;
  payment_method: string | null; status: string;
  delivery_status: 'pending' | 'dispatched' | 'delivered' | 'failed';
  delivery_courier: string | null;
  delivery_failure_reason: string | null;
  trip_id: string | null;
  created_at: string; dispatched_at: string | null; delivered_at: string | null;
  scheduled_date: string; scheduled_raw: string | null;
  items: Array<{ quantity: number; label: string }>;
}

export interface MatrizTripRow {
  id: string; trip_number: string; courier_name: string;
  status: 'open' | 'closed';
  km_start: string | null; km_end: string | null; fuel_spent: string | null;
  fuel_expense_id: string | null; fuel_spent_without_approved_expense: boolean;
  financial_status: 'pending' | 'divergent' | 'reconciled';
  approved_fuel_amount: string; notes: string | null;
  started_at: string; ended_at: string | null;
  deliveries_count: number; orders_total: string; remaining_count: number;
  resumo: {
    entregues: number; nao_entregues: number;
    faturamento_total: number; frete_total: number; faturamento_pneus: number;
    custo_pneus: number; lucro_pneus: number; itens_sem_custo: number;
  };
  despesas_total: string;
  pedidos_resultado: Array<{
    order_id: string; order_number: string | null; customer_name: string | null;
    total: number; faturamento_pneus: number; custo_pneus: number;
    frete: number; margem_antes_rota: number; itens_sem_custo: number;
  }>;
  despesas: Array<{
    id: string; category: string; description: string | null;
    amount: number; occurred_at: string;
    source: 'comprovante' | 'fechamento';
    receipt_id: string | null; receipt_summary: string | null;
  }>;
  receipts: Array<{
    id: string; ai_summary: string | null; ai_expense_id: string | null;
    ai_status: 'pending' | 'parsed' | 'unreadable' | 'skipped';
    workflow_status: 'uploaded' | 'processing' | 'review_required' | 'linked' | 'rejected' | 'legacy_linked';
    expense_category: string | null; expense_amount: number | null; expense_removed: boolean;
    latest_attempt: Record<string, unknown> | null; decision: Record<string, unknown> | null;
    created_at: string;
  }>;
  detached_reports: Array<{
    order_id: string; delivery_failure_reason: string | null; detached_at: string;
  }>;
}

export interface MatrizLogistica {
  abertas: MatrizDeliveryRow[];
  reportadas: MatrizDeliveryRow[];
  finalizadas: MatrizDeliveryRow[];
  rotas_abertas: MatrizTripRow[];
  rotas_recentes: MatrizTripRow[];
}
