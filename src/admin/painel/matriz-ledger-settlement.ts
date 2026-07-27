import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  matrizLedgerActor, postMatrizLedgerTransaction,
  type MatrizLedgerAccountClass,
} from './matriz-ledger-posting.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  moneyCents, operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
type Environment = 'prod' | 'test';
type Target = { obligation_id: string; account_code?: never }
  | { obligation_id?: never; account_code: 'marketing_payable' };
export type MatrizLedgerSettlementInput = Target & {
  amount?: number;
  payment_method?: string;
  paid_at?: string;
  cash_account?: string;
  note?: string;
  actor_label?: string | null;
  idempotency_key: string;
  environment?: Environment;
};
export interface MatrizLedgerSettlementResult {
  target_id: string;
  direction: 'receivable' | 'payable';
  amount: string;
  remaining_balance: string;
  payment_ids: string[];
  settled_at: string;
}
interface ObligationRow {
  id: string;
  source_type: string;
  source_id: string;
  account_code: string;
  account_class: MatrizLedgerAccountClass;
  open_amount: string;
}
const CENTRAL_ACCOUNTS = new Set([
  'supplier_refund_receivable', 'expense_refund_receivable',
  'customer_refund_payable',
]);
function requestedAmount(value: number | undefined, balance: number): number {
  const amount = value === undefined ? balance : moneyCents(value) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('settlement_amount_invalid');
  if (moneyCents(amount) > moneyCents(balance)) {
    throw new Error('settlement_exceeds_balance');
  }
  return amount;
}
function paymentSourceId(key: string, fingerprint: string, index = 0): string {
  return `${key.trim().slice(0, 120)}:${fingerprint.slice(0, 40)}:${index}`;
}
async function recordPayment(
  client: PoolClient,
  environment: Environment,
  obligation: ObligationRow,
  amount: number,
  paidAt: string,
  actor: string,
  sourceType: string,
  sourceId: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  const receivable = obligation.account_class === 'asset';
  const paymentId = await postMatrizLedgerTransaction(client, {
    environment, sourceType, sourceId, kind: 'payment', amount,
    occurredAt: paidAt, cashAt: paidAt,
    description: receivable ? 'Recebimento no Financeiro central' : 'Pagamento no Financeiro central',
    createdBy: actor,
    lines: receivable ? [
      { account_code: 'cash', account_class: 'asset', side: 'debit', amount },
      { account_code: obligation.account_code, account_class: 'asset', side: 'credit', amount },
    ] : [
      { account_code: obligation.account_code, account_class: 'liability', side: 'debit', amount },
      { account_code: 'cash', account_class: 'asset', side: 'credit', amount },
    ],
    metadata,
  });
  await client.query(
    `SELECT finance.record_matriz_ledger_payment(
       $1::env_t,$2,$3,$4::timestamptz,$5,NULL
     )`,
    [environment, obligation.id, paymentId, paidAt, actor],
  );
  return paymentId;
}
async function lockObligation(
  client: PoolClient,
  environment: Environment,
  obligationId: string,
): Promise<ObligationRow> {
  const result = await client.query<ObligationRow>(
    `SELECT t.id,t.source_type,t.source_id,e.account_code,e.account_class,
            (e.amount-COALESCE((SELECT sum(CASE WHEN p.payment_kind='settlement'
              THEN p.amount ELSE -p.amount END)
              FROM finance.matriz_ledger_payments p
             WHERE p.environment=t.environment
               AND p.obligation_transaction_id=t.id),0))::numeric(14,2)::text open_amount
       FROM finance.matriz_ledger_transactions t
       JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment=$1 AND t.id=$2
        AND ((e.account_class='asset' AND e.side='debit')
          OR (e.account_class='liability' AND e.side='credit'))
        AND NOT EXISTS (SELECT 1 FROM finance.matriz_ledger_transactions r
          WHERE r.environment=t.environment AND r.reversal_of_transaction_id=t.id)
      FOR UPDATE OF t`,
    [environment, obligationId],
  );
  const row = result.rows[0];
  const retail = row?.account_code === 'accounts_receivable'
    && row.source_type === 'commerce.order.revenue';
  if (!row || (!CENTRAL_ACCOUNTS.has(row.account_code) && !retail)) {
    throw new Error('central_obligation_not_actionable');
  }
  if (Number(row.open_amount) <= 0) throw new Error('central_obligation_not_open');
  return row;
}
async function settleObligation(
  client: PoolClient,
  operation: ReturnType<typeof settlementOperation>,
  input: MatrizLedgerSettlementInput,
  paidAt: string,
  actor: string,
): Promise<MatrizLedgerSettlementResult> {
  const obligation = await lockObligation(
    client, operation.environment, input.obligation_id!,
  );
  const balance = Number(obligation.open_amount);
  const amount = requestedAmount(input.amount, balance);
  const remaining = (balance - amount).toFixed(2);
  const retail = obligation.source_type === 'commerce.order.revenue';
  const full = moneyCents(Number(remaining)) === 0;
  const method = input.payment_method?.trim();
  if (retail && full && (!method || method.toLowerCase() === 'a receber')) {
    throw new Error('retail_payment_method_required');
  }
  const sourceType = retail && full
    ? 'commerce.order.payment' : retail
      ? 'commerce.order.partial_payment'
      : 'finance.matriz_ledger_obligation.settlement';
  const sourceId = retail && full ? obligation.source_id
    : paymentSourceId(operation.idempotencyKey, operation.fingerprint);
  const paymentId = await recordPayment(
    client, operation.environment, obligation, amount, paidAt, actor,
    sourceType, sourceId, {
      obligation_id: obligation.id, source_type: obligation.source_type,
      source_id: obligation.source_id, payment_method: method ?? null,
      cash_account: input.cash_account?.trim() || null,
      note: input.note?.trim() || null,
    },
  );
  if (retail && full) {
    const updated = await client.query(
      `UPDATE commerce.orders SET payment_method=$3
        WHERE environment=$1 AND id=$2 AND status<>'cancelled'
          AND lower(btrim(COALESCE(payment_method,'')))='a receber'
        RETURNING id`,
      [operation.environment, obligation.source_id, method],
    );
    if (!updated.rows[0]) throw new Error('retail_receivable_not_open');
  }
  return integrityResult({
    target_id: obligation.id,
    direction: obligation.account_class === 'asset' ? 'receivable' : 'payable',
    amount: amount.toFixed(2), remaining_balance: remaining,
    payment_ids: [paymentId], settled_at: paidAt,
  });
}
async function marketingBalance(client: PoolClient, environment: Environment): Promise<number> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
    [`matriz-ledger:${environment}:marketing_payable`],
  );
  const result = await client.query<{ balance: string }>(
    `SELECT COALESCE(sum(CASE WHEN side='credit' THEN amount ELSE -amount END),0)
              ::numeric(14,2)::text balance
       FROM finance.matriz_ledger_entries
      WHERE environment=$1 AND account_code='marketing_payable'`,
    [environment],
  );
  return Number(result.rows[0]!.balance);
}

