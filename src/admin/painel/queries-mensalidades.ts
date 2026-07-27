import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  matrizLedgerActor, matrizLedgerAmount, postMatrizLedgerTransaction,
} from './matriz-ledger-posting.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';

interface MonthlyFeeState {
  id: string;
  environment: 'prod' | 'test';
  partner_id: string;
  competence: string;
  amount: string;
  due_date: string;
  status: 'open' | 'settled';
  settled_at: string | null;
  settled_by: string | null;
}

async function getMonthlyFeeState(
  client: PoolClient,
  environment: 'prod' | 'test',
  feeId: string,
): Promise<MonthlyFeeState> {
  const result = await client.query<MonthlyFeeState>(
    `SELECT id,environment,partner_id,competence::text,amount::text,due_date::text,
            status,settled_at,settled_by
       FROM finance.matriz_partner_monthly_fees
      WHERE environment=$1 AND id=$2`,
    [environment, feeId],
  );
  if (!result.rows[0]) throw new Error('monthly_fee_not_found');
  return result.rows[0];
}

async function syncMonthlyFee(
  client: PoolClient,
  fee: MonthlyFeeState,
): Promise<void> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return;
  const amount = matrizLedgerAmount(fee.amount, 'monthly_fee_amount_invalid');
  const accrualId = await postMatrizLedgerTransaction(client, {
    environment: fee.environment,
    sourceType: 'network.monthly_fee.accrual', sourceId: fee.id,
    kind: 'monthly_fee_receivable', amount,
    occurredAt: `${fee.competence}T12:00:00-03:00`, dueDate: fee.due_date,
    description: `Mensalidade da Rede ${fee.competence.slice(0, 7)}`,
    createdBy: 'system:monthly-fee',
    lines: [
      {
        account_code: 'network_monthly_fee_receivable',
        account_class: 'asset', side: 'debit', amount,
      },
      {
        account_code: 'network_monthly_fee_revenue',
        account_class: 'revenue', side: 'credit', amount,
      },
    ],
    metadata: {
      monthly_fee_id: fee.id, partner_id: fee.partner_id,
      competence: fee.competence,
    },
  });
  if (!fee.settled_at) return;
  const paymentId = await postMatrizLedgerTransaction(client, {
    environment: fee.environment,
    sourceType: 'network.monthly_fee.payment', sourceId: fee.id,
    kind: 'payment', amount, occurredAt: fee.settled_at, cashAt: fee.settled_at,
    description: 'Recebimento de mensalidade da Rede',
    createdBy: matrizLedgerActor(fee.settled_by),
    lines: [
      { account_code: 'cash', account_class: 'asset', side: 'debit', amount },
      {
        account_code: 'network_monthly_fee_receivable',
        account_class: 'asset', side: 'credit', amount,
      },
    ],
    metadata: { monthly_fee_id: fee.id, partner_id: fee.partner_id },
  });
  await client.query(
    `SELECT finance.record_matriz_ledger_payment(
       $1::env_t,$2,$3,$4::timestamptz,$5,NULL
     )`,
    [
      fee.environment, accrualId, paymentId, fee.settled_at,
      matrizLedgerActor(fee.settled_by),
    ],
  );
}

export async function generateCurrentMatrizPartnerMonthlyFees(
  client: PoolClient,
  environment: 'prod' | 'test',
): Promise<number> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return 0;
  const inserted = await client.query<{ id: string }>(
    `WITH competence AS (
       SELECT date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date value
     )
     INSERT INTO finance.matriz_partner_monthly_fees
       (environment,partner_id,competence,amount,due_date)
     SELECT p.environment,p.id,c.value,p.monthly_fee,
            (c.value+interval '1 month 9 days')::date
       FROM network.partners p CROSS JOIN competence c
      WHERE p.environment=$1 AND p.deleted_at IS NULL AND p.status='active'
        AND p.commercial_model IN ('monthly','hybrid') AND p.monthly_fee>0
        AND p.created_at<(c.value+interval '1 month')
     ON CONFLICT (environment,partner_id,competence) DO NOTHING
     RETURNING id`,
    [environment],
  );
  const pending = await client.query<{ id: string }>(
    `SELECT f.id FROM finance.matriz_partner_monthly_fees f
      WHERE f.environment=$1 AND (
        NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions t
          WHERE t.environment=f.environment
            AND t.source_type='network.monthly_fee.accrual'
            AND t.source_id=f.id::text)
        OR (f.status='settled' AND NOT EXISTS (
          SELECT 1 FROM finance.matriz_ledger_transactions t
           WHERE t.environment=f.environment
             AND t.source_type='network.monthly_fee.payment'
             AND t.source_id=f.id::text))
      ) ORDER BY f.competence,f.id LIMIT 1000`,
    [environment],
  );
  for (const row of pending.rows) {
    await syncMonthlyFee(client, await getMonthlyFeeState(client, environment, row.id));
  }
  return inserted.rowCount ?? 0;
}

export async function settleMatrizPartnerMonthlyFee(
  input: {
    fee_id: string; actor_label: string; idempotency_key: string;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ fee_id: string; settled_at: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const operation = {
    environment, domain: 'network.monthly_fee.settle',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ fee_id: input.fee_id }),
  };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<{
      fee_id: string; settled_at: string;
    }>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const paid = await client.query<{ settled_at: string }>(
      `UPDATE finance.matriz_partner_monthly_fees
          SET status='settled',settled_at=now(),settled_by=$3,
              settlement_operation_key=$4
        WHERE environment=$1 AND id=$2 AND status='open'
        RETURNING settled_at`,
      [environment, input.fee_id, input.actor_label, input.idempotency_key],
    );
    if (!paid.rows[0]) throw new Error('monthly_fee_not_found');
    await syncMonthlyFee(
      client, await getMonthlyFeeState(client, environment, input.fee_id),
    );
    const result = integrityResult({
      fee_id: input.fee_id, settled_at: paid.rows[0].settled_at,
    });
    await recordIntegrityEvent(client, {
      environment, domain: 'network',
      entityTable: 'finance.matriz_partner_monthly_fees', entityId: input.fee_id,
      eventType: 'monthly_fee_settled', actorLabel: input.actor_label,
      idempotencyKey: input.idempotency_key,
      before: { status: 'open' }, after: result,
    });
    await completeIntegrityOperation(
      client, operation, 'finance.matriz_partner_monthly_fees', input.fee_id, result,
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

export async function listMatrizPartnerMonthlyFees(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<Array<{
  id: string; partner_id: string; partner_name: string; competence: string;
  amount: string; due_date: string; status: 'open' | 'settled'; settled_at: string | null;
}>> {
  const result = await dbPool.query(
    `SELECT f.id,f.partner_id,COALESCE(p.trade_name,p.legal_name) partner_name,
            f.competence::text,f.amount::text,f.due_date::text,f.status,f.settled_at
       FROM finance.matriz_partner_monthly_fees f
       JOIN network.partners p ON p.environment=f.environment AND p.id=f.partner_id
      WHERE f.environment=$1 ORDER BY f.competence DESC,f.due_date,p.trade_name`,
    [environment],
  );
  return result.rows;
}
