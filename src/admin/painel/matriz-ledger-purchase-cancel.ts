import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { matrizLedgerActor, matrizLedgerAmount, postMatrizLedgerTransaction } from './matriz-ledger-posting.js';
import { ensureWholesalePurchaseAccrual, type WholesalePurchaseLedgerState } from './matriz-ledger-purchases.js';
import { lockMatrizObligationBreakdown } from './matriz-ledger-obligation-lock.js';

/** Nao pago: estorno exato. Ja pago: nasce valor a recuperar do fornecedor. */
export async function postWholesalePurchaseCancellation(
  client: PoolClient,
  purchase: WholesalePurchaseLedgerState,
  cancelledAt: string,
  cancelledBy: string,
  reason: string,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const amount = matrizLedgerAmount(purchase.totalAmount, 'purchase_ledger_amount_invalid');
  if (amount === 0) return null;
  const originalId = await ensureWholesalePurchaseAccrual(client, purchase);
  if (!originalId) return null;
  const obligation = await lockMatrizObligationBreakdown(client, purchase.environment, originalId);
  const cancellation = await client.query<{ id: string; transaction_kind: string }>(
    `SELECT id,transaction_kind FROM finance.matriz_ledger_transactions
      WHERE environment=$1 AND source_type='commerce.wholesale_purchase.cancel' AND source_id=$2`,
    [purchase.environment, purchase.purchaseId],
  );
  const prior = cancellation.rows[0];
  if (prior && prior.transaction_kind !== 'reversal') return prior.id;
  // Um estorno já existente zera obligation_balance; isso não significa pagamento.
  // Preserva também o reparo de receipt_cancel/adjustment_cancel no backfill.
  const unpaid = prior ? amount : matrizLedgerAmount(obligation.open_amount, 'purchase_ledger_balance_invalid');
  const refund = matrizLedgerAmount(amount - unpaid, 'purchase_ledger_refund_invalid');
  // Pending também inclui pagamento parcial: estorno integral só é correto
  // quando nada foi pago. O restante vira saldo a recuperar do fornecedor.
  if (unpaid === amount) {
    // Se a compra nasceu em transito e depois foi recebida, ha duas operacoes
    // a desfazer: primeiro o recebimento (estoque -> transito), depois a
    // aquisicao (transito -> contas a pagar). Estornar apenas a aquisicao
    // deixava inventory positivo e inventory_in_transit negativo.
    if (purchase.stockApplied) {
      const receipt = await client.query<{ id: string }>(
        `SELECT id FROM finance.matriz_ledger_transactions
          WHERE environment=$1
            AND source_type='commerce.wholesale_purchase.receipt'
            AND source_id=$2`,
        [purchase.environment, purchase.purchaseId],
      );
      if (receipt.rows[0]) {
        await client.query(
          `SELECT finance.reverse_matriz_ledger_transaction(
             $1::env_t,$2,'commerce.wholesale_purchase.receipt_cancel',$3,
             ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
             $5,$6,NULL,$7::jsonb
           )`,
          [
            purchase.environment, receipt.rows[0].id, purchase.purchaseId, cancelledAt,
            'Estorno do recebimento de compra cancelada', matrizLedgerActor(cancelledBy),
            JSON.stringify({ purchase_id: purchase.purchaseId, reason }),
          ],
        );
      }
    }
    const adjustment = await client.query<{ id: string }>(
      `SELECT id FROM finance.matriz_ledger_transactions
        WHERE environment=$1
          AND source_type='commerce.wholesale_purchase.adjustment'
          AND source_id=$2`,
      [purchase.environment, purchase.purchaseId],
    );
    if (adjustment.rows[0]) {
      await client.query(
        `SELECT finance.reverse_matriz_ledger_transaction(
           $1::env_t,$2,'commerce.wholesale_purchase.adjustment_cancel',$3,
           ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
           $5,$6,NULL,$7::jsonb
         )`,
        [purchase.environment, adjustment.rows[0].id, purchase.purchaseId,
         cancelledAt, 'Estorno do ajuste de quantidade da compra',
         matrizLedgerActor(cancelledBy), JSON.stringify({ purchase_id: purchase.purchaseId,
           reason })],
      );
    }
    const reversed = await client.query<{ id: string }>(
      `SELECT finance.reverse_matriz_ledger_transaction(
         $1::env_t,$2,'commerce.wholesale_purchase.cancel',$3,
         ($4::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
         $5,$6,NULL,$7::jsonb
       ) id`,
      [
        purchase.environment, originalId, purchase.purchaseId, cancelledAt,
        'Cancelamento de compra nao paga', matrizLedgerActor(cancelledBy),
        JSON.stringify({ purchase_id: purchase.purchaseId, reason }),
      ],
    );
    return reversed.rows[0]!.id;
  }
  const assetAccount = purchase.stockApplied ? 'inventory' : 'inventory_in_transit';
  return postMatrizLedgerTransaction(client, {
    environment: purchase.environment,
    sourceType: 'commerce.wholesale_purchase.cancel',
    sourceId: purchase.purchaseId,
    kind: 'supplier_refund_receivable',
    amount,
    occurredAt: cancelledAt,
    description: 'Valor a recuperar por compra cancelada',
    createdBy: matrizLedgerActor(cancelledBy),
    lines: [
      ...(unpaid > 0 ? [{
        account_code: 'accounts_payable', account_class: 'liability' as const,
        side: 'debit' as const, amount: unpaid,
      }] : []),
      ...(refund > 0 ? [{
        account_code: 'supplier_refund_receivable',
        account_class: 'asset' as const,
        side: 'debit' as const,
        amount: refund,
      }] : []),
      { account_code: assetAccount, account_class: 'asset', side: 'credit', amount },
    ],
    metadata: { purchase_id: purchase.purchaseId, supplier_id: purchase.supplierId, reason,
      unpaid_amount: unpaid, refund_amount: refund },
  });
}
