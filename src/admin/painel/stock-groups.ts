import type { Pool, PoolClient } from 'pg';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { beginIntegrityOperation, completeIntegrityOperation, integrityResult, operationFingerprint, type MatrizEnvironment } from './stage5-integrity.js';
import { tireSizeKey } from '../../shared/tire-size.js';
import type { TireCondition } from '../../shared/tire-condition.js';

type Database = Pool | PoolClient;
type InspectionStatus = 'located' | 'pending' | 'approved' | 'blocked';
type ConservationGrade = 'selecionado' | 'economico';
interface PositionCount { location_code: string; quantity_on_hand: number; quantity_reserved: number; confirmed_at: string }
export interface MatrizStockGroup {
  group_id: string;
  stock_id: string;
  product_id: string;
  measure: string;
  brand: string;
  tire_condition: TireCondition;
  model: string | null;
  inspection_status: InspectionStatus;
  matched_set: boolean;
  conservation_note: string | null;
  conservation_grade: ConservationGrade | null;
  conferred_at: string;
  revision: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  positions: PositionCount[];
}

export interface SaveMatrizStockGroupInput {
  group_id?: string;
  revision?: string;
  stock_id: string;
  product_id: string;
  model?: string | null;
  inspection_status: InspectionStatus;
  matched_set?: boolean;
  conservation_note?: string | null;
  conservation_grade?: ConservationGrade | null;
  positions?: Array<{ location_code: string; quantity: number }>;
  reason: string;
  idempotency_key: string;
}

export interface MoveMatrizStockGroupInput {
  group_id: string;
  revision: string;
  from_location: string | null;
  to_location: string | null;
  quantity: number;
  reason: string;
  idempotency_key: string;
}

const groupColumns = `g.id group_id,g.stock_id,g.product_id,s.measure,s.brand,s.tire_condition,
    g.model,g.inspection_status,g.matched_set,g.conservation_note,g.conservation_grade,g.conferred_at,g.revision::text,
    COALESCE(pos.physical,0)::int quantity_on_hand,COALESCE(pos.reserved,0)::int quantity_reserved,
    COALESCE(pos.physical-pos.reserved,0)::int quantity_available,COALESCE(pos.positions,'[]') positions`;

const groupTables = `FROM commerce.matriz_stock_groups g
  JOIN commerce.wholesale_stock s ON s.environment=g.environment AND s.id=g.stock_id
  LEFT JOIN LATERAL (
    SELECT sum(p.quantity_on_hand) physical,sum(p.quantity_reserved) reserved,
      jsonb_agg(jsonb_build_object('location_code',p.location_code,
        'quantity_on_hand',p.quantity_on_hand,'quantity_reserved',p.quantity_reserved,'confirmed_at',p.confirmed_at)
        ORDER BY p.location_code) positions
    FROM commerce.matriz_stock_group_positions p
    WHERE p.environment=g.environment AND p.group_id=g.id AND p.quantity_on_hand>0
  ) pos ON TRUE`;

export async function listMatrizStockGroups(db: Database, environment: MatrizEnvironment, stockId?: string) {
  return (await db.query<MatrizStockGroup>(`SELECT ${groupColumns} ${groupTables}
    WHERE g.environment=$1 AND ($2::uuid IS NULL OR g.stock_id=$2)
    ORDER BY s.measure,s.brand,s.tire_condition,g.model,g.id`,[environment,stockId??null])).rows;
}

export async function listAvailableMatrizStockGroups(db: Database, environment: MatrizEnvironment, input: {
  measure: string; quantity: number; brand?: string; tireCondition?: TireCondition;
  productIds?: string[]; groupId?: string;
}) {
  const measureKey = tireSizeKey(input.measure).replace(/-/g,'');
  if (!measureKey || !validQuantity(input.quantity)) return [];
  type Offer = Pick<MatrizStockGroup,'group_id'|'product_id'|'measure'|'brand'|'tire_condition'|'model'|'conservation_grade'|'revision'|'quantity_available'>;
  return (await db.query<Offer>(`SELECT g.id group_id,g.product_id,s.measure,s.brand,s.tire_condition,
    g.model,g.conservation_grade,g.revision::text,(pos.physical-pos.reserved)::int quantity_available ${groupTables}
    JOIN commerce.products p ON p.environment=g.environment AND p.id=g.product_id
    JOIN commerce.tire_specs ts ON ts.environment=g.environment AND ts.product_id=g.product_id
    WHERE g.environment=$1 AND regexp_replace(s.measure,'[^0-9]','','g')=$2
      AND g.inspection_status='approved' AND ($3=1 OR g.matched_set)
      AND pos.physical-pos.reserved >= $3 AND s.unit_cost>0 AND s.vehicle_type IS DISTINCT FROM 'motorcycle'
      AND ($4::text IS NULL OR commerce.catalog_brand_identity(s.brand)=commerce.catalog_brand_identity($4))
      AND ($5::text IS NULL OR s.tire_condition=$5)
      AND ($6::uuid[] IS NULL OR g.product_id=ANY($6)) AND ($7::uuid IS NULL OR g.id=$7)
      AND p.product_type='tire' AND NOT p.partner_generic AND p.deleted_at IS NULL AND ts.vehicle_type='car'
      AND regexp_replace(ts.tire_size,'[^0-9]','','g')=$2 AND p.tire_condition=s.tire_condition
      AND commerce.catalog_brand_identity(p.brand)=commerce.catalog_brand_identity(s.brand)
      AND commerce.matriz_stock_group_model_matches(g.model,ts.tread_pattern)
    ORDER BY pos.physical-pos.reserved DESC,g.id`,[
    environment,measureKey,input.quantity,canonicalCatalogBrand(input.brand),input.tireCondition??null,input.productIds??null,input.groupId??null,
  ])).rows;
}

