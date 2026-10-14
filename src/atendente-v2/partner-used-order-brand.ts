import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import type { PartnerOrderRouting } from './fulfillment.js';
import { env } from '../shared/config/env.js';
import { latestStockRequest, requestConfirms } from './stock-confirmation-store.js';

/** Snapshot no nascimento do pedido, na mesma transação. Não muda a marca do saldo misto. */
export async function captureConfirmedUsedBrands(client:PoolClient,environment:Environment,
  conversationId:string,partnerOrderId:string,routing:PartnerOrderRouting):Promise<void> {
  if(!env.PARTNER_STOCK_CONFIRMATION)return;
  const request=await latestStockRequest(client,environment,conversationId);
  if(!requestConfirms(request,routing.unitId,routing.items))return;
  for(const item of routing.items) {
    const brand=request!.routing.items.find(row=>row.product_id===item.product_id)?.requested_brand;
    if(!brand)continue;
    const saved=await client.query<{id:string}>(`UPDATE commerce.partner_order_items i SET brand=$5
      FROM commerce.partner_orders o,commerce.partner_stock_levels s,commerce.products p
      WHERE i.environment=$1 AND i.order_id=$2 AND i.partner_stock_id=$3 AND i.brand IS NULL
        AND o.id=i.order_id AND o.environment=i.environment AND o.unit_id=$4 AND o.source_tag='2w'
        AND s.id=i.partner_stock_id AND s.environment=i.environment AND s.unit_id=o.unit_id
        AND p.id=s.product_id AND p.environment=s.environment AND p.partner_generic
      RETURNING i.id`,[environment,partnerOrderId,item.partner_stock_id,routing.unitId,brand]);
    for(const row of saved.rows) await client.query(`INSERT INTO audit.events
      (environment,domain,entity_table,entity_id,event_type,actor_label,payload_after)
      VALUES($1,'orders','commerce.partner_order_items',$2,'partner_used_brand_confirmed','bot', $3::jsonb)`,
    [environment,row.id,JSON.stringify({brand,stock_request_id:request!.id,partner_order_id:partnerOrderId})]);
  }
}
