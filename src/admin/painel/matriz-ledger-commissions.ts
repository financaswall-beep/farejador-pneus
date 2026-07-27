import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import {
  matrizLedgerActor, matrizLedgerAmount, postMatrizLedgerTransaction,
} from './matriz-ledger-posting.js';

interface CommissionState {
  id: string;
  environment: 'prod' | 'test';
  partner_id: string;
  partner_order_id: string;
  commission_amount: string;
  realized_at: string;
  status: 'open' | 'settled' | 'reversed';
  settled_at: string | null;
  settled_by: string | null;
  reversed_at: string | null;
  reversed_reason: string | null;
}

async function commissionState(
  client: PoolClient,
  environment: 'prod' | 'test',
  entryId: string,
): Promise<CommissionState> {
  const result = await client.query<CommissionState>(
    `SELECT id,environment::text,partner_id,partner_order_id,
            commission_amount::text,realized_at,status,settled_at,settled_by,
            reversed_at,reversed_reason
       FROM network.commission_entries WHERE environment=$1 AND id=$2`,
    [environment, entryId],
  );
  if (!result.rows[0]) throw new Error('commission_entry_not_found');
  return result.rows[0];
}

async function ensureCommissionAccrual(
  client: PoolClient,
  entry: CommissionState,
): Promise<string | null> {
  const amount = matrizLedgerAmount(entry.commission_amount, 'commission_amount_invalid');
  if (amount === 0) return null;
  return postMatrizLedgerTransaction(client, {
    environment: entry.environment,
    sourceType: 'network.commission_entry.accrual', sourceId: entry.id,
    kind: 'commission_receivable', amount, occurredAt: entry.realized_at,
    description: 'Comissao da Rede a receber',
    createdBy: 'system:network-commission',
    lines: [
      {
        account_code: 'network_commission_receivable',
        account_class: 'asset', side: 'debit', amount,
      },
      {
        account_code: 'network_commission_revenue',
        account_class: 'revenue', side: 'credit', amount,
      },
    ],
    metadata: {
      commission_entry_id: entry.id, partner_id: entry.partner_id,
      partner_order_id: entry.partner_order_id,
    },
  });
}

async function ensureCommissionPayment(
  client: PoolClient,
  entry: CommissionState,
): Promise<string | null> {
  if (!entry.settled_at) return null;
  const amount = matrizLedgerAmount(entry.commission_amount, 'commission_amount_invalid');
  const obligationId = await ensureCommissionAccrual(client, entry);
  if (!obligationId || amount === 0) return null;
  const paymentId = await postMatrizLedgerTransaction(client, {
    environment: entry.environment,
    sourceType: 'network.commission_entry.payment', sourceId: entry.id,
    kind: 'payment', amount, occurredAt: entry.settled_at, cashAt: entry.settled_at,
    description: 'Recebimento de comissao da Rede',
    createdBy: matrizLedgerActor(entry.settled_by),
    lines: [
      { account_code: 'cash', account_class: 'asset', side: 'debit', amount },
      {
        account_code: 'network_commission_receivable',
        account_class: 'asset', side: 'credit', amount,
      },
    ],
    metadata: { commission_entry_id: entry.id, partner_id: entry.partner_id },
  });
  await client.query(
    `SELECT finance.record_matriz_ledger_payment(
       $1::env_t,$2,$3,$4::timestamptz,$5,NULL
     )`,
    [
      entry.environment, obligationId, paymentId, entry.settled_at,
      matrizLedgerActor(entry.settled_by),
    ],
  );
  return paymentId;
}

