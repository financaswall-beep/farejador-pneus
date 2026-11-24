import type { Pool, PoolClient } from 'pg';
import { beginIntegrityOperation, completeIntegrityOperation, operationFingerprint,
  type MatrizEnvironment } from './stage5-integrity.js';
import { planOriginConfirmation, type OriginPlanRow, type OriginSelection } from './stock-origin-plan.js';

type Database = Pool | PoolClient;
export interface StockOriginFilters { orderIds?: string[]; stockId?: string; orderNumber?: string; pendingId?: string }
export interface StockOriginCandidate {
  candidate_id:string; location_code:string|null; group_id:string|null; model:string|null; matched_set:boolean;
  available:number; suggested_quantity:number;
}
export interface StockOriginPending {
  id:string; order_id:string|null; order_number:string; stock_id:string; product_id:string|null;
  product_name:string; brand:string; measure:string; quantity:number; status:'pending'; candidates:StockOriginCandidate[];
}
export interface ConfirmStockOriginInput {
  pending_id:string; selections:OriginSelection[]; idempotency_key:string;
}
export interface ConfirmedStockOrigin { id:string; status:'confirmed' }

function findOrderNumber(input?:string) {
  const raw=input?.trim().toUpperCase();
  if (!raw) return null;
  return /^\d+$/.test(raw) ? 'PED-'+raw.padStart(4,'0') : raw;
}

export async function listStockOriginPendings(db:Database,environment:MatrizEnvironment,filters:StockOriginFilters={}) {
  if (filters.orderIds && !filters.orderIds.length) return [];
  const {rows}=await db.query<StockOriginPending>(`WITH pend AS MATERIALIZED (
      SELECT p.*,o.order_number,pr.product_name,s.measure,s.brand
      FROM commerce.matriz_stock_origins p
      JOIN commerce.wholesale_stock s ON s.environment=p.environment AND s.id=p.stock_id
      LEFT JOIN commerce.orders o ON p.source='varejo' AND o.id=p.reference_id AND o.environment=p.environment
      LEFT JOIN commerce.products pr ON pr.environment=p.environment AND pr.id=p.product_id
      WHERE p.environment=$1 AND p.status='pending' AND p.snapshot_ready
        AND ($2::uuid[] IS NULL OR o.id=ANY($2::uuid[])) AND ($3::uuid IS NULL OR p.stock_id=$3)
        AND ($4::text IS NULL OR upper(coalesce(o.order_number,p.reference_id::text))=$4)
        AND ($5::uuid IS NULL OR p.id=$5)
    ), supply AS MATERIALIZED (
      SELECT s.stock_id,z.* FROM (SELECT DISTINCT stock_id FROM pend) s
      CROSS JOIN LATERAL commerce.matriz_stock_origin_supply($1,s.stock_id,false) z
    ) SELECT p.id,CASE WHEN p.source='varejo' THEN p.reference_id END order_id,
      coalesce(p.order_number,p.reference_id::text) order_number,p.stock_id,p.product_id,
      coalesce(p.product_name,p.brand||' '||p.measure) product_name,p.brand,p.measure,p.quantity,p.status,
      jsonb_agg(jsonb_build_object('candidate_id',c.id,'location_code',c.location_code,'group_id',c.group_id,
        'model',c.model,'matched_set',c.matched_set,'available',least(c.capacity,coalesce(z.capacity,0)),
        'suggested_quantity',c.suggested_quantity) ORDER BY c.suggested_quantity DESC,c.matched_set,c.location_code,c.id) candidates
    FROM pend p JOIN commerce.matriz_stock_origin_candidates c ON c.environment=p.environment AND c.origin_id=p.id
    LEFT JOIN supply z ON z.stock_id=p.stock_id AND z.group_id IS NOT DISTINCT FROM c.group_id
      AND z.location_code IS NOT DISTINCT FROM c.location_code
    GROUP BY p.id,p.source,p.reference_id,p.order_number,p.stock_id,p.product_id,p.product_name,p.brand,p.measure,
      p.quantity,p.status,p.created_at ORDER BY p.created_at,p.id`,
  [environment,filters.orderIds??null,filters.stockId??null,findOrderNumber(filters.orderNumber),filters.pendingId??null]);
  return rows;
}

