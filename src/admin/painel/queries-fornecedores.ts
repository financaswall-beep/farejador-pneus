import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';

export interface WholesaleSupplierRow {
  id: string;
  name: string;
  phone: string | null;
  document: string | null;
  notes: string | null;
}

export async function listWholesaleSuppliers(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleSupplierRow[]> {
  const result = await dbPool.query<WholesaleSupplierRow>(
    `SELECT id,name,phone,document,notes FROM commerce.wholesale_suppliers
      WHERE environment=$1 AND deleted_at IS NULL ORDER BY name`, [environment]);
  return result.rows;
}

export async function registerWholesaleSupplier(
  input: { name: string; phone?: string | null; document?: string | null;
    notes?: string | null; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
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
    `SELECT s.id AS supplier_id,s.name AS supplier_name,pi.measure,
            SUM(pi.quantity) AS qty_total,
            ROUND(SUM(pi.line_total)/NULLIF(SUM(pi.quantity),0),2) AS avg_cost,
            MAX(p.purchased_at) AS last_purchased_at
       FROM commerce.wholesale_purchase_items pi
       JOIN commerce.wholesale_purchases p ON p.id=pi.purchase_id AND p.environment=pi.environment
       JOIN commerce.wholesale_suppliers s ON s.id=p.supplier_id AND s.environment=p.environment
      WHERE pi.environment=$1 AND p.status='confirmed' AND s.deleted_at IS NULL
      GROUP BY s.id,s.name,pi.measure
      ORDER BY pi.measure,avg_cost,qty_total DESC`, [environment]);
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
}

export async function listWholesalePurchases(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  limit = 15,
): Promise<WholesalePurchaseRow[]> {
  const result = await dbPool.query<WholesalePurchaseRow>(
    `SELECT p.id,s.name AS supplier_name,p.purchased_at,p.total_amount,
            (SELECT COALESCE(sum(i.quantity),0) FROM commerce.wholesale_purchase_items i
              WHERE i.purchase_id=p.id)::int AS items_count,
            p.payment_status,p.due_date,p.status,p.stock_applied,p.cancelled_at
       FROM commerce.wholesale_purchases p
       JOIN commerce.wholesale_suppliers s ON s.id=p.supplier_id AND s.environment=p.environment
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