async function ensureCommissionReversal(
  client: PoolClient,
  entry: CommissionState,
): Promise<string | null> {
  if (!entry.reversed_at) return null;
  const reversal = await client.query<{
    id: string; amount: string; refund_status: 'not_due' | 'pending' | 'paid';
    refunded_at: string | null; refunded_by: string | null;
  }>(
    `SELECT id,amount::text,refund_status,refunded_at,refunded_by
       FROM finance.matriz_commission_reversals
      WHERE environment=$1 AND commission_entry_id=$2`,
    [entry.environment, entry.id],
  );
  const state = reversal.rows[0];
  if (!state) throw new Error('commission_reversal_not_found');
  const amount = matrizLedgerAmount(state.amount, 'commission_amount_invalid');
  const originalId = await ensureCommissionAccrual(client, entry);
  if (!originalId || amount === 0) return null;
  if (!entry.settled_at) {
    const reversed = await client.query<{ id: string }>(
      `SELECT finance.reverse_matriz_ledger_transaction(
         $1::env_t,$2,'network.commission_entry.reversal',$3,
         ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
         $5,$6,NULL,$7::jsonb
       ) id`,
      [
        entry.environment, originalId, state.id, entry.reversed_at,
        'Estorno de comissao nao recebida', 'system:network-commission',
        JSON.stringify({
          commission_entry_id: entry.id, reason: entry.reversed_reason,
        }),
      ],
    );
    return reversed.rows[0]!.id;
  }
  return postMatrizLedgerTransaction(client, {
    environment: entry.environment,
    sourceType: 'network.commission_entry.reversal', sourceId: state.id,
    kind: 'commission_refund_payable', amount, occurredAt: entry.reversed_at,
    description: 'Devolucao de comissao recebida',
    createdBy: 'system:network-commission',
    lines: [
      {
        account_code: 'network_commission_returns',
        account_class: 'revenue', side: 'debit', amount,
      },
      {
        account_code: 'commission_refund_payable',
        account_class: 'liability', side: 'credit', amount,
      },
    ],
    metadata: {
      reversal_id: state.id, commission_entry_id: entry.id,
      partner_id: entry.partner_id, reason: entry.reversed_reason,
    },
  });
}

async function ensureCommissionRefundPayment(
  client: PoolClient,
  entry: CommissionState,
): Promise<string | null> {
  const reversal = await client.query<{
    id: string; amount: string; refunded_at: string | null; refunded_by: string | null;
  }>(
    `SELECT id,amount::text,refunded_at,refunded_by
       FROM finance.matriz_commission_reversals
      WHERE environment=$1 AND commission_entry_id=$2 AND refund_status='paid'`,
    [entry.environment, entry.id],
  );
  const state = reversal.rows[0];
  if (!state?.refunded_at) return null;
  const obligationId = await ensureCommissionReversal(client, entry);
  const amount = matrizLedgerAmount(state.amount, 'commission_amount_invalid');
  if (!obligationId) return null;
  const paymentId = await postMatrizLedgerTransaction(client, {
    environment: entry.environment,
    sourceType: 'network.commission_refund.payment', sourceId: state.id,
    kind: 'payment', amount, occurredAt: state.refunded_at,
    cashAt: state.refunded_at, description: 'Devolucao de comissao ao parceiro',
    createdBy: matrizLedgerActor(state.refunded_by),
    lines: [
      {
        account_code: 'commission_refund_payable',
        account_class: 'liability', side: 'debit', amount,
      },
      { account_code: 'cash', account_class: 'asset', side: 'credit', amount },
    ],
    metadata: { reversal_id: state.id, commission_entry_id: entry.id },
  });
  await client.query(
    `SELECT finance.record_matriz_ledger_payment(
       $1::env_t,$2,$3,$4::timestamptz,$5,NULL
     )`,
    [
      entry.environment, obligationId, paymentId, state.refunded_at,
      matrizLedgerActor(state.refunded_by),
    ],
  );
  return paymentId;
}

export async function syncMatrizCommissionLedgerEntry(
  client: PoolClient,
  environment: 'prod' | 'test',
  entryId: string,
): Promise<void> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return;
  const entry = await commissionState(client, environment, entryId);
  await ensureCommissionAccrual(client, entry);
  if (entry.settled_at) await ensureCommissionPayment(client, entry);
  if (entry.reversed_at) await ensureCommissionReversal(client, entry);
  await ensureCommissionRefundPayment(client, entry);
}
