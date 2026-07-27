import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';

export interface RepairReceiptExpenseInput {
  receipt_id: string;
  idempotency_key: string;
  actor_label: string;
  environment?: 'prod' | 'test';
}

/**
 * Repara somente o legado quebrado em que um comprovante terminal ainda aponta
 * para a mesma despesa soft-deleted. Nao cria dinheiro novo nem troca o vinculo.
 */
export async function repairMatrizTripReceiptExpense(
  input: RepairReceiptExpenseInput,
  dbPool: Pool = defaultPool,
): Promise<{ receipt_id: string; expense_id: string; restored: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const actorLabel = input.actor_label.trim().slice(0, 200);
  if (!actorLabel) throw new Error('receipt_actor_required');
  const operation = {
    environment,
    domain: 'receipt.repair_expense',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ receipt_id: input.receipt_id }),
  };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<
      Awaited<ReturnType<typeof repairMatrizTripReceiptExpense>>
    >(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const receipt = await client.query<{
      workflow_status: string; ai_expense_id: string | null;
    }>(
      `SELECT workflow_status,ai_expense_id
         FROM commerce.matriz_trip_receipts
        WHERE environment=$1 AND id=$2 FOR UPDATE`,
      [environment, input.receipt_id],
    );
    const row = receipt.rows[0];
    if (!row) throw new Error('receipt_not_found');
    if (!['linked', 'legacy_linked'].includes(row.workflow_status)
        || !row.ai_expense_id) {
      throw new Error('receipt_expense_not_repairable');
    }
    const expense = await client.query<{ deleted_at: string | null }>(
      `SELECT deleted_at
         FROM commerce.matriz_expenses
        WHERE environment=$1 AND id=$2 FOR UPDATE`,
      [environment, row.ai_expense_id],
    );
    if (!expense.rows[0]) throw new Error('receipt_expense_not_found');
    const restored = expense.rows[0].deleted_at !== null;
    if (restored) {
      const updated = await client.query(
        `UPDATE commerce.matriz_expenses
            SET deleted_at=NULL,deleted_by=NULL,delete_reason=NULL
          WHERE environment=$1 AND id=$2 AND deleted_at IS NOT NULL
          RETURNING id`,
        [environment, row.ai_expense_id],
      );
      if (!updated.rows[0]) throw new Error('receipt_expense_repair_failed');
      await recordIntegrityEvent(client, {
        environment, domain: 'receipt',
        entityTable: 'commerce.matriz_trip_receipts',
        entityId: input.receipt_id,
        eventType: 'linked_expense_restored',
        actorLabel,
        idempotencyKey: operation.idempotencyKey,
        before: { expense_id: row.ai_expense_id, deleted: true },
        after: { expense_id: row.ai_expense_id, deleted: false },
      });
    }
    const result = integrityResult({
      receipt_id: input.receipt_id,
      expense_id: row.ai_expense_id,
      restored,
    });
    await completeIntegrityOperation(
      client, operation, 'commerce.matriz_expenses', row.ai_expense_id, result,
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
