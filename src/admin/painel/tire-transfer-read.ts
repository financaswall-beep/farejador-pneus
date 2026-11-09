import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
export async function tireTransfersReady(db: Pick<Pool, 'query'> = defaultPool) {
  return (await db.query(`SELECT to_regclass('commerce.tire_stock_transfers') IS NOT NULL ready`)).rows[0].ready === true;
}

export async function listTransferProducts(search: string, db: Pool = defaultPool) {
  return { rows: (await db.query(`SELECT p.id,p.brand,p.tire_condition,ts.tire_size measure,ts.vehicle_type
    FROM commerce.products p JOIN commerce.tire_specs ts ON ts.environment=p.environment AND ts.product_id=p.id
    WHERE p.environment=$1 AND p.product_type='tire' AND p.deleted_at IS NULL AND NOT p.partner_generic
      AND ts.vehicle_type IS NOT NULL AND p.tire_condition IS NOT NULL AND ts.tire_size IS NOT NULL
      AND ($2='' OR strpos(lower(ts.tire_size||' '||COALESCE(p.brand,'')),lower($2))>0)
    ORDER BY ts.tire_size,p.brand,p.tire_condition,p.id LIMIT 100`, [env.FAREJADOR_ENV, search])).rows };
}
export async function listTireTransfers(filters: { lot_id?: string; stock_id?: string; page?: number }, db: Pool = defaultPool) {
  const result = await db.query(`WITH filtered AS (
    SELECT t.id,t.kind,t.lot_id,t.quantity,t.cost,t.reason,t.created_by,t.created_at,t.reversal_of,
      'LT-'||lpad(l.lot_number::text,6,'0') lot_code,l.purchase_id,
      g.id group_id,g.name group_name,
      EXISTS(SELECT 1 FROM commerce.tire_stock_transfers r WHERE r.environment=t.environment AND r.reversal_of=t.id) reversed
    FROM commerce.tire_stock_transfers t JOIN commerce.tire_lots l ON l.environment=t.environment AND l.id=t.lot_id
    LEFT JOIN commerce.wholesale_purchase_group_purchases gp ON gp.environment=l.environment AND gp.purchase_id=l.purchase_id
    LEFT JOIN commerce.wholesale_purchase_groups g ON g.environment=gp.environment AND g.id=gp.group_id
    WHERE t.environment=$1 AND ($2::uuid IS NULL OR t.lot_id=$2)
      AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM commerce.tire_stock_transfer_items i
        WHERE i.environment=t.environment AND i.transfer_id=t.id AND i.stock_id=$3))
  ), page AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $4), rows AS (
    SELECT page.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('stock_id',i.stock_id,'product_id',i.product_id,
      'quantity',i.quantity,'cost',i.cost,'measure',i.after_stock->>'measure',
      'brand',i.after_stock->>'brand','tire_condition',i.after_stock->>'tire_condition') ORDER BY i.stock_id)
      FROM commerce.tire_stock_transfer_items i WHERE i.environment=$1 AND i.transfer_id=page.id),'[]') items
    FROM page
  ) SELECT (SELECT count(*)::int FROM filtered) total,
    COALESCE((SELECT jsonb_agg(rows ORDER BY created_at DESC,id DESC) FROM rows),'[]') rows`,
  [env.FAREJADOR_ENV, filters.lot_id ?? null, filters.stock_id ?? null, ((filters.page ?? 1) - 1) * 25]);
  return result.rows[0];
}
