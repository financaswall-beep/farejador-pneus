import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBusinessFactInstant } from '../../shared/business-time.js';
import {
  matrizLedgerActor, postMatrizLedgerTransaction,
} from './matriz-ledger-posting.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  moneyCents, operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';

type Environment = 'prod' | 'test';

export interface MatrizCreditWriteoffInput {
  obligation_id: string;
  amount?: number;
  occurred_at?: string;
  reason: string;
  actor_label?: string | null;
  idempotency_key: string;
  environment?: Environment;
}
export interface MatrizCreditWriteoffResult {
  obligation_id: string;
  writeoff_transaction_id: string;
  amount: string;
  remaining_balance: string;
  occurred_at: string;
}

interface ObligationRow {
  id: string;
  source_type: string;
  source_id: string;
  open_amount: string;
}

async function lockReceivable(
  client: PoolClient,
  environment: Environment,
  obligationId: string,
): Promise<ObligationRow> {
  const result = await client.query<ObligationRow>(
    `SELECT t.id,t.source_type,t.source_id,
            (e.amount-COALESCE((SELECT sum(CASE
              WHEN p.payment_kind IN ('settlement','writeoff') THEN p.amount
              ELSE -p.amount END)
              FROM finance.matriz_ledger_payments p
             WHERE p.environment=t.environment
               AND p.obligation_transaction_id=t.id),0))::numeric(14,2)::text open_amount
       FROM finance.matriz_ledger_transactions t
       JOIN finance.matriz_ledger_entries e
         ON e.environment=t.environment AND e.transaction_id=t.id
      WHERE t.environment=$1 AND t.id=$2
        AND e.account_code='accounts_receivable'
        AND e.account_class='asset' AND e.side='debit'
        AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
          WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)
      FOR UPDATE OF t`,
    [environment, obligationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('credit_writeoff_not_actionable');
  if (Number(row.open_amount) <= 0) throw new Error('credit_writeoff_not_open');
  return row;
}

export async function writeOffMatrizCredit(
  input: MatrizCreditWriteoffInput,
  dbPool: Pool = defaultPool,
): Promise<MatrizCreditWriteoffResult> {
  if (!env.MATRIZ_CENTRAL_LEDGER) throw new Error('central_ledger_disabled');
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const operation = {
    environment,
    domain: 'matriz_ledger.credit_writeoff',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({
      obligation_id: input.obligation_id,
      amount_cents: input.amount == null ? null : moneyCents(input.amount),
      occurred_at: input.occurred_at ?? null,
      reason: input.reason.trim(),
    }),
  };
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<MatrizCreditWriteoffResult>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const obligation = await lockReceivable(client, environment, input.obligation_id);
    const balanceCents = moneyCents(Number(obligation.open_amount));
    const amountCents = input.amount == null ? balanceCents : moneyCents(input.amount);
    if (amountCents <= 0) throw new Error('credit_writeoff_amount_invalid');
    if (amountCents > balanceCents) throw new Error('credit_writeoff_exceeds_balance');
    const amount = amountCents / 100;
    const occurredAt = normalizeBusinessFactInstant(
      input.occurred_at, new Date(), 'occurred_at_future',
    ) ?? new Date().toISOString();
    const actor = matrizLedgerActor(input.actor_label);
    const transactionId = await postMatrizLedgerTransaction(client, {
      environment,
      sourceType: 'finance.matriz_credit.writeoff',
      sourceId: `${input.idempotency_key.trim().slice(0, 120)}:${operation.fingerprint.slice(0, 32)}`,
      kind: 'credit_writeoff',
      amount,
      occurredAt,
      description: `Perda de crédito: ${input.reason.trim()}`,
      createdBy: actor,
      lines: [
        { account_code: 'bad_debt_expense', account_class: 'expense', side: 'debit', amount },
        { account_code: 'accounts_receivable', account_class: 'asset', side: 'credit', amount },
      ],
      metadata: {
        obligation_id: obligation.id,
        source_type: obligation.source_type,
        source_id: obligation.source_id,
        reason: input.reason.trim(),
      },
    });
    await client.query(
      `INSERT INTO finance.matriz_ledger_payments (
         environment,obligation_transaction_id,payment_transaction_id,
         payment_kind,amount,paid_at,created_by
       ) VALUES ($1,$2,$3,'writeoff',$4,$5::timestamptz,$6)`,
      [environment, obligation.id, transactionId, amount, occurredAt, actor],
    );
    const result = integrityResult({
      obligation_id: obligation.id,
      writeoff_transaction_id: transactionId,
      amount: (amountCents / 100).toFixed(2),
      remaining_balance: ((balanceCents - amountCents) / 100).toFixed(2),
      occurred_at: occurredAt,
    });
    await recordIntegrityEvent(client, {
      environment, domain: 'matriz_finance',
      entityTable: 'finance.matriz_ledger_transactions', entityId: transactionId,
      eventType: 'credit_written_off', actorLabel: actor,
      idempotencyKey: operation.idempotencyKey, after: result,
    });
    await completeIntegrityOperation(
      client, operation, 'finance.matriz_ledger_transactions', transactionId, result,
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
