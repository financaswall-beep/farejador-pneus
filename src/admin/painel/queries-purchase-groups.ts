import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { groupProjection, type PurchaseGroupRow } from './queries-purchase-groups-write.js';
import { purchaseGroupSummary, type GroupPurchaseMoney, type GroupExpenseMoney } from './purchase-group-summary.js';
import type { MatrizEnvironment } from './stage5-integrity.js';

export interface PurchaseGroupPurchase extends GroupPurchaseMoney {
  id: string; group_id: string; supplier_name: string; order_code: string | null;
  purchased_at: string; payment_status?: string; paid_at?: string | null; due_date?: string | null;
  items: unknown[]; [key: string]: unknown;
}
export interface PurchaseGroupExpense extends GroupExpenseMoney {
  id: string; group_id: string; category_label: string; description: string | null;
  occurred_at: string; payment_status?: string; paid_at?: string | null; due_date?: string | null;
}

async function records(client: PoolClient, environment: MatrizEnvironment, ids: string[]) {
  const purchases = await client.query<PurchaseGroupPurchase>(`SELECT p.*,l.group_id,s.name supplier_name,
    'OC-'||to_char(o.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY')||'-'||lpad(o.order_number::text,6,'0') order_code,
    COALESCE((SELECT sum(COALESCE(i.accepted_quantity,i.quantity)) FROM commerce.wholesale_purchase_lines i
      WHERE i.environment=p.environment AND i.purchase_id=p.id),0)::int items_count,
    COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM commerce.wholesale_purchase_lines i
      WHERE i.environment=p.environment AND i.purchase_id=p.id),'[]') items,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'number',i.installment_number,
      'due_date',i.due_date,'amount',i.amount) ORDER BY i.installment_number)
      FROM commerce.wholesale_purchase_installments i WHERE i.environment=p.environment AND i.purchase_id=p.id),'[]') installments
    FROM commerce.wholesale_purchase_group_purchases l
    JOIN commerce.wholesale_purchases p ON p.environment=l.environment AND p.id=l.purchase_id
    JOIN commerce.wholesale_suppliers s ON s.environment=p.environment AND s.id=p.supplier_id
    LEFT JOIN commerce.wholesale_purchase_orders o ON o.environment=p.environment AND o.id=p.purchase_order_id
    WHERE l.environment=$1 AND l.group_id=ANY($2::uuid[]) ORDER BY p.purchased_at DESC,p.id`, [environment, ids]);
  const expenses = await client.query<PurchaseGroupExpense>(`SELECT e.*,l.group_id,
    COALESCE(c.label,e.category) category_label FROM commerce.wholesale_purchase_group_expenses l
    JOIN commerce.matriz_expenses e ON e.environment=l.environment AND e.id=l.expense_id
    LEFT JOIN commerce.matriz_expense_categories c ON c.environment=e.environment AND c.slug=e.category
    WHERE l.environment=$1 AND l.group_id=ANY($2::uuid[]) ORDER BY e.occurred_at DESC,e.id`, [environment, ids]);
  return { purchases: purchases.rows, expenses: expenses.rows };
}

