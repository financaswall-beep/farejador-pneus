import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
export async function lotSalesReady(db: Pool = defaultPool) {
  const result = await db.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='commerce' AND table_name='wholesale_orders' AND column_name='is_lot_sale') ready`);
  return result.rows[0].ready as boolean;
}
export async function listSaleLots(db: Pool = defaultPool) {
  const result = await db.query(`SELECT l.id,'LT-'||lpad(l.lot_number::text,6,'0') lot_code,l.description,
    l.quantity_on_hand,l.quantity_reserved,l.quantity_on_hand-l.quantity_reserved available_quantity,
    l.remaining_cost,l.allocated_cost/l.ordered_quantity unit_cost,l.created_at,
    COALESCE(p.stock_applied_at,l.created_at) received_at
    FROM commerce.tire_lots l LEFT JOIN commerce.wholesale_purchases p ON p.environment=l.environment AND p.id=l.purchase_id
    WHERE l.environment=$1 AND l.accepted_quantity IS NOT NULL AND l.quantity_on_hand>l.quantity_reserved
      AND p.status IS DISTINCT FROM 'cancelled' ORDER BY l.created_at,l.id`, [env.FAREJADOR_ENV]);
  return result.rows;
}
export async function listLotSales(page=1, db: Pool = defaultPool) {
  const result = await db.query(`WITH sales AS (
    SELECT o.id,o.sold_at,o.buyer_id,c.name buyer_name,o.status,o.payment_status,o.due_date,o.paid_at,
      o.lot_sale_description description,o.payment_method payment_method,o.notes,o.cancel_reason,
      o.total_amount,o.lot_sale_discount discount,
      COALESCE((SELECT sum(quantity) FROM commerce.wholesale_order_items i WHERE i.environment=o.environment AND i.order_id=o.id),0) quantity,
      COALESCE((SELECT sum(round(quantity*unit_cost,2)) FROM commerce.wholesale_order_items i WHERE i.environment=o.environment AND i.order_id=o.id),0) cost,
      (SELECT jsonb_agg(jsonb_build_object('lot_id',l.id,'lot_code','LT-'||lpad(l.lot_number::text,6,'0'),
        'quantity',i.quantity,'cost',round(i.quantity*i.unit_cost,2),'amount',i.line_total) ORDER BY l.created_at,l.id)
        FROM commerce.wholesale_order_items i JOIN commerce.tire_lots l ON l.environment=i.environment AND l.id=i.tire_lot_id
        WHERE i.environment=o.environment AND i.order_id=o.id) allocations
    FROM commerce.wholesale_orders o JOIN commerce.wholesale_customers c ON c.id=o.buyer_id AND c.environment=o.environment
    WHERE o.environment=$1 AND o.is_lot_sale
  ), page AS (SELECT * FROM sales ORDER BY sold_at DESC,id DESC LIMIT 20 OFFSET $2)
  SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(page ORDER BY sold_at DESC,id DESC) FROM page),'[]'),
    'total',(SELECT count(*) FROM sales),'page_size',20) payload`, [env.FAREJADOR_ENV,(page-1)*20]);
  return result.rows[0].payload;
}
