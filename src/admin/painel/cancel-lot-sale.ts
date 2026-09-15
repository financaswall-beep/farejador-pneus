import type { PoolClient } from 'pg';
import { getWholesaleSaleLedgerState,postWholesaleSaleCancellation } from './matriz-ledger-wholesale-sales.js';
import { recordIntegrityEvent, moneyCents } from './stage5-integrity.js';
import type { CancelWholesaleSaleInput } from './queries-atacado-cancelar.js';
export async function cancelLotSaleInTransaction(client: PoolClient, environment: 'prod'|'test', input: CancelWholesaleSaleInput) {
  const rows=await client.query(`SELECT i.tire_lot_id lot_id,i.quantity,round(i.unit_cost*i.quantity,2) cost,
      m.quantity_delta,m.cost_delta
    FROM commerce.wholesale_order_items i
    JOIN commerce.tire_lots l ON l.environment=i.environment AND l.id=i.tire_lot_id
    LEFT JOIN commerce.tire_lot_movements m ON m.environment=i.environment AND m.lot_id=l.id AND m.order_id=i.order_id AND m.source='sale'
    WHERE i.environment=$1 AND i.order_id=$2 ORDER BY l.id FOR UPDATE OF l`,[environment,input.order_id]);
  if (!rows.rows.length) throw new Error('lot_sale_history_missing');
  let cost=0;
  for (const row of rows.rows) {
    if (row.quantity_delta!==-row.quantity || moneyCents(Number(row.cost_delta))!==-moneyCents(Number(row.cost))) throw new Error('lot_sale_history_missing');
    cost+=moneyCents(Number(row.cost));
    await client.query(`UPDATE commerce.tire_lots SET quantity_on_hand=quantity_on_hand+$3,remaining_cost=remaining_cost+$4
      WHERE environment=$1 AND id=$2`,[environment,row.lot_id,row.quantity,row.cost]);
    await client.query(`INSERT INTO commerce.tire_lot_movements(environment,lot_id,source,quantity_delta,cost_delta,created_by,order_id,occurred_at)
      VALUES ($1,$2,'sale_cancel',$3,$4,$5,$6,now())`,[environment,row.lot_id,row.quantity,row.cost,input.cancelled_by,input.order_id]);
  }
  const ledger=await getWholesaleSaleLedgerState(client,environment,input.order_id);
  const updated=await client.query(`UPDATE commerce.wholesale_orders SET status='cancelled',cancelled_at=now(),cancelled_by=$3,cancel_reason=$4
    WHERE environment=$1 AND id=$2 RETURNING cancelled_at,payment_status`,[environment,input.order_id,input.cancelled_by,input.reason.trim()]);
  const cancelledAt=updated.rows[0].cancelled_at;
  await postWholesaleSaleCancellation(client,ledger,[],cancelledAt,input.cancelled_by,input.reason,cost/100);
  const result={order_id:input.order_id,cancelled_at:cancelledAt,payment_status:updated.rows[0].payment_status,
    stock_returned:[],stock_unverified:[],lot_stock_returned:rows.rows.map(row=>({lot_id:row.lot_id,quantity:row.quantity,cost:row.cost}))};
  await recordIntegrityEvent(client,{environment,domain:'tire_lot_sale',entityTable:'commerce.wholesale_orders',entityId:input.order_id,
    eventType:'cancelled',actorLabel:input.cancelled_by,idempotencyKey:input.idempotency_key,after:result});
  return result;
}
