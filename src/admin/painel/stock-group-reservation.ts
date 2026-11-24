import type { PoolClient } from 'pg';
import type { MatrizEnvironment } from './stage5-integrity.js';
import type { TireCondition } from '../../shared/tire-condition.js';

export interface MatrizStockGroupOffer {
  groupId: string;
  productId: string;
  quantity: number;
  revision: string;
}

interface Variant {
  measure: string;
  brand: string;
  tire_condition: TireCondition;
  qty: number;
}

interface PositionAllocation {
  group_id: string;
  model: string;
  product_id: string;
  location_code: string;
  available: number;
  ordered: number;
}

export interface GroupOrderItem { productId: string; quantity: number }

export async function loadGroupOrderItems(client: PoolClient, environment: MatrizEnvironment, orderId: string) {
  return (await client.query<GroupOrderItem>(`SELECT product_id AS "productId",sum(quantity)::int quantity
    FROM commerce.order_items WHERE environment=$1 AND order_id=$2 GROUP BY product_id`,[environment,orderId])).rows;
}

/** A variante já está travada pelo plano oficial. Captura as opções antes da reserva provisória das pilhas. */
export async function reserveMatrizStockGroupPositions(client: PoolClient, environment: MatrizEnvironment, orderId: string,
  variant: Variant, offer: MatrizStockGroupOffer | undefined, items: GroupOrderItem[]) {
  const quantities=new Map<string,number>();
  for (const item of items) quantities.set(item.productId,(quantities.get(item.productId)??0)+item.quantity);
  const demand=JSON.stringify([...quantities].map(([product_id,quantity])=>({product_id,quantity})));
  let stockId: string | undefined;
  if (!offer) {
    const captured=await client.query<{id:string}>(`SELECT s.id,
        commerce.capture_matriz_stock_origin(s.environment,s.id,$5,'reservation',$6,$7::jsonb)
      FROM commerce.wholesale_stock s WHERE s.environment=$1 AND s.measure=$2 AND s.brand=$3 AND s.tire_condition=$4
        AND s.vehicle_type IS DISTINCT FROM 'motorcycle' AND EXISTS (
          SELECT 1 FROM commerce.matriz_stock_groups g WHERE g.environment=s.environment AND g.stock_id=s.id
            AND g.inspection_status='approved' AND g.matched_set)`,
    [environment,variant.measure,variant.brand,variant.tire_condition,orderId,variant.qty,demand]);
    stockId=captured.rows[0]?.id;
  }
  await allocatePositions(client,environment,orderId,variant,offer,demand);
  if (stockId) {
    await client.query("SELECT commerce.snapshot_matriz_stock_origin($1,$2,$3,'reservation')",[environment,stockId,orderId]);
  }
}

