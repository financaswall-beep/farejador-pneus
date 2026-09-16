import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { postMatrizLedgerTransaction } from './matriz-ledger-posting.js';

export interface OwnerWithdrawalInput {
  amount: number; occurred_at: string; reason: string;
  payment_method: string; cash_account: string; idempotency_key: string;
}

/** Retirada pessoal: débito no patrimônio e crédito no caixa, sem despesa. */
export async function createOwnerWithdrawal(
  input: OwnerWithdrawalInput, actor: string,
  environment = env.FAREJADOR_ENV, dbPool: Pool = defaultPool,
) {
  const client = await dbPool.connect();
  try {
    const id = await postMatrizLedgerTransaction(client, {
      environment, sourceType: 'finance.owner_withdrawal',
      sourceId: input.idempotency_key, kind: 'owner_withdrawal', amount: input.amount,
      occurredAt: input.occurred_at, cashAt: input.occurred_at,
      description: `Retirada do dono: ${input.reason}`, createdBy: actor,
      lines: [
        { account_code: 'owner_equity', account_class: 'equity', side: 'debit', amount: input.amount },
        { account_code: 'cash', account_class: 'asset', side: 'credit', amount: input.amount },
      ],
      metadata: { reason: input.reason, payment_method: input.payment_method, cash_account: input.cash_account },
    });
    return { id };
  } finally { client.release(); }
}

/** Corrige uma retirada, mantendo original e estorno no histórico. */
export async function reverseOwnerWithdrawal(
  id: string, input: { reason: string; occurred_at: string; idempotency_key: string },
  actor: string, environment = env.FAREJADOR_ENV, dbPool: Pool = defaultPool,
) {
  const result = await dbPool.query<{ id: string }>(
    `SELECT finance.reverse_matriz_ledger_transaction(
       $1::env_t,t.id,'finance.owner_withdrawal.reversal',$3,
       ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,$5,$6,
       ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,$7::jsonb) id
     FROM finance.matriz_ledger_transactions t
     WHERE t.environment=$1 AND t.id=$2
       AND t.source_type='finance.owner_withdrawal'
       AND t.transaction_kind='owner_withdrawal'
       AND t.cash_on<=($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date`,
    [environment, id, input.idempotency_key, input.occurred_at,
      `Estorno de retirada: ${input.reason}`, actor, JSON.stringify({ reason: input.reason })],
  );
  if (!result.rows[0]) throw new Error('withdrawal_not_found_or_date_invalid');
  return result.rows[0];
}
