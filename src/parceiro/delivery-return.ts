import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';

export class DeliveryAlreadyFinalizedError extends Error {
  readonly code = 'delivery_already_finalized';
  constructor() {
    super('delivery_already_finalized');
  }
}

export class DeliveryReturnNotAwaitingError extends Error {
  readonly code = 'delivery_return_not_awaiting';
  constructor() {
    super('delivery_return_not_awaiting');
  }
}

/** Libera a reserva somente depois que a loja confirma o retorno físico. */
export async function confirmPartnerDeliveryReturn(
  ctx: PartnerContext,
  orderId: string,
  reason?: string | null,
): Promise<{ order_id: string; return_confirmed: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const existing = await client.query<{ status: string; delivery_status: string }>(
      `SELECT status,delivery_status
         FROM commerce.partner_orders
        WHERE id=$1 AND environment=$2 AND unit_id=$3
          AND fulfillment_mode='delivery' AND deleted_at IS NULL
        FOR UPDATE`,
      [orderId, ctx.environment, ctx.unitId],
    );
    if (existing.rowCount !== 1) throw new Error('delivery_not_found');
    const current = existing.rows[0]!;
    if (current.status === 'cancelled' && current.delivery_status === 'failed') {
      return { order_id: orderId, return_confirmed: true };
    }
    if (current.status === 'cancelled' || current.delivery_status !== 'failed') {
      throw new DeliveryReturnNotAwaitingError();
    }

    const actor = `partner:${ctx.slug}`;
    const returnReason = (reason ?? '').trim().slice(0, 500)
      || 'retorno fisico confirmado pela loja';
    await client.query("SELECT set_config('app.partner_actor_label',$1,true)", [actor]);
    await client.query('SELECT commerce.cancel_partner_local_order($1,$2,$3)', [
      orderId, actor, returnReason,
    ]);
    await client.query(
      `UPDATE commerce.partner_orders
          SET delivery_status='failed',updated_at=now()
        WHERE id=$1 AND environment=$2 AND unit_id=$3`,
      [orderId, ctx.environment, ctx.unitId],
    );
    await client.query(
      `INSERT INTO audit.events
         (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
       VALUES ($1,'partner_orders','commerce.partner_orders',$2,
         'partner_delivery_return_confirmed',$3,$4::jsonb)`,
      [ctx.environment, orderId, actor, JSON.stringify({
        unit_id: ctx.unitId, delivery_status: 'failed', status: 'cancelled',
        stock_released_after_physical_return: true, reason: returnReason,
      })],
    );
    return { order_id: orderId, return_confirmed: true };
  });
}