export async function listPurchaseGroups(environment: MatrizEnvironment = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool, options: { status?: 'open' | 'closed'; page?: number; limit?: number } = {}) {
  const page = Math.max(1, options.page ?? 1), limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const groups = await client.query<PurchaseGroupRow>(`SELECT ${groupProjection}
      FROM commerce.wholesale_purchase_groups WHERE environment=$1 AND ($2::text IS NULL OR status=$2)
      ORDER BY (status='open') DESC,created_at DESC,id LIMIT $3 OFFSET $4`,
    [environment, options.status ?? null, limit + 1, (page - 1) * limit]);
    const visible = groups.rows.slice(0, limit), ids = visible.map(g => g.id);
    const data = await records(client, environment, ids);
    const rows = visible.map(g => ({ ...g, suppliers_count: new Set(data.purchases.filter(p => p.group_id === g.id && p.status !== 'cancelled').map(p => p.supplier_id)).size, summary: purchaseGroupSummary(
      data.purchases.filter(p => p.group_id === g.id), data.expenses.filter(e => e.group_id === g.id)) }));
    await client.query('COMMIT');
    return { rows, page, has_more: groups.rows.length > limit };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function getPurchaseGroup(id: string, environment: MatrizEnvironment = env.FAREJADOR_ENV, dbPool = defaultPool) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const group = (await client.query<PurchaseGroupRow>(`SELECT ${groupProjection}
      FROM commerce.wholesale_purchase_groups WHERE environment=$1 AND id=$2`, [environment, id])).rows[0];
    if (!group) throw Error('purchase_group_not_found');
    const data = await records(client, environment, [id]);
    const categories = new Map<string, { category: string; label: string; cents: number }>();
    for (const e of data.expenses.filter(e => !e.deleted_at)) {
      const current = categories.get(e.category) ?? { category: e.category, label: e.category_label, cents: 0 };
      current.cents += Math.round(Number(e.amount) * 100); categories.set(e.category, current);
    }
    await client.query('COMMIT');
    return { group, ...data, summary: purchaseGroupSummary(data.purchases, data.expenses),
      categories: [...categories.values()].map(c => ({ category: c.category, label: c.label, amount: (c.cents / 100).toFixed(2) })) };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function eligiblePurchaseGroupExpenses(environment: MatrizEnvironment = env.FAREJADOR_ENV,
  dbPool = defaultPool, page = 1) {
  return (await dbPool.query(`SELECT e.id,e.category,COALESCE(c.label,e.category) category_label,
    e.description,e.amount,e.occurred_at,e.payment_status FROM commerce.matriz_expenses e
    LEFT JOIN commerce.matriz_expense_categories c ON c.environment=e.environment AND c.slug=e.category
    WHERE e.environment=$1 AND e.deleted_at IS NULL
      AND NOT commerce.purchase_group_expense_owned(e.environment,e.id)
      AND NOT EXISTS(SELECT 1 FROM commerce.wholesale_purchase_group_expenses l
        WHERE l.environment=e.environment AND l.expense_id=e.id)
    ORDER BY e.occurred_at DESC,e.id LIMIT 50 OFFSET $2`, [environment, (page - 1) * 50])).rows;
}

export async function expensePurchaseGroupTags(ids: string[], environment: MatrizEnvironment, dbPool: Pool) {
  if (!ids.length) return [];
  // Metadado opcional de apresentação: a ausência da migration de viagens
  // não pode derrubar as contas e os valores existentes do Financeiro.
  const ready = await dbPool.query<{ ready: boolean }>(`SELECT
    to_regclass('commerce.wholesale_purchase_group_expenses') IS NOT NULL ready`);
  if (!ready.rows[0]?.ready) return [];
  return (await dbPool.query<{ expense_id: string; group_id: string; group_code: string; group_name: string }>(
    `SELECT l.expense_id,g.id group_id,g.name group_name,
      'VC-'||lpad(g.group_number::text,GREATEST(4,length(g.group_number::text)),'0') group_code
      FROM commerce.wholesale_purchase_group_expenses l JOIN commerce.wholesale_purchase_groups g
      ON g.environment=l.environment AND g.id=l.group_id WHERE l.environment=$1 AND l.expense_id=ANY($2::uuid[])`,
    [environment, ids])).rows;
}

export async function purchaseGroupForPurchase(id: string, environment: MatrizEnvironment = env.FAREJADOR_ENV, dbPool = defaultPool) {
  return (await dbPool.query<PurchaseGroupRow>(`SELECT g.id,
    'VC-'||lpad(g.group_number::text,GREATEST(4,length(g.group_number::text)),'0') code,
    g.name,g.notes,g.status,g.created_at,g.closed_at,g.closed_by
    FROM commerce.wholesale_purchase_group_purchases l JOIN commerce.wholesale_purchase_groups g
    ON g.environment=l.environment AND g.id=l.group_id WHERE l.environment=$1 AND l.purchase_id=$2`,
  [environment, id])).rows[0] ?? null;
}
