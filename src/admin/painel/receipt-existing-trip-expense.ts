import type { PoolClient } from 'pg';
import type { ReceiptApprovalResult } from './receipt-review.js';
import { moneyCents } from './stage5-integrity.js';

/** Comprovante encontrado depois da aprovação sem nota reutiliza a despesa.
 * Também preserva a conferência explícita exigida para o vínculo legado. */
export async function existingTripReceiptExpense(client: PoolClient, input: {
  environment: 'prod' | 'test'; trip_id: string; legacy_expense_id: string | null;
  normalized: ReceiptApprovalResult; confirmed: boolean;
}): Promise<string> {
  let expenseId = input.legacy_expense_id;
  if (!expenseId && input.normalized.category === 'combustivel') {
    // Mantém o fluxo anterior utilizável durante o rollout e nas provas do
    // schema histórico 0140. A nova aprovação exige a migration 0260.
    const schema = await client.query<{ ready: boolean }>(
      "SELECT to_regclass('commerce.matriz_trip_lost_receipts') IS NOT NULL AS ready");
    if (schema.rows[0]?.ready) expenseId = (await client.query<{ expense_id: string }>(
      'SELECT expense_id FROM commerce.matriz_trip_lost_receipts WHERE environment=$1 AND trip_id=$2',
      [input.environment, input.trip_id])).rows[0]?.expense_id ?? null;
  }
  if (!expenseId) return '';
  const result = await client.query<{ id: string; category: string; amount: string;
    payment_status: string; document_date: string; competence_month: string;
    payment_date: string | null; due_date: string | null }>(`
    SELECT e.id,e.category,e.amount::text,e.payment_status,
      (e.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS document_date,
      ops.matriz_expense_competence_month(e.competence_month,e.occurred_at)::text AS competence_month,
      (e.paid_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS payment_date,e.due_date::text
    FROM commerce.matriz_expenses e WHERE e.environment=$1 AND e.deleted_at IS NULL
      AND e.id=$2 FOR UPDATE OF e
  `, [input.environment, expenseId]);
  const row = result.rows[0], n = input.normalized;
  if (!row) return '';
  const equal = row.category === n.category && moneyCents(Number(row.amount)) === n.amount_cents
    && row.payment_status === n.payment_status && row.document_date === n.document_date
    && row.competence_month === n.competence_month
    && (n.payment_status === 'paid' ? row.payment_date === n.payment_date : row.due_date === n.due_date);
  if (!input.confirmed || !equal) throw Error(equal
    ? 'receipt_legacy_expense_confirmation_required' : 'receipt_legacy_expense_conflict');
  return row.id;
}
