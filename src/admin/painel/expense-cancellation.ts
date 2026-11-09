import type { Pool } from 'pg';
import { z } from 'zod';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { beginIntegrityOperation, completeIntegrityOperation, operationFingerprint,
  recordIntegrityEvent } from './stage5-integrity.js';

export const cancelExpenseSchema = z.object({
  id: z.string().uuid(), reason: z.string().trim().min(2).max(300),
  idempotency_key: z.string().trim().min(8).max(200),
}).strict();
type Input = z.infer<typeof cancelExpenseSchema>;
type Result = { id: string; reversal_ids: string[]; cash_correction: string };
type LedgerRow = { id: string; source_type: string; transaction_kind: string;
  reversed: boolean; amount: string; competence_on: string; cash_on: string | null };

/** Cancela somente erro de registro. Não representa devolução de dinheiro nem movimenta estoque. */
export async function cancelExpenseByError(
  input: Input, actor: string, environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<Result> {
  if (!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) throw Error('central_ledger_disabled');
  const body = cancelExpenseSchema.parse(input);
  const operation = { environment, domain: 'matriz_expense.cancel_error',
    idempotencyKey: body.idempotency_key,
    fingerprint: operationFingerprint({ id: body.id, reason: body.reason }) };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<Result>(client, operation);
    if (started.replayed) { await client.query('COMMIT'); return started.result; }
    const selected = await client.query<{ amount: string; payment_status: string; deleted_at: string | null }>(
      `SELECT amount,payment_status,deleted_at FROM commerce.matriz_expenses
        WHERE environment=$1 AND id=$2 FOR UPDATE`, [environment, body.id]);
    const current = selected.rows[0];
    if (!current) throw Error('expense_not_found');
    // A folha e a logística têm contratos próprios. Nunca contornar seus vínculos.
    const links = await client.query<{ linked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM finance.matriz_payroll_items
          WHERE environment=$1 AND source_expense_id=$2)
        OR EXISTS (SELECT 1 FROM commerce.matriz_trip_receipts
          WHERE environment=$1 AND ai_expense_id=$2) AS linked`, [environment, body.id]);
    if (links.rows[0]!.linked) throw Error('expense_cancellation_linked');
    const previous = await client.query(
      `SELECT 1 FROM audit.events WHERE environment=$1 AND domain='matriz_expense'
        AND entity_id=$2 AND event_type='cancelled_error'`, [environment, body.id]);
    if (previous.rowCount) throw Error('expense_already_cancelled');
    const ledger = await client.query<LedgerRow>(
      `SELECT t.id,t.source_type,t.transaction_kind,t.amount::text,t.competence_on::text,t.cash_on::text,
        EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
          WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id) AS reversed
       FROM finance.matriz_ledger_transactions t
       WHERE t.environment=$1 AND t.source_id=$2
         AND t.source_type IN ('commerce.matriz_expense.accrual',
           'commerce.matriz_expense.payment','commerce.matriz_expense.remove')
       ORDER BY t.id FOR UPDATE OF t`, [environment, body.id]);
    const original = ledger.rows.find(r => r.source_type.endsWith('.accrual'));
    const payment = ledger.rows.find(r => r.source_type.endsWith('.payment'));
    const removal = ledger.rows.find(r => r.source_type.endsWith('.remove'));
    if (!original || Number(original.amount) !== Number(current.amount)
      || (original.transaction_kind === 'expense_cash' && current.payment_status !== 'paid')) {
      throw Error('expense_cancellation_inconsistent');
    }
    const dates = await client.query<{ today: string; competence: string }>(
      `SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text today,
        (COALESCE($1::timestamptz,now()) AT TIME ZONE 'America/Sao_Paulo')::date::text competence`,
      [current.deleted_at]);
    const { today, competence } = dates.rows[0]!;
    const reversalIds: string[] = [];
    const reverse = async (row: LedgerRow, suffix: string, cash: boolean) => {
      if (row.reversed) throw Error('expense_cancellation_inconsistent');
      const reversed = await client.query<{ id: string }>(
        `SELECT finance.reverse_matriz_ledger_transaction(
          $1::env_t,$2,$3,$4,$5::date,$6,$7,$8::date,$9::jsonb) id`,
        [environment, row.id, `commerce.matriz_expense.${suffix}`, body.id,
          competence, `Cancelamento por erro: ${body.reason}`, actor,
          cash ? today : null, JSON.stringify({ expense_id: body.id, reason: body.reason,
            correction_type: 'entry_error', original_transaction_id: row.id })]);
      reversalIds.push(reversed.rows[0]!.id);
      return reversed.rows[0]!.id;
    };
    // Uma remoção antiga pode ter criado recebível. Recusa se já houve recebimento/baixa.
    if (removal?.transaction_kind === 'expense_refund_receivable') {
      const received = await client.query(
        `SELECT 1 FROM finance.matriz_ledger_payments WHERE environment=$1
          AND obligation_transaction_id=$2 LIMIT 1`, [environment, removal.id]);
      if (received.rowCount) throw Error('expense_refund_has_payments');
      await reverse(removal, 'cancel_refund', false);
    }
    if (original.reversed) {
      // Remoção antiga de despesa pendente já estornou a obrigação.
      if (current.payment_status !== 'pending' || removal?.transaction_kind !== 'reversal') {
        throw Error('expense_cancellation_inconsistent');
      }
    } else {
      if (original.transaction_kind === 'expense_payable' && current.payment_status === 'paid') {
        if (!payment) throw Error('expense_cancellation_payment_missing');
        const settlements = await client.query<{ id: string }>(
          `SELECT id FROM finance.matriz_ledger_payments WHERE environment=$1
            AND obligation_transaction_id=$2 AND payment_transaction_id=$3
            AND payment_kind='settlement' FOR UPDATE`, [environment, original.id, payment.id]);
        if (settlements.rowCount !== 1) throw Error('expense_cancellation_inconsistent');
        const paymentReversal = await reverse(payment, 'cancel_payment', true);
        await client.query(`SELECT finance.record_matriz_ledger_payment(
          $1::env_t,$2,$3,now(),$4,$5)`,
        [environment, original.id, paymentReversal, actor, settlements.rows[0]!.id]);
        // Valida a baixa revertida enquanto a obrigação ainda está aberta.
        // O trigger diferido não aceita uma obrigação já cancelada no COMMIT.
        // A função de estorno abaixo só aceita cancelá-la com pagamentos líquidos zerados.
        await client.query('SET CONSTRAINTS finance.matriz_ledger_payment_integrity IMMEDIATE');
      } else if (!['expense_cash', 'expense_payable'].includes(original.transaction_kind) || payment) {
        throw Error('expense_cancellation_inconsistent');
      }
      await reverse(original, 'cancel', original.transaction_kind === 'expense_cash');
    }
    await client.query(`UPDATE commerce.matriz_expenses SET deleted_at=COALESCE(deleted_at,now()),
      deleted_by=COALESCE(deleted_by,$3),delete_reason=COALESCE(delete_reason,$4)
      WHERE environment=$1 AND id=$2`, [environment, body.id, actor, body.reason]);
    const result = { id: body.id, reversal_ids: reversalIds,
      cash_correction: current.payment_status === 'paid' ? current.amount : '0.00' };
    await recordIntegrityEvent(client, { environment, domain: 'matriz_expense',
      entityTable: 'commerce.matriz_expenses', entityId: body.id, eventType: 'cancelled_error',
      actorLabel: actor, idempotencyKey: body.idempotency_key,
      before: current, after: { ...result, reason: body.reason, cash_on: today } });
    await completeIntegrityOperation(client, operation, 'commerce.matriz_expenses', body.id, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); throw error;
  } finally { client.release(); }
}

export function expenseCancellationStatus(code: string): number {
  if (code === 'expense_not_found') return 404;
  if (['central_ledger_disabled', 'expense_already_cancelled', 'expense_cancellation_linked',
    'expense_refund_has_payments', 'expense_cancellation_inconsistent',
    'expense_cancellation_payment_missing', 'matriz_ledger_transaction_already_reversed',
    'matriz_ledger_reverse_has_payments', 'idempotency_conflict'].includes(code)) return 409;
  return 500;
}
