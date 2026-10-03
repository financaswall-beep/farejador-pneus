import type { PoolClient } from 'pg';
import { lockMatrizObligationBreakdown } from './matriz-ledger-obligation-lock.js';
import { matrizLedgerActor, matrizLedgerAmount, postMatrizLedgerTransaction } from './matriz-ledger-posting.js';

/** Varejo e atacado usam a mesma composição: perda de crédito não é caixa. */
export async function cancelMatrizSaleRevenue(client: PoolClient, input: {
  environment: 'prod' | 'test'; orderId: string; revenueId: string;
  sourceType: 'commerce.order.revenue_cancel' | 'commerce.wholesale_order.revenue_cancel';
  cancelledAt: string; actor: string; reason: string;
}): Promise<void> {
  const { environment, orderId, revenueId, sourceType, cancelledAt, actor, reason } = input;
  const b = await lockMatrizObligationBreakdown(client, environment, revenueId);
  const prior = await client.query(`SELECT id FROM finance.matriz_ledger_transactions
    WHERE environment=$1 AND source_type=$2 AND source_id=$3`, [environment, sourceType, orderId]);
  if (prior.rows[0]) return;
  if (b.reversed) throw new Error('matriz_ledger_transaction_already_reversed');
  const amount = matrizLedgerAmount(b.amount, 'sale_ledger_amount_invalid');
  const unpaid = matrizLedgerAmount(b.open_amount, 'sale_ledger_balance_invalid');
  const refund = matrizLedgerAmount(b.cash_paid, 'sale_ledger_refund_invalid');
  const writtenOff = matrizLedgerAmount(b.written_off, 'sale_ledger_writeoff_invalid');
  if (Number(b.adjusted) !== 0) throw new Error('sale_ledger_adjustment_unsupported');
  if (unpaid === amount) {
    await client.query(`SELECT finance.reverse_matriz_ledger_transaction(
      $1::env_t,$2,$3,$4,($5::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
      'Cancelamento de venda nao recebida',$6,NULL,$7::jsonb)`,
    [environment, revenueId, sourceType, orderId, cancelledAt,
      matrizLedgerActor(actor), JSON.stringify({ order_id: orderId, reason })]);
    return;
  }
  await postMatrizLedgerTransaction(client, {
    environment, sourceType, sourceId: orderId, kind: 'customer_refund_payable',
    amount, occurredAt: cancelledAt, description: 'Cancelamento financeiro de venda',
    createdBy: matrizLedgerActor(actor),
    lines: [
      { account_code: 'sales_returns', account_class: 'revenue', side: 'debit', amount },
      ...(unpaid > 0 ? [{ account_code: 'accounts_receivable', account_class: 'asset' as const,
        side: 'credit' as const, amount: unpaid }] : []),
      ...(writtenOff > 0 ? [{ account_code: 'bad_debt_expense', account_class: 'expense' as const,
        side: 'credit' as const, amount: writtenOff }] : []),
      ...(refund > 0 ? [{ account_code: 'customer_refund_payable', account_class: 'liability' as const,
        side: 'credit' as const, amount: refund }] : []),
    ],
    metadata: { order_id: orderId, reason, unpaid_amount: unpaid,
      refund_amount: refund, written_off_amount: writtenOff },
  });
}
