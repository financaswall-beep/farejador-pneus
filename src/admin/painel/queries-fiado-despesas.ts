import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { hasMatrizPayrollSchema } from './payroll-schema.js';

export interface WholesaleFinanceOpenRow {
  id: string;
  counterparty: string;
  phone: string | null;
  total_amount: string;
  registered_at: string;
  due_date: string | null;
  overdue: boolean;
}

export interface WholesaleFinanceResumo {
  a_receber_total: string;
  a_receber_count: number;
  a_receber_vencidos: number;
  a_pagar_total: string;
  a_pagar_count: number;
  a_pagar_vencidos: number;
  receivables: WholesaleFinanceOpenRow[];
  payables: WholesaleFinanceOpenRow[];
}

export async function getWholesaleFinance(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleFinanceResumo> {
  const receivables = await dbPool.query<WholesaleFinanceOpenRow>(
    `SELECT o.id,c.name AS counterparty,c.phone,o.total_amount,o.sold_at AS registered_at,
            o.due_date,(o.due_date IS NOT NULL AND o.due_date<current_date) AS overdue
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_customers c ON c.id=o.buyer_id AND c.environment=o.environment
      WHERE o.environment=$1 AND o.status='confirmed' AND o.payment_status='pending'
      ORDER BY (o.due_date IS NULL),o.due_date,o.sold_at`, [environment]);
  const payables = await dbPool.query<WholesaleFinanceOpenRow>(
    `SELECT p.id,s.name AS counterparty,s.phone,p.total_amount,p.purchased_at AS registered_at,
            p.due_date,(p.due_date IS NOT NULL AND p.due_date<current_date) AS overdue
       FROM commerce.wholesale_purchases p
       JOIN commerce.wholesale_suppliers s ON s.id=p.supplier_id AND s.environment=p.environment
      WHERE p.environment=$1 AND p.status<>'cancelled' AND p.payment_status='pending'
      ORDER BY (p.due_date IS NULL),p.due_date,p.purchased_at`, [environment]);
  const sum = (rows: WholesaleFinanceOpenRow[]) =>
    rows.reduce((total, row) => total + Number(row.total_amount), 0).toFixed(2);
  return {
    a_receber_total: sum(receivables.rows), a_receber_count: receivables.rows.length,
    a_receber_vencidos: receivables.rows.filter((row) => row.overdue).length,
    a_pagar_total: sum(payables.rows), a_pagar_count: payables.rows.length,
    a_pagar_vencidos: payables.rows.filter((row) => row.overdue).length,
    receivables: receivables.rows, payables: payables.rows,
  };
}

export const MATRIZ_EXPENSE_CATEGORIES = [
  'aluguel', 'funcionario', 'combustivel', 'frete', 'manutencao', 'outros',
] as const;
export type MatrizExpenseCategory = string;

export interface MatrizExpenseRow {
  id: string;
  category: string;
  description: string | null;
  amount: string;
  occurred_at: string;
  document_date?: string | null;
  competence_month?: string | null;
  payment_status: 'paid' | 'pending';
  due_date: string | null;
  paid_at: string | null;
  overdue: boolean;
  payroll_item_id: string | null;
}

export interface MatrizExpensesFiltro {
  month?: string;
  category?: string;
  limit?: number;
}

export interface MatrizExpensesResumo {
  a_pagar_total: string;
  a_pagar_count: number;
  a_pagar_vencidos: number;
  pago_mes_total: string;
  entries: MatrizExpenseRow[];
  periodo: { total: string; count: number; truncado: boolean } | null;
}

export async function getMatrizExpenses(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  filtro?: MatrizExpensesFiltro,
): Promise<MatrizExpensesResumo> {
  const payrollReady = await hasMatrizPayrollSchema(dbPool);
  const where = ['environment=$1', 'deleted_at IS NULL'];
  const params: unknown[] = [environment];
  if (filtro?.month) {
    params.push(filtro.month);
    where.push(`ops.matriz_expense_competence_month(competence_month,occurred_at)=to_date($${params.length},'YYYY-MM')`);
  }
  if (filtro?.category) {
    params.push(filtro.category);
    where.push(`category=$${params.length}`);
  }
  const filtered = Boolean(filtro?.month || filtro?.category);
  const limit = filtro?.limit ?? (filtered ? 200 : 50);
  const order = filtered ? 'occurred_at DESC'
    : `(payment_status='pending') DESC,(due_date IS NULL),due_date,occurred_at DESC`;
  const payrollProjection = payrollReady
    ? `(SELECT i.id FROM finance.matriz_payroll_items i WHERE i.source_expense_id=matriz_expenses.id)`
    : `NULL::uuid`;
  const entries = await dbPool.query<MatrizExpenseRow>(
    `SELECT id,category,description,amount,occurred_at,document_date,competence_month,
            payment_status,due_date,paid_at,
            ${payrollProjection} AS payroll_item_id,
            (payment_status='pending' AND due_date IS NOT NULL AND due_date<current_date) AS overdue
       FROM commerce.matriz_expenses WHERE ${where.join(' AND ')}
      ORDER BY ${order} LIMIT $${params.length + 1}`, [...params, limit]);
  let periodo: MatrizExpensesResumo['periodo'] = null;
  if (filtered) {
    const period = await dbPool.query<{ total: string; count: number }>(
      `SELECT COALESCE(sum(amount),0) AS total,count(*)::int AS count
         FROM commerce.matriz_expenses WHERE ${where.join(' AND ')}`, params);
    periodo = { ...period.rows[0]!, truncado: period.rows[0]!.count > entries.rows.length };
  }
  const totals = await dbPool.query<{
    a_pagar_total: string; a_pagar_count: number; a_pagar_vencidos: number; pago_mes_total: string;
  }>(
    `SELECT COALESCE(sum(amount) FILTER (WHERE payment_status='pending'),0) AS a_pagar_total,
            count(*) FILTER (WHERE payment_status='pending')::int AS a_pagar_count,
            count(*) FILTER (WHERE payment_status='pending' AND due_date IS NOT NULL
              AND due_date<current_date)::int AS a_pagar_vencidos,
            COALESCE(sum(amount) FILTER (WHERE payment_status='paid'
              AND (COALESCE(paid_at,occurred_at) AT TIME ZONE 'America/Sao_Paulo')
                >=date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')),0) AS pago_mes_total
       FROM commerce.matriz_expenses WHERE environment=$1 AND deleted_at IS NULL`, [environment]);
  return { ...totals.rows[0]!, entries: entries.rows, periodo };
}

export {
  createMatrizExpense, removeMatrizExpense, settleMatrizExpense,
  settleWholesaleOrderPayment, settleWholesalePurchasePayment,
} from './queries-financeiro-integridade.js';
export type {
  CreateMatrizExpenseInput, MatrizWriteOptions,
} from './queries-financeiro-integridade.js';
