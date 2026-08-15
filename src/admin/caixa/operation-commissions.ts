import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { SimpleFinanceRange } from '../../shared/simple-finance.js';
import {
  money,
  operationCommissionBounds,
  type OperationCommissionCollaborator,
  type OperationCommissionDetailPayload,
  type OperationCommissionSale,
  type OperationCommissionsPayload,
} from '../../shared/operation-commissions.js';
import {
  getMatrizCollaboratorManagement,
  payMatrizPayrollItem,
} from '../painel/queries.js';

type Queryable = Pick<Pool, 'query'>;

const salesFactsSql = `WITH retail AS (
  SELECT o.seller_collaborator_id collaborator_id,o.id::text id,
         'Pedido #'||COALESCE(o.order_number::text,right(o.id::text,6)) reference,
         o.created_at occurred_at,o.payment_method,o.total_amount gross_amount,
         COALESCE(items.margin,0) margin,'retail'::text sale_channel,o.id source_id
    FROM commerce.orders o
    JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum((oi.unit_price-oi.matriz_unit_cost)*oi.quantity-oi.discount_amount)
                 FILTER (WHERE oi.matriz_unit_cost IS NOT NULL),0) margin
        FROM commerce.order_items oi
       WHERE oi.environment=o.environment AND oi.order_id=o.id
    ) items ON true
   WHERE o.environment=$1 AND o.seller_collaborator_id IS NOT NULL
     AND o.status<>'cancelled' AND o.created_at >= $2::date AND o.created_at < $3::date
), wholesale AS (
  SELECT o.seller_collaborator_id collaborator_id,o.id::text id,
         'Atacado #'||right(o.id::text,6) reference,o.created_at occurred_at,
         NULL::text payment_method,o.total_amount gross_amount,
         COALESCE(items.margin,0) margin,'wholesale'::text sale_channel,o.id source_id
    FROM commerce.wholesale_orders o
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum((oi.unit_price-oi.unit_cost)*oi.quantity),0) margin
        FROM commerce.wholesale_order_items oi
       WHERE oi.environment=o.environment AND oi.order_id=o.id
    ) items ON true
   WHERE o.environment=$1 AND o.seller_collaborator_id IS NOT NULL
     AND o.status='confirmed' AND o.created_at >= $2::date AND o.created_at < $3::date
), sales AS (SELECT * FROM retail UNION ALL SELECT * FROM wholesale), ruled AS (
  SELECT s.*,rule.kind commission_kind,rule.basis commission_basis,
         COALESCE(rule.value,0) commission_value,
         CASE
           WHEN rule.active AND rule.itemized AND s.sale_channel='retail'
             THEN finance.matriz_retail_itemized_commission($1,s.source_id,rule.item_rules)
           WHEN rule.active AND rule.itemized AND s.sale_channel='wholesale'
             THEN finance.matriz_wholesale_itemized_commission($1,s.source_id,rule.item_rules)
           WHEN rule.active AND rule.kind='percent' AND rule.basis='margin'
             THEN round(s.margin*rule.value/100,2)
           WHEN rule.active AND rule.kind='percent' AND rule.basis='revenue'
             THEN round(s.gross_amount*rule.value/100,2)
           WHEN rule.active AND rule.kind='fixed' AND rule.basis='sale'
             THEN rule.value
           ELSE 0 END commission_amount
    FROM sales s
    LEFT JOIN LATERAL (
      SELECT r.kind,r.basis,r.value,r.active,r.itemized,r.item_rules
        FROM network.matriz_collaborator_commission_rules r
       WHERE r.environment=$1 AND r.collaborator_id=s.collaborator_id
         AND r.starts_on <= (s.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
       ORDER BY r.starts_on DESC LIMIT 1
    ) rule ON true
)`;

async function performanceRows(range: SimpleFinanceRange, db: Queryable) {
  const bounds = operationCommissionBounds(range);
  return db.query<{
    collaborator_id: string; sales_count: number; gross_sales: string;
    commission_amount: string;
  }>(
    `${salesFactsSql}
     SELECT collaborator_id,count(*)::int sales_count,
            COALESCE(sum(gross_amount),0)::text gross_sales,
            COALESCE(sum(commission_amount),0)::text commission_amount
       FROM ruled GROUP BY collaborator_id`,
    [env.FAREJADOR_ENV, bounds.start, bounds.end],
  );
}

