import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { VehicleReportFilter } from '../../shared/tire-vehicle-type.js';

// Physical inventory only. One snapshot prevents a separation from being counted twice.
export async function getStockCosts(db: Pool = defaultPool, vehicleType: VehicleReportFilter = 'all') {
  const result = await db.query(`WITH variants AS (
    SELECT id,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,
      quantity_on_hand-quantity_reserved quantity_available,unit_cost,
      commerce.stock_vehicle_type(environment,measure,brand,tire_condition) vehicle_type,
      round(quantity_on_hand*unit_cost,2) capital
    FROM commerce.wholesale_stock WHERE environment=$1 AND quantity_on_hand>0
      AND ($2='all' OR COALESCE(commerce.stock_vehicle_type(environment,measure,brand,tire_condition),'unknown')=$2)
  ), catalog AS (
    SELECT measure||':'||tire_condition||':'||COALESCE(vehicle_type,'unknown') AS key,measure,tire_condition,vehicle_type,
      sum(quantity_on_hand) quantity_on_hand,sum(quantity_reserved) quantity_reserved,
      sum(quantity_available) quantity_available,sum(capital) capital,
      round(sum(quantity_on_hand*unit_cost)/sum(quantity_on_hand),6) unit_cost,
      COALESCE(sum(quantity_on_hand) FILTER (WHERE unit_cost=0),0) zero_cost_quantity,
      jsonb_agg(variants ORDER BY brand,id) variants
    FROM variants GROUP BY measure,tire_condition,vehicle_type
  ), lots AS (
    SELECT l.id,'LT-'||lpad(l.lot_number::text,6,'0') lot_code,l.description,
      l.vehicle_type,l.quantity_on_hand,l.quantity_reserved,l.quantity_on_hand-l.quantity_reserved quantity_available,
      l.remaining_cost capital,l.allocated_cost/l.ordered_quantity unit_cost,
      l.created_at,CASE WHEN l.remaining_cost=0 THEN l.quantity_on_hand ELSE 0 END zero_cost_quantity
    FROM commerce.tire_lots l
    LEFT JOIN commerce.wholesale_purchases p ON p.environment=l.environment AND p.id=l.purchase_id
    WHERE l.environment=$1 AND l.accepted_quantity IS NOT NULL AND l.quantity_on_hand>0
      AND ($2='all' OR COALESCE(l.vehicle_type,'unknown')=$2)
      AND p.status IS DISTINCT FROM 'cancelled'
  ), catalog_summary AS (
    SELECT COALESCE(sum(capital),0) capital,COALESCE(sum(quantity_on_hand),0) quantity,
      COALESCE(sum(zero_cost_quantity),0) zero_cost_quantity FROM catalog
  ), lot_summary AS (
    SELECT COALESCE(sum(capital),0) capital,COALESCE(sum(quantity_on_hand),0) quantity,
      COALESCE(sum(zero_cost_quantity),0) zero_cost_quantity,count(*) open_lots FROM lots
  ) SELECT jsonb_build_object(
    'catalog',COALESCE((SELECT jsonb_agg(catalog ORDER BY capital DESC,measure,tire_condition) FROM catalog),'[]'),
    'lots',COALESCE((SELECT jsonb_agg(lots ORDER BY created_at,id) FROM lots),'[]'),
    'summary',jsonb_build_object('capital',c.capital+l.capital,'quantity',c.quantity+l.quantity,
      'catalog_capital',c.capital,'catalog_quantity',c.quantity,'lot_capital',l.capital,
      'lot_quantity',l.quantity,'open_lots',l.open_lots,'zero_cost_quantity',c.zero_cost_quantity+l.zero_cost_quantity),
    'as_of',now()) payload FROM catalog_summary c CROSS JOIN lot_summary l`, [env.FAREJADOR_ENV, vehicleType]);
  return result.rows[0].payload;
}
