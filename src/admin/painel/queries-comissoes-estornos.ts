import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
import { syncMatrizCommissionLedgerEntry } from './matriz-ledger-commissions.js';

export interface SettleCommissionRefundInput {
  reversal_id: string;
  actor_label: string;
  idempotency_key: string;
  reason: string;
  environment?: 'prod' | 'test';
}

export async function settleCommissionRefund(
  input: SettleCommissionRefundInput,
  dbPool: Pool = defaultPool,
): Promise<{ reversal_id: string; refunded_at: string; amount: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const actorLabel = input.actor_label.trim().slice(0, 200);
  const reason = input.reason.trim().slice(0, 500);
  if (!actorLabel) throw new Error('actor_required');
  if (reason.length < 2) throw new Error('reason_required');
  const operation = {
    environment,
    domain: 'commission.refund',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ reversal_id: input.reversal_id, reason }),
  };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<
      Awaited<ReturnType<typeof settleCommissionRefund>>
    >(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const current = await client.query<{
      id: string; amount: string; refund_status: string; commission_entry_id: string;
    }>(
      `SELECT id,amount::text,refund_status,commission_entry_id
         FROM finance.matriz_commission_reversals
        WHERE environment=$1 AND id=$2 FOR UPDATE`,
      [environment, input.reversal_id],
    );
    const row = current.rows[0];
    if (!row) throw new Error('commission_refund_not_found');
    if (row.refund_status !== 'pending') throw new Error('commission_refund_not_pending');
    const paid = await client.query<{ refunded_at: string }>(
      `UPDATE finance.matriz_commission_reversals
          SET refund_status='paid',refunded_at=now(),refunded_by=$3,
              refund_operation_key=$4,refund_reason=$5
        WHERE environment=$1 AND id=$2 AND refund_status='pending'
        RETURNING refunded_at`,
      [environment, input.reversal_id, actorLabel, operation.idempotencyKey, reason],
    );
    if (!paid.rows[0]) throw new Error('commission_refund_not_pending');
    const result = integrityResult({
      reversal_id: row.id,
      refunded_at: paid.rows[0].refunded_at,
      amount: Number(row.amount).toFixed(2),
    });
    await syncMatrizCommissionLedgerEntry(
      client, environment, row.commission_entry_id,
    );
    await recordIntegrityEvent(client, {
      environment, domain: 'network',
      entityTable: 'finance.matriz_commission_reversals',
      entityId: row.id,
      eventType: 'commission_refund_paid',
      actorLabel,
      idempotencyKey: operation.idempotencyKey,
      before: { refund_status: 'pending', amount: row.amount },
      after: { ...result, refund_status: 'paid', reason,
        commission_entry_id: row.commission_entry_id },
    });
    await completeIntegrityOperation(
      client, operation, 'finance.matriz_commission_reversals', row.id, result,
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
