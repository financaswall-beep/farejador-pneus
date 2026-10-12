export interface PartnerOrderState {
  status: string;
  fulfillment_mode: string;
  partner_status: string | null;
  partner_delivery_status: string | null;
  partner_retrieved_at: Date | null;
  partner_delivered_at: Date | null;
}

/** O espelho pode continuar open; o estado operacional pertence ao parceiro. */
export function partnerOrderPresentation(order: PartnerOrderState) {
  const status = order.partner_status ?? order.status;
  if (status === 'cancelled') return { status, situation: 'cancelado', closedAt: null };
  if (order.fulfillment_mode === 'pickup') {
    if (order.partner_retrieved_at) return { status, situation: 'retirado', closedAt: order.partner_retrieved_at };
    return { status, situation: 'aguardando retirada', closedAt: null };
  }
  const labels: Record<string, string> = {
    pending: 'em separação', dispatched: 'saiu para entrega',
    delivered: 'entregue', failed: 'entrega não concluída',
  };
  return { status, situation: labels[order.partner_delivery_status ?? ''] ?? 'situação da entrega a confirmar',
    closedAt: order.partner_delivery_status === 'delivered' ? order.partner_delivered_at : null };
}