function validQuantity(quantity: number) {
  return Number.isInteger(quantity) && quantity>0 && quantity<=1_000_000;
}

function normalizedLocation(location: string) {
  const clean = location.trim().toUpperCase();
  if (!clean || clean.length>60) throw new Error('stock_group_invalid_positions');
  return clean;
}

function checkReason(value: string) {
  const reason = value.trim();
  if (reason.length<2 || reason.length>500) throw new Error('reason_required');
  return reason;
}

type LockedGroup = Pick<MatrizStockGroup,'group_id'|'stock_id'|'product_id'|'model'|'inspection_status'|'matched_set'|'revision'>;

async function groupById(db: Database, environment: MatrizEnvironment, groupId: string) {
  const { rows } = await db.query<MatrizStockGroup>(`SELECT ${groupColumns} ${groupTables}
    WHERE g.environment=$1 AND g.id=$2`,[environment,groupId]);
  if (!rows[0]) throw new Error('stock_group_not_found');
  return rows[0];
}

async function lockGroup(db: PoolClient, environment: MatrizEnvironment, groupId: string, revision: string | undefined) {
  // Locks seguem a mesma ordem dos fluxos de estoque: primeiro variante, depois grupo/posições.
  const stock = await db.query(`SELECT s.id FROM commerce.wholesale_stock s JOIN commerce.matriz_stock_groups g
     ON g.environment=s.environment AND g.stock_id=s.id WHERE g.environment=$1 AND g.id=$2 FOR UPDATE OF s`,[environment,groupId]);
  if (!stock.rows[0]) throw new Error('stock_group_not_found');
  const { rows }=await db.query<LockedGroup>(`SELECT id group_id,stock_id,product_id,model,inspection_status,matched_set,revision::text
    FROM commerce.matriz_stock_groups WHERE environment=$1 AND id=$2 FOR UPDATE`,[environment,groupId]);
  const group=rows[0];
  if (!group) throw new Error('stock_group_not_found');
  if (group.revision!==revision) throw new Error('stock_group_offer_changed');
  return group;
}

async function requireProduct(db: PoolClient, environment: MatrizEnvironment, stockId: string, productId: string, model: string|null = null) {
  const { rows } = await db.query<{model_matches:boolean}>(`SELECT commerce.matriz_stock_group_model_matches($4,ts.tread_pattern) model_matches
    FROM commerce.wholesale_stock s
    JOIN commerce.products p ON p.environment=s.environment AND p.id=$3
    JOIN commerce.tire_specs ts ON ts.environment=p.environment AND ts.product_id=p.id
    WHERE s.environment=$1 AND s.id=$2 AND p.product_type='tire' AND NOT p.partner_generic
      AND p.deleted_at IS NULL AND ts.vehicle_type='car' AND s.vehicle_type IS DISTINCT FROM 'motorcycle'
      AND regexp_replace(ts.tire_size,'[^0-9]','','g')=regexp_replace(s.measure,'[^0-9]','','g')
      AND commerce.catalog_brand_identity(p.brand)=commerce.catalog_brand_identity(s.brand)
      AND p.tire_condition=s.tire_condition FOR UPDATE OF s`,[environment,stockId,productId,model]);
  if (!rows[0]) throw new Error('stock_group_product_mismatch');
  if (!rows[0].model_matches) throw new Error('stock_group_product_mismatch');
}

async function requireUngrouped(db: PoolClient, environment: MatrizEnvironment, stockId: string, quantity: number) {
  const { rows } = await db.query<{ free: number }>(`SELECT (s.quantity_on_hand-s.quantity_reserved-COALESCE((
    SELECT sum(p.quantity_on_hand-p.quantity_reserved) FROM commerce.matriz_stock_groups g
    JOIN commerce.matriz_stock_group_positions p ON p.environment=g.environment AND p.group_id=g.id
    WHERE g.environment=s.environment AND g.stock_id=s.id),0))::int free
    FROM commerce.wholesale_stock s WHERE s.environment=$1 AND s.id=$2`,[environment,stockId]);
  if (!rows[0] || rows[0].free<quantity) throw new Error('stock_group_protected');
}