async function allocatePositions(client: PoolClient, environment: MatrizEnvironment, orderId: string,
  variant: Variant, offer: MatrizStockGroupOffer | undefined, demand: string) {
  const key=[environment,variant.measure,variant.brand,variant.tire_condition];
  let needed=variant.qty;
  if (offer) {
    const { rows }=await client.query<{ product_id: string; revision: string; eligible: boolean }>(`SELECT g.product_id,g.revision::text,
      (g.inspection_status='approved' AND (g.matched_set OR $6=1) AND NOT commerce.matriz_stock_origin_uncertain(g.environment,g.id)
        AND p.deleted_at IS NULL AND p.product_type='tire' AND NOT p.partner_generic AND ts.vehicle_type='car'
        AND s.vehicle_type IS DISTINCT FROM 'motorcycle'
        AND p.tire_condition=s.tire_condition AND commerce.catalog_brand_identity(p.brand)=commerce.catalog_brand_identity(s.brand)
        AND commerce.matriz_stock_group_model_matches(g.model,ts.tread_pattern)
        AND regexp_replace(ts.tire_size,'[^0-9]','','g')=regexp_replace(s.measure,'[^0-9]','','g')
        AND (SELECT COALESCE(sum(i.quantity),0) FROM commerce.order_items i
          WHERE i.environment=g.environment AND i.order_id=$7 AND i.product_id=g.product_id)=$6) eligible
      FROM commerce.matriz_stock_groups g JOIN commerce.wholesale_stock s ON s.environment=g.environment AND s.id=g.stock_id
      JOIN commerce.products p ON p.environment=g.environment AND p.id=g.product_id
      JOIN commerce.tire_specs ts ON ts.environment=g.environment AND ts.product_id=g.product_id
      WHERE s.environment=$1 AND s.measure=$2 AND s.brand=$3 AND s.tire_condition=$4 AND g.id=$5 FOR UPDATE OF g`,[
      ...key,offer.groupId,offer.quantity,orderId,
    ]);
    if (!rows[0] || rows[0].product_id!==offer.productId || !rows[0].eligible || offer.quantity!==variant.qty) {
      throw new Error('stock_group_unavailable');
    }
    if (rows[0].revision!==offer.revision) throw new Error('stock_group_offer_changed');
  } else {
    const { rows }=await client.query<{ free: number }>(`SELECT (s.quantity_on_hand-s.quantity_reserved-COALESCE((
      SELECT sum(p.quantity_on_hand-p.quantity_reserved) FROM commerce.matriz_stock_groups g
      JOIN commerce.matriz_stock_group_positions p ON p.environment=g.environment AND p.group_id=g.id
      WHERE g.environment=s.environment AND g.stock_id=s.id),0))::int free
      FROM commerce.wholesale_stock s WHERE s.environment=$1 AND s.measure=$2 AND s.brand=$3 AND s.tire_condition=$4`,key);
    // Sem grupos, o saldo agregado já foi validado pelo plano existente.
    needed-=rows[0]?.free??variant.qty;
  }
  if (needed<=0) return;
  const { rows }=await client.query<PositionAllocation>(`SELECT g.id group_id,g.model,g.product_id,p.location_code,
    (p.quantity_on_hand-p.quantity_reserved)::int available,d.quantity ordered
    FROM commerce.matriz_stock_groups g JOIN commerce.wholesale_stock s ON s.environment=g.environment AND s.id=g.stock_id
    JOIN commerce.matriz_stock_group_positions p ON p.environment=g.environment AND p.group_id=g.id
    JOIN jsonb_to_recordset($6::jsonb) AS d(product_id uuid,quantity int) ON d.product_id=g.product_id AND d.quantity>0
    WHERE s.environment=$1 AND s.measure=$2 AND s.brand=$3 AND s.tire_condition=$4
      AND g.inspection_status IN ('located','approved') AND p.quantity_on_hand>p.quantity_reserved
      AND NOT EXISTS(SELECT 1 FROM commerce.tire_specs ts WHERE ts.environment=g.environment AND ts.product_id=g.product_id
        AND NOT commerce.matriz_stock_group_model_matches(g.model,ts.tread_pattern))
      AND ($5::uuid IS NULL OR g.id=$5)
    ORDER BY commerce.matriz_stock_active_set(g.environment,g.id),g.id,p.location_code FOR UPDATE OF p`,
  [...key,offer?.groupId??null,demand]);
  if (rows.reduce((total,row)=>total+row.available,0)<needed) throw new Error(offer?'stock_group_unavailable':'stock_group_protected');
  const assigned = new Map<string,number>();
  for (const row of rows) {
    const alreadyAssigned=assigned.get(row.product_id)??0;
    const quantity=Math.min(needed,row.available,row.ordered-alreadyAssigned);
    if (quantity<=0) continue;
    await client.query(`UPDATE commerce.matriz_stock_group_positions SET quantity_reserved=quantity_reserved+$4
      WHERE environment=$1 AND group_id=$2 AND location_code=$3`,[environment,row.group_id,row.location_code,quantity]);
    const assignedPosition=await client.query(`INSERT INTO commerce.matriz_stock_group_allocations
      (environment,order_id,group_id,product_id,location_code,model,quantity,status,specific_offer)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8)
      ON CONFLICT (environment,order_id,group_id,location_code) DO UPDATE
        SET quantity=EXCLUDED.quantity,model=EXCLUDED.model,status='reserved',finalized_at=NULL,created_at=clock_timestamp()
        WHERE matriz_stock_group_allocations.status='released' AND NOT matriz_stock_group_allocations.specific_offer`,
    [environment,orderId,row.group_id,row.product_id,row.location_code,row.model,quantity,Boolean(offer)]);
    if (assignedPosition.rowCount!==1) throw new Error('stock_group_reservation_mismatch');
    await client.query(`INSERT INTO commerce.matriz_stock_group_movements
      (environment,group_id,order_id,reference,movement_type,from_location,quantity,actor_label,detail)
      VALUES ($1,$2,$3::uuid,$3::uuid::text,'reserve',$4,$5,'matriz-pedido',jsonb_build_object('specific_offer',$6::boolean))`,[
      environment,row.group_id,orderId,row.location_code,quantity,Boolean(offer),
    ]);
    needed-=quantity;
    assigned.set(row.product_id,alreadyAssigned+quantity);
    if (!needed) break;
  }
  if (needed>0) throw new Error(offer?'stock_group_unavailable':'stock_group_protected');
}

