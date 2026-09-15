import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export interface TireLotFilters {
  search?: string; status?: 'all' | 'open' | 'pending' | 'closed' | 'cancelled'; page?: number;
}

// One statement gives rows, counts and inventory value from the same snapshot.
export async function listTireLots(filters: TireLotFilters = {}, db: Pool = defaultPool) {
  const result = await db.query(`WITH lots AS (
    SELECT l.*, 'LT-'||lpad(l.lot_number::text,6,'0') lot_code,
      CASE WHEN o.id IS NOT NULL THEN 'OC-'||to_char(o.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY')
        ||'-'||lpad(o.order_number::text,6,'0') ELSE left(p.id::text,8) END purchase_code,
      p.supplier_reference purchase_reference,p.status purchase_status,
      p.payment_status,p.stock_applied_at received_at,s.name supplier_name,
      l.quantity_on_hand-l.quantity_reserved available_quantity,
      COALESCE(l.accepted_quantity,0)-l.quantity_on_hand exited_quantity,
      l.allocated_cost/l.ordered_quantity unit_cost,
      CASE WHEN p.status='cancelled' THEN 'cancelled'
        WHEN l.accepted_quantity IS NULL THEN 'pending'
        WHEN l.quantity_on_hand=0 THEN 'closed' ELSE 'open' END status
    FROM commerce.tire_lots l
    LEFT JOIN commerce.wholesale_purchases p ON p.environment=l.environment AND p.id=l.purchase_id
    LEFT JOIN commerce.wholesale_purchase_orders o ON o.environment=p.environment AND o.id=p.purchase_order_id
    LEFT JOIN commerce.wholesale_suppliers s ON s.environment=p.environment AND s.id=p.supplier_id
    WHERE l.environment=$1
  ), filtered AS (
    SELECT * FROM lots WHERE ($2='all' OR status=$2)
      AND ($3='' OR strpos(lower(lot_code||' '||description||' '||COALESCE(purchase_code,'')),lower($3))>0)
  ), page AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $4)
  SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(page ORDER BY created_at DESC,id DESC) FROM page),'[]'),
    'total',(SELECT count(*) FROM filtered),'page_size',25,
    'summary',(SELECT jsonb_build_object('open_lots',count(*) FILTER (WHERE status='open'),
      'available_quantity',COALESCE(sum(available_quantity),0),'remaining_cost',COALESCE(sum(remaining_cost),0)) FROM lots),
    'as_of',now()) payload`,
  [env.FAREJADOR_ENV, filters.status ?? 'open', filters.search ?? '', ((filters.page ?? 1) - 1) * 25]);
  return result.rows[0].payload;
}

export async function listTireLotMovements(filters: { lot_id?: string; page?: number } = {}, db: Pool = defaultPool) {
  const result = await db.query(`WITH filtered AS (
    SELECT m.id,m.lot_id,m.source,m.quantity_delta,m.cost_delta,m.occurred_at,to_jsonb(m)->>'order_id' order_id,
      'LT-'||lpad(l.lot_number::text,6,'0') lot_code,
      CASE WHEN o.id IS NOT NULL THEN 'OC-'||to_char(o.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY')
        ||'-'||lpad(o.order_number::text,6,'0') ELSE left(p.id::text,8) END purchase_code
    FROM commerce.tire_lot_movements m
    JOIN commerce.tire_lots l ON l.environment=m.environment AND l.id=m.lot_id
    LEFT JOIN commerce.wholesale_purchases p ON p.environment=l.environment AND p.id=l.purchase_id
    LEFT JOIN commerce.wholesale_purchase_orders o ON o.environment=p.environment AND o.id=p.purchase_order_id
    WHERE m.environment=$1 AND ($2::uuid IS NULL OR m.lot_id=$2)
  ), page AS (SELECT * FROM filtered ORDER BY occurred_at DESC,id DESC LIMIT 25 OFFSET $3)
  SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(page ORDER BY occurred_at DESC,id DESC) FROM page),'[]'),
    'total',(SELECT count(*) FROM filtered),'page_size',25) payload`,
  [env.FAREJADOR_ENV, filters.lot_id ?? null, ((filters.page ?? 1) - 1) * 25]);
  return result.rows[0].payload;
}

export async function listLotSeparationSources(search: string, db: Pool = defaultPool) {
  const result = await db.query(`SELECT id,measure,brand,tire_condition,unit_cost,quantity_on_hand,
    quantity_on_hand-quantity_reserved available_quantity
    FROM commerce.wholesale_stock WHERE environment=$1 AND quantity_on_hand>quantity_reserved
      AND ($2='' OR strpos(lower(measure||' '||COALESCE(brand,'')),lower($2))>0)
    ORDER BY measure,brand,tire_condition LIMIT 50`, [env.FAREJADOR_ENV, search]);
  return { rows: result.rows };
}

export async function getTireLotPurchase(id: string, db: Pool = defaultPool) {
  const result = await db.query(`SELECT p.*,s.name supplier_name,s.deleted_at supplier_archived_at,
    CASE WHEN o.id IS NOT NULL THEN 'OC-'||to_char(o.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY')
      ||'-'||lpad(o.order_number::text,6,'0') END order_code,
    COALESCE((SELECT sum(COALESCE(i.accepted_quantity,i.quantity)) FROM commerce.wholesale_purchase_lines i
      WHERE i.environment=p.environment AND i.purchase_id=p.id),0)::int items_count,
    COALESCE((SELECT jsonb_agg(pi ORDER BY pi.installment_number) FROM commerce.wholesale_purchase_installments pi
      WHERE pi.environment=p.environment AND pi.purchase_id=p.id),'[]') installments,
    COALESCE((SELECT jsonb_agg(i) FROM commerce.wholesale_purchase_lines i
      WHERE i.environment=p.environment AND i.purchase_id=p.id),'[]') items
    FROM commerce.tire_lots l
    JOIN commerce.wholesale_purchases p ON p.environment=l.environment AND p.id=l.purchase_id
    JOIN commerce.wholesale_suppliers s ON s.environment=p.environment AND s.id=p.supplier_id
    LEFT JOIN commerce.wholesale_purchase_orders o ON o.environment=p.environment AND o.id=p.purchase_order_id
    WHERE l.environment=$1 AND l.id=$2`, [env.FAREJADOR_ENV, id]);
  return result.rows[0] ?? null;
}