export async function confirmStockOrigin(db:Database,environment:MatrizEnvironment,input:ConfirmStockOriginInput,
  actor:string,expectedOrderId?:string):Promise<ConfirmedStockOrigin> {
  const local='connect'in db && !('release'in db);
  const client=local?await (db as Pool).connect():db as PoolClient;
  try {
    if(local) await client.query('BEGIN');
    const {rows:[origin]}=await client.query<{stock_id:string}>(`SELECT stock_id FROM commerce.matriz_stock_origins
      WHERE environment=$1 AND id=$2 AND ($3::uuid IS NULL OR (source='varejo' AND reference_id=$3))`,
    [environment,input.pending_id,expectedOrderId??null]);
    if(!origin) throw new Error('stock_origin_not_found');
    if(!Array.isArray(input.selections)||!input.selections.length) throw new Error('stock_origin_invalid');
    const selections=[...input.selections].sort((a,b)=>a.candidate_id.localeCompare(b.candidate_id));
    const operation={environment,domain:'stock.origin.confirm',idempotencyKey:input.idempotency_key,
      fingerprint:operationFingerprint({id:input.pending_id,selections})};
    const previous=await beginIntegrityOperation<ConfirmedStockOrigin>(client,operation);
    if(previous.replayed) {
      if(local) await client.query('COMMIT');
      return previous.result;
    }
    await client.query('SELECT id FROM commerce.wholesale_stock WHERE environment=$1 AND id=$2 FOR UPDATE',
      [environment,origin.stock_id]);
    const pending=await client.query(`SELECT 1 FROM commerce.matriz_stock_origins WHERE environment=$1 AND id=$2
      AND status='pending' AND snapshot_ready FOR UPDATE`,[environment,input.pending_id]);
    if(!pending.rowCount) throw new Error('stock_origin_changed');
    const plan=await client.query<OriginPlanRow>(`WITH supply AS MATERIALIZED (
      SELECT * FROM commerce.matriz_stock_origin_supply($1,$2,false)
    ) SELECT p.id origin_id,p.quantity,c.id candidate_id,c.group_id,c.location_code,c.suggested_quantity,
      c.capacity,coalesce(s.capacity,0) supply
    FROM commerce.matriz_stock_origins p JOIN commerce.matriz_stock_origin_candidates c
      ON c.environment=p.environment AND c.origin_id=p.id
    LEFT JOIN supply s ON s.group_id IS NOT DISTINCT FROM c.group_id AND s.location_code IS NOT DISTINCT FROM c.location_code
    WHERE p.environment=$1 AND p.stock_id=$2 AND p.status='pending' AND p.snapshot_ready
    ORDER BY p.created_at,p.id,c.suggested_quantity DESC,c.matched_set,c.location_code,c.id`,[environment,origin.stock_id]);
    const changes=planOriginConfirmation(plan.rows,input.pending_id,selections);
    if(changes.length) {
      // Evita inverter a ordem dos locks se um dos pedidos estiver sendo cancelado/editado.
      await client.query(`SELECT o.id FROM commerce.orders o WHERE o.environment=$1 AND EXISTS (
        SELECT 1 FROM commerce.matriz_stock_origins p JOIN commerce.matriz_stock_origin_candidates c
          ON c.environment=p.environment AND c.origin_id=p.id WHERE p.environment=o.environment
            AND p.reference_id=o.id AND p.source='varejo' AND c.id=ANY($2::uuid[]))
        ORDER BY o.id FOR KEY SHARE NOWAIT`,[environment,changes.map(v=>v.candidate_id)]);
    }
    for(const change of changes) {
      await client.query('SELECT commerce.shift_matriz_origin_candidate($1,$2,$3,$4)',
        [environment,change.candidate_id,change.delta,actor]);
    }
    await client.query(`UPDATE commerce.matriz_stock_origin_candidates SET confirmed_quantity=suggested_quantity
      WHERE environment=$1 AND origin_id=$2`,[environment,input.pending_id]);
    await client.query(`UPDATE commerce.matriz_stock_origins SET status='confirmed',actor_label=$3,resolved_at=clock_timestamp()
      WHERE environment=$1 AND id=$2`,[environment,input.pending_id,actor]);
    const result:ConfirmedStockOrigin={id:input.pending_id,status:'confirmed'};
    await completeIntegrityOperation(client,operation,'commerce.matriz_stock_origins',input.pending_id,result);
    if(local) await client.query('COMMIT');
    return result;
  } catch(error) {
    if(local) await client.query('ROLLBACK').catch(()=>undefined);
    if((error as {code?:string}).code==='55P03') throw new Error('stock_origin_changed');
    throw error;
  } finally { if(local) client.release(); }
}