/** O pedido já está travado pela realização/cancelamento. Trava saldo em ordem igual à criação. */
async function lockVariants(client: PoolClient, environment: MatrizEnvironment, variants: Variant[]) {
  return client.query<{id:string}>(`SELECT s.id FROM commerce.wholesale_stock s
    WHERE s.environment=$1 AND (s.measure,s.brand,s.tire_condition) IN (
      SELECT v.measure,v.brand,v.tire_condition FROM jsonb_to_recordset($2::jsonb) AS v(measure text,brand text,tire_condition text)
    ) ORDER BY s.measure,s.brand,s.tire_condition FOR UPDATE`,[environment,JSON.stringify(variants)]);
}

export async function finalizeMatrizStockGroupPositions(client: PoolClient, environment: MatrizEnvironment, orderId: string,
  variants: Variant[], consume: boolean, actor = consume?'matriz-realizacao':'matriz-cancel') {
  await lockVariants(client,environment,variants);
  const { rows }=await client.query<{ group_id: string; location_code: string; quantity: number }>(`UPDATE commerce.matriz_stock_group_allocations
    SET status=$3,finalized_at=clock_timestamp() WHERE environment=$1 AND order_id=$2 AND status='reserved'
    RETURNING group_id,location_code,quantity`,[environment,orderId,consume?'consumed':'released']);
  for (const row of rows) {
    const result=await client.query(`UPDATE commerce.matriz_stock_group_positions
      SET quantity_reserved=quantity_reserved-$4,quantity_on_hand=quantity_on_hand-$5
      WHERE environment=$1 AND group_id=$2 AND location_code=$3 AND quantity_reserved >= $4`,[
      environment,row.group_id,row.location_code,row.quantity,consume?row.quantity:0,
    ]);
    if (result.rowCount!==1) throw new Error('stock_group_reservation_mismatch');
    await client.query(`INSERT INTO commerce.matriz_stock_group_movements
      (environment,group_id,order_id,reference,movement_type,from_location,quantity,actor_label,detail)
      VALUES ($1,$2,$3::uuid,$3::uuid::text,$4,$5,$6,$7,jsonb_build_object('source','varejo'))`,[
      environment,row.group_id,orderId,consume?'consume':'release',row.location_code,row.quantity,
      actor,
    ]);
  }
  await client.query('SELECT commerce.finish_matriz_stock_origin_reservation($1,$2,$3)',[environment,orderId,consume]);
}

/** Alterar um conjunto reservado exige nova conferência da oferta e novo aceite. */
export async function guardMatrizGroupOrderEdit(client: PoolClient, environment: MatrizEnvironment, orderId: string) {
  const { rows }=await client.query(`SELECT 1 FROM commerce.matriz_stock_group_allocations
    WHERE environment=$1 AND order_id=$2 AND status='reserved' AND specific_offer LIMIT 1`,[environment,orderId]);
  if (rows.length) throw new Error('stock_group_not_editable');
}

export async function reallocateMatrizGroupOrderIfNeeded(client: PoolClient, environment: MatrizEnvironment, orderId: string,
  previous: Variant[], next: Variant[], desired: GroupOrderItem[]) {
  const locks=await lockVariants(client,environment,[...previous,...next]);
  const affected=await client.query(`SELECT 1 FROM commerce.matriz_stock_groups
    WHERE environment=$1 AND stock_id=ANY($2::uuid[]) LIMIT 1`,[environment,locks.rows.map(row=>row.id)]);
  if (!affected.rows.length) return false;
  await guardMatrizGroupOrderEdit(client,environment,orderId);
  await finalizeMatrizStockGroupPositions(client,environment,orderId,previous,false,'matriz-edicao');
  for (const row of previous) await adjustGroupOrderAggregate(client,environment,row,-row.qty);
  for (const row of next) {
    await reserveMatrizStockGroupPositions(client,environment,orderId,row,undefined,desired);
    await adjustGroupOrderAggregate(client,environment,row,row.qty);
  }
  return true;
}

async function adjustGroupOrderAggregate(client: PoolClient, environment: MatrizEnvironment, row: Variant, delta: number) {
  const updated=await client.query(`UPDATE commerce.wholesale_stock SET quantity_reserved=quantity_reserved+$5
    WHERE environment=$1 AND measure=$2 AND brand=$3 AND tire_condition=$4
      AND quantity_reserved+$5 BETWEEN 0 AND quantity_on_hand RETURNING measure`,
  [environment,row.measure,row.brand,row.tire_condition,delta]);
  if (updated.rowCount!==1) throw new Error('stock_reservation_insufficient');
}
