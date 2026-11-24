import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { MatrizEnvironment } from './stage5-integrity.js';

export const stockGroupId = z.string().uuid();
const location = z.string().trim().min(1).max(60);
const quantity = z.number().int().min(1).max(1_000_000);
const command = {
  reason: z.string().trim().min(2).max(300),
  idempotency_key: z.string().trim().min(8).max(200),
};
export const stockGroupSchema = z.object({
  group_id: stockGroupId.optional(),
  revision: z.string().regex(/^\d+$/).optional(),
  stock_id: stockGroupId,
  product_id: stockGroupId,
  model: z.string().trim().min(1).max(120).nullable().optional(),
  inspection_status: z.enum(['located','pending','approved','blocked']).describe('Use located quando a equipe informar apenas a pilha; pending ou blocked suspende a disponibilidade para venda.'),
  matched_set: z.boolean().optional().describe('Verdadeiro somente para unidades fisicamente conferidas como conjunto.'),
  conservation_grade: z.enum(['selecionado','economico']).nullable().optional().describe('Conservação verificada pela equipe. Omita se desconhecida.'),
  conservation_note: z.string().trim().max(500).nullable().optional(),
  positions: z.array(z.object({ location_code:location, quantity }).strict()).max(100).optional(),
  ...command,
}).strict().superRefine((data,ctx) => {
  if (data.matched_set && (data.model === null || (!data.group_id && !data.model))) {
    ctx.addIssue({code:'custom',path:['model'],message:'stock_group_model_required'});
  }
  if ((data.matched_set || data.conservation_grade) && data.inspection_status !== 'approved') {
    ctx.addIssue({code:'custom',path:['inspection_status'],message:'stock_group_invalid_inspection'});
  }
  if (Boolean(data.group_id) !== Boolean(data.revision)) ctx.addIssue({code:'custom',path:['revision'],message:'stock_group_revision_required'});
  if (data.group_id && data.positions !== undefined) ctx.addIssue({code:'custom',path:['positions'],message:'stock_group_move_required'});
  if (!data.group_id && !data.positions?.length) ctx.addIssue({code:'custom',path:['positions'],message:'stock_group_invalid_positions'});
  if (!data.group_id && data.matched_set && data.positions?.reduce((sum,p)=>sum+p.quantity,0) === 1) {
    ctx.addIssue({code:'custom',path:['positions'],message:'stock_group_invalid_positions'});
  }
});
const movement = z.object({
  revision:z.string().regex(/^\d+$/),from_location:location.nullable(),to_location:location.nullable(),
  quantity,...command,
}).strict();
type MoveLocations = {from_location:string|null;to_location:string|null};
const distinctLocations = (data:MoveLocations) => data.from_location?.toUpperCase() !== data.to_location?.toUpperCase();
export const stockGroupMoveBody = movement.refine(distinctLocations,'stock_group_invalid_positions');
export const stockGroupMoveSchema = movement.extend({group_id:stockGroupId}).refine(distinctLocations,'stock_group_invalid_positions');

export async function listMatrizStockGroupOptions(db: Pool | PoolClient, environment: MatrizEnvironment,
  stockId?: string, measure?: string, brand?: string) {
  const {rows} = await db.query(`SELECT w.id AS stock_id,w.measure,w.brand,w.tire_condition,
      w.quantity_on_hand,w.quantity_reserved,
      commerce.matriz_stock_inspection_unavailable(w.environment,w.id) AS quantity_inspection_unavailable,
      p.id AS product_id,p.product_code,s.tread_pattern,s.vehicle_type
    FROM commerce.wholesale_stock w
    LEFT JOIN commerce.products p ON p.environment=w.environment AND p.product_type='tire'
      AND NOT p.partner_generic AND p.deleted_at IS NULL AND p.tire_condition=w.tire_condition
      AND commerce.catalog_brand_identity(p.brand)=commerce.catalog_brand_identity(w.brand)
      AND EXISTS (SELECT 1 FROM commerce.tire_specs t WHERE t.environment=p.environment AND t.product_id=p.id
        AND regexp_replace(t.tire_size,'[^0-9]','','g')=regexp_replace(w.measure,'[^0-9]','','g'))
    LEFT JOIN commerce.tire_specs s ON s.environment=p.environment AND s.product_id=p.id
    WHERE w.environment=$1 AND s.vehicle_type='car' AND w.vehicle_type IS DISTINCT FROM 'motorcycle'
      AND ($2::uuid IS NULL OR w.id=$2)
      AND ($3::text IS NULL OR regexp_replace(w.measure,'[^0-9]','','g')=regexp_replace($3,'[^0-9]','','g'))
      AND ($4::text IS NULL OR commerce.catalog_brand_identity(w.brand)=commerce.catalog_brand_identity($4))
    ORDER BY w.measure,w.brand,w.tire_condition,p.product_code`,[environment,stockId??null,measure??null,brand??null]);
  return rows;
}
