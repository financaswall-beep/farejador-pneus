import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { purchaseCreditEnabled } from './purchase-credit.js';

export interface WholesaleSupplierRow {
  id: string;
  name: string;
  phone: string | null;
  document: string | null;
  notes: string | null;
  supplier_credit_available?: string;
}

export async function listWholesaleSuppliers(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  includeCredit = false,
): Promise<WholesaleSupplierRow[]> {
  const withCredit = includeCredit && purchaseCreditEnabled();
  const result = await dbPool.query<WholesaleSupplierRow>(
    `SELECT s.id,s.name,s.phone,s.document,s.notes
      ${withCredit ? ',coalesce(c.available,0)::text supplier_credit_available' : ''}
      FROM commerce.wholesale_suppliers s
      ${withCredit ? 'LEFT JOIN (SELECT supplier_id,sum(delta) available FROM finance.supplier_advance_movements WHERE environment=$1 GROUP BY supplier_id) c ON c.supplier_id=s.id' : ''}
      WHERE s.environment=$1 AND s.deleted_at IS NULL ORDER BY s.name`, [environment]);
  return result.rows;
}

export interface SupplierFields {
  name: string;
  phone?: string | null;
  document?: string | null;
  notes?: string | null;
}

export async function registerWholesaleSupplier(
  input: SupplierFields & { environment?: 'prod' | 'test' },
  dbPool: Pick<Pool, 'query'> = defaultPool,
): Promise<WholesaleSupplierRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const name = input.name.trim();
  if (!name) throw new Error('name_required');
  const result = await dbPool.query<WholesaleSupplierRow>(
    `INSERT INTO commerce.wholesale_suppliers (environment,name,phone,document,notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING id,name,phone,document,notes`,
    [environment, name, input.phone ? normalizeBrazilianPhone(input.phone) : null,
     input.document?.trim() || null, input.notes?.trim() || null]);
  return result.rows[0]!;
}

export async function updateWholesaleSupplier(
  supplierId: string, changes: Partial<SupplierFields>,
  environment: 'prod' | 'test', db: Pick<Pool, 'query'>,
): Promise<WholesaleSupplierRow> {
  const result = await db.query<WholesaleSupplierRow>(
    `UPDATE commerce.wholesale_suppliers SET
       name=COALESCE($3, name),
       phone=CASE WHEN $4 THEN $5 ELSE phone END,
       document=CASE WHEN $6 THEN $7 ELSE document END,
       notes=CASE WHEN $8 THEN $9 ELSE notes END
     WHERE id=$1 AND environment=$2 AND deleted_at IS NULL
     RETURNING id,name,phone,document,notes`,
    [supplierId, environment, changes.name?.trim(), changes.phone !== undefined,
      normalizeBrazilianPhone(changes.phone), changes.document !== undefined,
      changes.document?.trim() || null, changes.notes !== undefined, changes.notes?.trim() || null]);
  if (!result.rows[0]) throw new Error('supplier_not_found');
  return result.rows[0];
}

export async function getWholesaleSupplierRanking(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT supplier_id,name,phone,purchases_count,total_spent,last_purchase_at,days_since_last
       FROM commerce.wholesale_supplier_summary WHERE environment=$1
      ORDER BY total_spent DESC,last_purchase_at DESC NULLS LAST,name`, [environment]);
  return result.rows;
}

export async function getWholesaleSupplierMeasureBreakdown(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT s.id AS supplier_id,s.name AS supplier_name,pi.measure,pi.brand,
            pi.tire_condition,pi.vehicle_type,
            SUM(COALESCE(pi.accepted_quantity,pi.quantity)) AS qty_total,
            ROUND(SUM(COALESCE(pi.accepted_quantity,pi.quantity)*pi.unit_cost)
              /NULLIF(SUM(COALESCE(pi.accepted_quantity,pi.quantity)),0),2) AS avg_cost,
            MAX(p.purchased_at) AS last_purchased_at
       FROM commerce.wholesale_purchase_items pi
       JOIN commerce.wholesale_purchases p ON p.id=pi.purchase_id AND p.environment=pi.environment
       JOIN commerce.wholesale_suppliers s ON s.id=p.supplier_id AND s.environment=p.environment
      WHERE pi.environment=$1 AND p.status='confirmed' AND s.deleted_at IS NULL
      GROUP BY s.id,s.name,pi.measure,pi.brand,pi.tire_condition,pi.vehicle_type
      ORDER BY pi.measure,pi.brand,pi.tire_condition,avg_cost,qty_total DESC`, [environment]);
  return result.rows;
}

export interface WholesalePurchaseRow {
  id: string;
  supplier_name: string;
  purchased_at: string;
  total_amount: string;
  items_count: number;
  payment_status: string;
  due_date: string | null;
  status: 'pending' | 'confirmed' | 'cancelled';
  stock_applied: boolean;
  cancelled_at: string | null;
  order_code: string | null;
  purchase_order_id: string | null;
  products_amount: string;
  freight_amount: string;
  discount_amount: string;
}

export async function listWholesalePurchases(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  limit = 15,
): Promise<WholesalePurchaseRow[]> {
  const result = await dbPool.query<WholesalePurchaseRow>(
    `SELECT p.id,s.name AS supplier_name,p.purchased_at,p.total_amount,
            p.products_amount,p.freight_amount,p.discount_amount,p.purchase_order_id,
            CASE WHEN o.id IS NULL THEN NULL ELSE
              'OC-'||to_char(o.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY')
                ||'-'||lpad(o.order_number::text,6,'0') END AS order_code,
            (SELECT COALESCE(sum(COALESCE(i.accepted_quantity,i.quantity)),0)
               FROM commerce.wholesale_purchase_lines i
              WHERE i.environment=p.environment AND i.purchase_id=p.id)::int AS items_count,
            p.payment_status,p.due_date,p.status,p.stock_applied,p.cancelled_at
       FROM commerce.wholesale_purchases p
       JOIN commerce.wholesale_suppliers s ON s.id=p.supplier_id AND s.environment=p.environment
       LEFT JOIN commerce.wholesale_purchase_orders o
         ON o.environment=p.environment AND o.id=p.purchase_order_id
      WHERE p.environment=$1 ORDER BY p.purchased_at DESC LIMIT $2`, [environment, limit]);
  return result.rows;
}

export {
  confirmWholesalePurchase, registerWholesalePurchase,
} from './queries-fornecedores-registro.js';
export type {
  ConfirmWholesalePurchaseInput, RegisterWholesalePurchaseInput,
  RegisterWholesalePurchaseResult,
} from './queries-fornecedores-registro.js';