async function addPosition(db: PoolClient, environment: MatrizEnvironment, groupId: string, location: string, quantity: number) {
  await db.query(`INSERT INTO commerce.matriz_stock_group_positions(environment,group_id,location_code,quantity_on_hand)
    VALUES ($1,$2,$3,$4) ON CONFLICT(environment,group_id,location_code)
      DO UPDATE SET quantity_on_hand=matriz_stock_group_positions.quantity_on_hand+EXCLUDED.quantity_on_hand,
        confirmed_at=clock_timestamp()`,
  [environment,groupId,location,quantity]);
}

async function runGroupOperation(db: Database, environment: MatrizEnvironment, domain: string,
  input: { idempotency_key: string }, work: (client: PoolClient) => Promise<string>) {
  const localTransaction='connect'in db && !('release'in db);
  const client = localTransaction ? await (db as Pool).connect() : db as PoolClient;
  try {
    if (localTransaction) await client.query('BEGIN');
    const op={environment,domain,idempotencyKey:input.idempotency_key,fingerprint:operationFingerprint(input)};
    const start=await beginIntegrityOperation<MatrizStockGroup>(client,op);
    let result: MatrizStockGroup;
    if (start.replayed) result=start.result;
    else {
      const id=await work(client);
      result=integrityResult(await groupById(client,environment,id));
      await completeIntegrityOperation(client,op,'commerce.matriz_stock_groups',id,result);
    }
    if (localTransaction) await client.query('COMMIT');
    return result;
  } catch (error) {
    if (localTransaction) await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally {
    if (localTransaction) client.release();
  }
}

export async function saveMatrizStockGroup(db: Database, environment: MatrizEnvironment, raw: SaveMatrizStockGroupInput, actor: string) {
  const input = {...raw,model:raw.model===undefined?undefined:raw.model?.trim()||null,reason:checkReason(raw.reason),
    conservation_note:raw.conservation_note===undefined?undefined:raw.conservation_note?.trim()||null,
    positions:raw.positions?.map(p=>({...p,location_code:normalizedLocation(p.location_code)}))
      .sort((left,right)=>left.location_code.localeCompare(right.location_code)),
  };
  if ((input.model?.length??0)>120 || (input.matched_set===true && input.inspection_status!=='approved')
    || (input.conservation_note?.length??0)>500
    || (input.conservation_grade!=null && (input.inspection_status!=='approved'||!['selecionado','economico'].includes(input.conservation_grade)))
    || !['located','pending','approved','blocked'].includes(input.inspection_status)) throw new Error('stock_group_invalid_inspection');
  if (input.group_id ? input.positions!==undefined : !input.positions?.length) throw new Error('stock_group_invalid_positions');
  const positions=input.positions??[];
  if (positions.length>100 || positions.some(p=>!validQuantity(p.quantity))
    || new Set(positions.map(p=>p.location_code)).size!==positions.length) throw new Error('stock_group_invalid_positions');
  return runGroupOperation(db,environment,'stock.group.save',input,async client=>{
    let groupId=input.group_id;
    if (groupId) {
      const group=await lockGroup(client,environment,groupId,input.revision);
      if (group.stock_id!==input.stock_id || group.product_id!==input.product_id) throw new Error('stock_group_product_mismatch');
      const before=await groupById(client,environment,groupId);
      if (before.quantity_reserved>0) throw new Error('stock_group_not_editable');
      const model=input.model===undefined?before.model:input.model;
      const note=input.conservation_note===undefined?before.conservation_note:input.conservation_note;
      const staysApproved=before.inspection_status==='approved' && input.inspection_status==='approved';
      const matched=input.inspection_status==='approved' && (input.matched_set??(staysApproved&&before.matched_set));
      const grade=input.inspection_status==='approved'
        ? (input.conservation_grade===undefined&&staysApproved?before.conservation_grade:input.conservation_grade??null) : null;
      if (matched&&!model) throw new Error('stock_group_invalid_inspection');
      // É possível suspender ou desclassificar um grupo após mudança no catálogo.
      await requireProduct(client,environment,input.stock_id,input.product_id,input.inspection_status==='approved'?model:null);
      await client.query(`UPDATE commerce.matriz_stock_groups SET model=$3,inspection_status=$4,matched_set=$5,
        conservation_note=$6,conservation_grade=$7,revision=revision+1,conferred_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE environment=$1 AND id=$2`,[
        environment,groupId,model,input.inspection_status,matched,note,grade,
      ]);
    } else {
      if (input.matched_set&&!input.model) throw new Error('stock_group_invalid_inspection');
      await requireProduct(client,environment,input.stock_id,input.product_id,input.model??null);
      await requireUngrouped(client,environment,input.stock_id,positions.reduce((total,p)=>total+p.quantity,0));
      const { rows }=await client.query<{id:string}>(`INSERT INTO commerce.matriz_stock_groups
        (environment,stock_id,product_id,model,inspection_status,matched_set,conservation_note,conservation_grade)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[
        environment,input.stock_id,input.product_id,input.model??null,input.inspection_status,input.matched_set??false,input.conservation_note??null,
        input.conservation_grade??null,
      ]);
      groupId=rows[0]!.id;
      for (const position of positions) await addPosition(client,environment,groupId,position.location_code,position.quantity);
    }
    await client.query(`INSERT INTO commerce.matriz_stock_group_movements(environment,group_id,movement_type,reason,actor_label,detail)
      VALUES ($1,$2,'inspect',$3,$4,$5::jsonb)`,[environment,groupId,input.reason,actor,JSON.stringify(input)]);
    return groupId;
  });
}

export async function moveMatrizStockGroup(db: Database, environment: MatrizEnvironment, raw: MoveMatrizStockGroupInput, actor: string) {
  const input={...raw,reason:checkReason(raw.reason),
    from_location:raw.from_location===null?null:normalizedLocation(raw.from_location),
    to_location:raw.to_location===null?null:normalizedLocation(raw.to_location),
  };
  if (!validQuantity(input.quantity) || input.from_location===input.to_location) throw new Error('stock_group_invalid_positions');
  return runGroupOperation(db,environment,'stock.group.move',input,async client=>{
    const group=await lockGroup(client,environment,input.group_id,input.revision);
    if (input.from_location) {
      const { rowCount }=await client.query(`UPDATE commerce.matriz_stock_group_positions SET quantity_on_hand=quantity_on_hand-$4,
        confirmed_at=clock_timestamp()
        WHERE environment=$1 AND group_id=$2 AND location_code=$3 AND quantity_on_hand-quantity_reserved >= $4`,
      [environment,group.group_id,input.from_location,input.quantity]);
      if (rowCount!==1) throw new Error('stock_group_protected');
    } else {
      await requireProduct(client,environment,group.stock_id,group.product_id);
      await requireUngrouped(client,environment,group.stock_id,input.quantity);
      // Entrar novas peças não pode estender automaticamente aprovação de um jogo anterior.
      if (group.matched_set || group.inspection_status==='approved') throw new Error('stock_group_not_editable');
    }
    if (input.to_location) await addPosition(client,environment,group.group_id,input.to_location,input.quantity);
    await client.query(`UPDATE commerce.matriz_stock_groups SET revision=revision+1,updated_at=clock_timestamp()
      WHERE environment=$1 AND id=$2`,[environment,group.group_id]);
    await client.query(`INSERT INTO commerce.matriz_stock_group_movements
      (environment,group_id,movement_type,from_location,to_location,quantity,reason,actor_label)
      VALUES ($1,$2,'move',$3,$4,$5,$6,$7)`,[environment,group.group_id,input.from_location,input.to_location,input.quantity,input.reason,actor]);
    return group.group_id;
  });
}

export async function listMatrizOrderGroupPositionsForOrders(db: Database, environment: MatrizEnvironment, orderIds: string[]) {
  if (orderIds.length===0) return [];
  return (await db.query<{
    order_id: string; order_item_id: string | null; matching_items: number; product_id: string; product_name: string;
    group_id: string; model: string | null;
    location_code: string; quantity: number; status: 'reserved'|'released'|'consumed';
  }>(`SELECT a.order_id,oi.order_item_id,oi.matching_items,a.product_id,p.product_name,a.group_id,a.model,a.location_code,a.quantity,a.status
    FROM commerce.matriz_stock_group_allocations a
    JOIN commerce.products p ON p.environment=a.environment AND p.id=a.product_id
    CROSS JOIN LATERAL (SELECT count(*)::int matching_items,CASE WHEN count(*)=1 THEN (array_agg(i.id))[1] END order_item_id
      FROM commerce.order_items i WHERE i.environment=a.environment AND i.order_id=a.order_id AND i.product_id=a.product_id) oi
    WHERE a.environment=$1 AND a.order_id=ANY($2::uuid[]) ORDER BY a.order_id,a.product_id,a.location_code,a.group_id`,
  [environment,orderIds])).rows;
}

export function listMatrizOrderGroupPositions(db: Database, environment: MatrizEnvironment, orderId: string) {
  return listMatrizOrderGroupPositionsForOrders(db,environment,[orderId]);
}