async function settleMarketing(
  client: PoolClient,
  operation: ReturnType<typeof settlementOperation>,
  input: MatrizLedgerSettlementInput,
  paidAt: string,
  actor: string,
): Promise<MatrizLedgerSettlementResult> {
  const balance = await marketingBalance(client, operation.environment);
  if (balance <= 0) throw new Error('central_obligation_not_open');
  let pending = requestedAmount(input.amount, balance);
  const obligations = await client.query<ObligationRow>(
    `SELECT t.id,t.source_type,t.source_id,e.account_code,e.account_class,
            (e.amount-COALESCE((SELECT sum(CASE WHEN p.payment_kind='settlement'
              THEN p.amount ELSE -p.amount END) FROM finance.matriz_ledger_payments p
             WHERE p.environment=t.environment
               AND p.obligation_transaction_id=t.id),0))::numeric(14,2)::text open_amount
       FROM finance.matriz_ledger_transactions t
       JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment=$1 AND e.account_code='marketing_payable'
        AND e.account_class='liability' AND e.side='credit'
      ORDER BY t.competence_on,t.created_at,t.id FOR UPDATE OF t`,
    [operation.environment],
  );
  const paymentIds: string[] = [];
  for (const [index, obligation] of obligations.rows.entries()) {
    if (moneyCents(pending) === 0) break;
    const chunk = Math.min(pending, Number(obligation.open_amount));
    if (chunk <= 0) continue;
    paymentIds.push(await recordPayment(
      client, operation.environment, obligation, chunk, paidAt, actor,
      'finance.matriz_ledger_account.settlement',
      paymentSourceId(operation.idempotencyKey, operation.fingerprint, index),
      {
        account_code: 'marketing_payable', obligation_id: obligation.id,
        payment_method: input.payment_method?.trim() || null,
        cash_account: input.cash_account?.trim() || null,
        note: input.note?.trim() || null,
      },
    ));
    pending = (moneyCents(pending) - moneyCents(chunk)) / 100;
  }
  if (moneyCents(pending) !== 0) throw new Error('marketing_allocation_failed');
  const amount = requestedAmount(input.amount, balance);
  return integrityResult({
    target_id: 'marketing_payable', direction: 'payable',
    amount: amount.toFixed(2), remaining_balance: (balance - amount).toFixed(2),
    payment_ids: paymentIds, settled_at: paidAt,
  });
}

function settlementOperation(environment: Environment, input: MatrizLedgerSettlementInput) {
  const target = input.obligation_id
    ? { obligation_id: input.obligation_id }
    : { account_code: input.account_code };
  return {
    environment, domain: 'matriz_ledger.settle',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({
      target, amount_cents: input.amount === undefined ? null : moneyCents(input.amount),
      payment_method: input.payment_method?.trim().toLowerCase() ?? null,
      paid_at: input.paid_at ?? null,
      cash_account: input.cash_account?.trim().toLowerCase() ?? null,
      note: input.note?.trim() || null,
    }),
  };
}

export async function settleMatrizLedgerOpenItem(
  input: MatrizLedgerSettlementInput,
  dbPool: Pool = defaultPool,
): Promise<MatrizLedgerSettlementResult> {
  if (!env.MATRIZ_CENTRAL_LEDGER) throw new Error('central_ledger_disabled');
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const operation = settlementOperation(environment, input);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<MatrizLedgerSettlementResult>(
      client, operation,
    );
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const paidAt = input.paid_at ?? new Date().toISOString();
    const actor = matrizLedgerActor(input.actor_label);
    const result = input.obligation_id
      ? await settleObligation(client, operation, input, paidAt, actor)
      : await settleMarketing(client, operation, input, paidAt, actor);
    const auditEntityId = result.payment_ids[0]!;
    await recordIntegrityEvent(client, {
      environment, domain: 'matriz_finance',
      entityTable: 'finance.matriz_ledger_transactions',
      entityId: auditEntityId, eventType: 'central_settlement',
      actorLabel: actor, idempotencyKey: operation.idempotencyKey,
      after: result,
    });
    await completeIntegrityOperation(
      client, operation, 'finance.matriz_ledger_transactions',
      auditEntityId, result,
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