export async function getMatrizOperationCommissions(
  range: SimpleFinanceRange,
  db: Queryable = defaultPool,
): Promise<OperationCommissionsPayload> {
  const bounds = operationCommissionBounds(range);
  const [management, performance] = await Promise.all([
    getMatrizCollaboratorManagement(bounds.competence, env.FAREJADOR_ENV, db),
    performanceRows(range, db),
  ]);
  const values = new Map(performance.rows.map((row) => [row.collaborator_id, row]));
  const collaborators: OperationCommissionCollaborator[] = management.collaborators
    .filter((row) => row.commission_active || values.has(row.id) || row.payroll_item_id)
    .map((row): OperationCommissionCollaborator => {
      const value = values.get(row.id);
      return {
        id: row.id,
        name: row.display_name,
        username: row.username,
        role: row.job_title || row.job || 'Colaborador',
        active: row.active,
        sales_count: Number(value?.sales_count ?? 0),
        gross_sales: money(value?.gross_sales),
        commission_kind: row.commission_kind,
        commission_basis: row.commission_basis,
        commission_value: money(row.commission_value),
        commission_amount: money(value?.commission_amount),
        status: row.payroll_status === 'paid' ? 'paid'
          : (row.payroll_status === 'pending' && row.payroll_item_id ? 'payable' : 'open'),
        payment_target_id: row.payroll_status === 'pending' ? row.payroll_item_id : null,
        payment_total: row.payroll_status === 'pending' ? money(row.total_due) : null,
      };
    })
    .sort((a, b) => b.commission_amount - a.commission_amount || a.name.localeCompare(b.name));
  const totalCommission = money(collaborators.reduce((sum, row) => sum + row.commission_amount, 0));
  const totalSales = collaborators.reduce((sum, row) => sum + row.sales_count, 0);
  return {
    range,
    unit_name: 'Matriz',
    total_commission: totalCommission,
    total_sales: totalSales,
    average_commission: totalSales ? money(totalCommission / totalSales) : 0,
    collaborators,
  };
}

export async function getMatrizOperationCommissionDetail(
  collaboratorId: string,
  range: SimpleFinanceRange,
  db: Queryable = defaultPool,
): Promise<OperationCommissionDetailPayload | null> {
  const overview = await getMatrizOperationCommissions(range, db);
  const collaborator = overview.collaborators.find((row) => row.id === collaboratorId);
  if (!collaborator) return null;
  const bounds = operationCommissionBounds(range);
  const result = await db.query<{
    id: string; reference: string; occurred_at: string; payment_method: string | null;
    gross_amount: string; commission_amount: string;
  }>(
    `${salesFactsSql}
     SELECT id,reference,occurred_at,payment_method,gross_amount::text,
            commission_amount::text
       FROM ruled WHERE collaborator_id=$4
       ORDER BY occurred_at DESC LIMIT 200`,
    [env.FAREJADOR_ENV, bounds.start, bounds.end, collaboratorId],
  );
  const sales: OperationCommissionSale[] = result.rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    occurred_at: row.occurred_at,
    payment_method: row.payment_method,
    gross_amount: money(row.gross_amount),
    commission_amount: money(row.commission_amount),
  }));
  return { range, unit_name: 'Matriz', collaborator, sales };
}

export async function payMatrizOperationCommission(
  collaboratorId: string,
  payrollItemId: string,
  idempotencyKey: string,
  actorLabel: string,
  db: Pool = defaultPool,
) {
  const allowed = await db.query(
    `SELECT 1 FROM finance.matriz_payroll_items item
      WHERE item.environment=$1 AND item.id=$2 AND item.collaborator_id=$3
        AND item.payment_status='pending'`,
    [env.FAREJADOR_ENV, payrollItemId, collaboratorId],
  );
  if (allowed.rowCount !== 1) throw new Error('commission_payment_not_available');
  return payMatrizPayrollItem({
    item_id: payrollItemId,
    environment: env.FAREJADOR_ENV,
    actor_label: actorLabel,
    idempotency_key: idempotencyKey,
  }, db);
}
