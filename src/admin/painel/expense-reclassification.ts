import type { PoolClient } from 'pg';
import type { MatrizEnvironment } from './stage5-integrity.js';

interface ExpenseSnapshot {
  description: string | null;
  amount: string;
  category: string;
  category_label: string;
  competence_month: string;
  payment_status: 'paid' | 'pending';
  paid_at: string | null;
  due_date: string | null;
  document_date: string | null;
  receipt_id: string | null;
  trip_receipt_ids: string[];
  payroll: boolean;
  trip_linked: boolean;
  approved_without_receipt: boolean;
}

/** Usa a mesma trava de quitação e cancelamento de despesa. */
export async function activeExpenseForReclassification(
  db: PoolClient,
  environment: MatrizEnvironment,
  expenseId: string,
  targetCategory: string,
) {
  const { rows: [expense] } = await db.query<ExpenseSnapshot>(
    `SELECT e.description,e.amount::text,e.category,c.label AS category_label,e.payment_status,
      ops.matriz_expense_competence_month(e.competence_month,e.occurred_at)::text AS competence_month,
      e.paid_at::text,e.due_date::text,e.document_date::text,
      (SELECT r.id FROM commerce.matriz_expense_receipts r
        WHERE r.environment=e.environment AND r.expense_id=e.id) AS receipt_id,
      ARRAY(SELECT r.id FROM commerce.matriz_trip_receipts r WHERE r.environment=e.environment
        AND r.ai_expense_id=e.id ORDER BY r.id) AS trip_receipt_ids,
      EXISTS(SELECT 1 FROM finance.matriz_payroll_items p
        WHERE p.environment=e.environment AND p.source_expense_id=e.id) AS payroll,
      (e.delivery_trip_id IS NOT NULL OR EXISTS(SELECT 1 FROM commerce.matriz_delivery_trips t
        WHERE t.environment=e.environment AND t.fuel_expense_id=e.id)) AS trip_linked,
      EXISTS(SELECT 1 FROM commerce.matriz_trip_lost_receipts l
        WHERE l.environment=e.environment AND l.expense_id=e.id) AS approved_without_receipt
    FROM commerce.matriz_expenses e
    JOIN commerce.matriz_expense_categories c ON c.environment=e.environment AND c.slug=e.category
    WHERE e.environment=$1 AND e.id=$2 AND e.deleted_at IS NULL FOR UPDATE OF e`,
    [environment, expenseId],
  );
  if (!expense) throw new Error('expense_not_found');
  if (expense.payroll) throw new Error('despesa_vinculada_a_folha');
  const belongsToTrip = expense.trip_linked || expense.trip_receipt_ids.length > 0;
  const affectsTripFuel = expense.category !== targetCategory
    && [expense.category, targetCategory].includes('combustivel');
  if (expense.approved_without_receipt || (belongsToTrip && affectsTripFuel)) {
    throw new Error('despesa_de_combustivel_protegida_pela_rota');
  }
  return {
    descricao: expense.description,
    valor: expense.amount,
    categoria_atual: { id: expense.category, label: expense.category_label },
    competencia: expense.competence_month,
    situacao_pagamento: expense.payment_status,
    pago_em: expense.paid_at,
    vencimento: expense.due_date,
    data_documento: expense.document_date,
    comprovante_id: expense.receipt_id,
    comprovantes_da_rota: expense.trip_receipt_ids,
  };
}

export async function reclassifyExpense(
  db: PoolClient, environment: MatrizEnvironment, expenseId: string, from: string, to: string,
) {
  const updated = await db.query(
    `UPDATE commerce.matriz_expenses SET category=$4
      WHERE environment=$1 AND id=$2 AND category=$3 AND deleted_at IS NULL`,
    [environment, expenseId, from, to],
  );
  if (updated.rowCount !== 1) throw new Error('despesa_mudou_durante_a_proposta');
}
