import type { PartnerContext } from './auth.js';
import { partnerActor } from './actor.js';
import { withPartnerContext } from './db.js';

export async function cancelPartnerPickup(ctx: PartnerContext, orderId: string,
  reason?: string | null): Promise<{ order_id: string; cancelled: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async client => {
    const result = await client.query(`SELECT id FROM commerce.partner_orders
      WHERE id=$1 AND environment=$2 AND unit_id=$3 AND deleted_at IS NULL
        AND status<>'cancelled' AND fulfillment_mode='pickup' AND awaiting_pickup
      FOR UPDATE`, [orderId, ctx.environment, ctx.unitId]);
    if (!result.rows[0]) return { order_id: orderId, cancelled: false };
    const actor = partnerActor(ctx);
    await client.query("SELECT set_config('app.partner_actor_label',$1,true)", [actor]);
    await client.query('SELECT commerce.cancel_partner_local_order($1,$2,$3)',
      [orderId, actor, reason?.trim().slice(0, 500) || 'reserva cancelada pelo portal parceiro']);
    return { order_id: orderId, cancelled: true };
  });
}
