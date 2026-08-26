import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import {
  matrizLedgerActor, matrizLedgerAmount, postMatrizLedgerTransaction,
} from './matriz-ledger-posting.js';

export interface WholesalePurchaseLedgerState {
  environment: 'prod' | 'test';
  purchaseId: string;
  supplierId: string;
  totalAmount: string | number;
  purchasedAt: string;
  paymentStatus: 'paid' | 'pending';
  dueDate?: string | null;
  paidAt?: string | null;
  stockApplied: boolean;
  createdBy?: string | null;
}

export async function getWholesalePurchaseLedgerState(
  client: PoolClient,
  environment: 'prod' | 'test',
  purchaseId: string,
): Promise<WholesalePurchaseLedgerState> {
  const result = await client.query<{
    supplier_id: string; total_amount: string; purchased_at: string;
    payment_status: 'paid' | 'pending'; due_date: string | null;
    paid_at: string | null; stock_applied: boolean; created_by: string | null;
  }>(
    `SELECT supplier_id,total_amount,purchased_at,payment_status,due_date,
            paid_at,stock_applied,created_by
       FROM commerce.wholesale_purchases
      WHERE environment=$1 AND id=$2`,
    [environment, purchaseId],
  );
  if (!result.rows[0]) throw new Error('payable_not_found');
  const row = result.rows[0];
  return {
    environment, purchaseId, supplierId: row.supplier_id,
    totalAmount: row.total_amount, purchasedAt: row.purchased_at,
    paymentStatus: row.payment_status, dueDate: row.due_date,
    paidAt: row.paid_at, stockApplied: row.stock_applied, createdBy: row.created_by,
  };
}

/** Registra a aquisicao. Mercadoria ainda nao recebida fica em estoque em transito. */
export async function ensureWholesalePurchaseAccrual(
  client: PoolClient,
  purchase: WholesalePurchaseLedgerState,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const amount = matrizLedgerAmount(purchase.totalAmount, 'purchase_ledger_amount_invalid');
  if (amount === 0) return null;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM finance.matriz_ledger_transactions
      WHERE environment=$1
        AND source_type='commerce.wholesale_purchase.accrual'
        AND source_id=$2`,
    [purchase.environment, purchase.purchaseId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const inventoryAccount = purchase.stockApplied ? 'inventory' : 'inventory_in_transit';
  const creditAccount = purchase.paymentStatus === 'pending' ? 'accounts_payable' : 'cash';
  return postMatrizLedgerTransaction(client, {
    environment: purchase.environment,
    sourceType: 'commerce.wholesale_purchase.accrual',
    sourceId: purchase.purchaseId,
    kind: purchase.paymentStatus === 'pending' ? 'purchase_payable' : 'purchase_cash',
    amount,
    occurredAt: purchase.purchasedAt,
    dueDate: purchase.paymentStatus === 'pending' ? purchase.dueDate : null,
    cashAt: purchase.paymentStatus === 'paid' ? (purchase.paidAt ?? purchase.purchasedAt) : null,
    description: 'Compra formal de pneus',
    createdBy: matrizLedgerActor(purchase.createdBy),
    lines: [
      { account_code: inventoryAccount, account_class: 'asset', side: 'debit', amount },
      {
        account_code: creditAccount,
        account_class: creditAccount === 'cash' ? 'asset' : 'liability',
        side: 'credit',
        amount,
      },
    ],
    metadata: {
      purchase_id: purchase.purchaseId,
      supplier_id: purchase.supplierId,
      stock_applied: purchase.stockApplied,
      payment_status: purchase.paymentStatus,
    },
  });
}

/** Transfere o valor de mercadoria em transito para o estoque disponivel. */
export async function postWholesalePurchaseReceipt(
  client: PoolClient,
  purchase: WholesalePurchaseLedgerState,
  receivedAt: string,
  receivedBy: string,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const amount = matrizLedgerAmount(purchase.totalAmount, 'purchase_ledger_amount_invalid');
  if (amount === 0) return null;
  await ensureWholesalePurchaseAccrual(client, { ...purchase, stockApplied: false });
  return postMatrizLedgerTransaction(client, {
    environment: purchase.environment,
    sourceType: 'commerce.wholesale_purchase.receipt',
    sourceId: purchase.purchaseId,
    kind: 'inventory_transfer',
    amount,
    occurredAt: receivedAt,
    description: 'Recebimento de compra no galpao',
    createdBy: matrizLedgerActor(receivedBy),
    lines: [
      { account_code: 'inventory', account_class: 'asset', side: 'debit', amount },
      { account_code: 'inventory_in_transit', account_class: 'asset', side: 'credit', amount },
    ],
    metadata: { purchase_id: purchase.purchaseId, supplier_id: purchase.supplierId },
  });
}

/**
 * Ajusta, sem editar o livro, a diferença encontrada na conferência física.
 * A redução primeiro baixa o saldo ainda aberto; qualquer valor já pago a
 * maior vira crédito real contra o fornecedor.
 */
export async function postWholesalePurchaseQuantityAdjustment(
  client: PoolClient,
  purchase: WholesalePurchaseLedgerState,
  acceptedTotal: number,
  adjustedBy: string,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const originalCents = Math.round(matrizLedgerAmount(
    purchase.totalAmount, 'purchase_ledger_amount_invalid',
  ) * 100);
  const acceptedCents = Math.round(matrizLedgerAmount(
    acceptedTotal, 'purchase_ledger_amount_invalid',
  ) * 100);
  if (acceptedCents > originalCents) throw new Error('purchase_receipt_exceeds_order');
  const reductionCents = originalCents - acceptedCents;
  if (reductionCents === 0) return null;
  const obligationId = await ensureWholesalePurchaseAccrual(client, purchase);
  if (!obligationId) return null;
  let payableCents = 0;
  if (purchase.paymentStatus === 'pending') {
    const balance = await client.query<{ balance: string }>(
      `SELECT finance.matriz_ledger_obligation_balance($1::env_t,$2)::text balance`,
      [purchase.environment, obligationId],
    );
    payableCents = Math.min(reductionCents,
      Math.max(0, Math.round(Number(balance.rows[0]?.balance ?? 0) * 100)));
  }
  const refundCents = reductionCents - payableCents;
  const amount = reductionCents / 100;
  const lines: import('./matriz-ledger-posting.js').MatrizLedgerLine[] = [];
  if (payableCents > 0) lines.push({ account_code: 'accounts_payable',
    account_class: 'liability', side: 'debit', amount: payableCents / 100 });
  if (refundCents > 0) lines.push({ account_code: 'supplier_refund_receivable',
    account_class: 'asset', side: 'debit', amount: refundCents / 100 });
  lines.push({ account_code: purchase.stockApplied ? 'inventory' : 'inventory_in_transit',
    account_class: 'asset', side: 'credit', amount });
  const occurredAt = new Date().toISOString();
  const adjustmentId = await postMatrizLedgerTransaction(client, {
    environment: purchase.environment,
    sourceType: 'commerce.wholesale_purchase.adjustment',
    sourceId: purchase.purchaseId,
    kind: 'purchase_quantity_adjustment', amount,
    occurredAt,
    description: 'Ajuste da compra pela quantidade aceita no recebimento',
    createdBy: matrizLedgerActor(adjustedBy), lines,
    metadata: { purchase_id: purchase.purchaseId, supplier_id: purchase.supplierId,
      original_total: originalCents / 100, accepted_total: acceptedCents / 100,
      payable_reduction: payableCents / 100, supplier_refund: refundCents / 100 },
  });
  if (payableCents > 0) {
    await client.query(
      `INSERT INTO finance.matriz_ledger_payments
        (environment,obligation_transaction_id,payment_transaction_id,
         payment_kind,amount,paid_at,created_by)
       VALUES ($1,$2,$3,'adjustment',$4,$5::timestamptz,$6)`,
      [purchase.environment, obligationId, adjustmentId, payableCents / 100,
       occurredAt, matrizLedgerActor(adjustedBy)],
    );
    const remaining = await client.query<{ balance: string }>(
      `SELECT finance.matriz_ledger_obligation_balance($1::env_t,$2)::text balance`,
      [purchase.environment, obligationId],
    );
    if (Number(remaining.rows[0]?.balance ?? 0) === 0) {
      await client.query(
        `UPDATE commerce.wholesale_purchases
            SET payment_status='paid',paid_at=COALESCE(paid_at,$3::timestamptz)
          WHERE environment=$1 AND id=$2`,
        [purchase.environment, purchase.purchaseId, occurredAt],
      );
    }
  }
  return adjustmentId;
}

/** Quita uma compra a prazo e liga a saida de caixa a obrigacao original. */
export async function postWholesalePurchasePayment(
  client: PoolClient,
  purchase: WholesalePurchaseLedgerState,
  paidAt: string,
  paidBy?: string | null,
  details: import('./matriz-ledger-posting.js').MatrizLedgerPaymentDetails = {},
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const amount = matrizLedgerAmount(purchase.totalAmount, 'purchase_ledger_amount_invalid');
  if (amount === 0) return null;
  const obligationId = await ensureWholesalePurchaseAccrual(client, {
    ...purchase, paymentStatus: 'pending', paidAt: null,
  });
  if (!obligationId) return null;
  const paymentId = await postMatrizLedgerTransaction(client, {
    environment: purchase.environment,
    sourceType: 'commerce.wholesale_purchase.payment',
    sourceId: purchase.purchaseId,
    kind: 'payment',
    amount,
    occurredAt: paidAt,
    cashAt: paidAt,
    description: 'Pagamento de compra de pneus',
    createdBy: matrizLedgerActor(paidBy),
    lines: [
      { account_code: 'accounts_payable', account_class: 'liability', side: 'debit', amount },
      { account_code: 'cash', account_class: 'asset', side: 'credit', amount },
    ],
    metadata: {
      purchase_id: purchase.purchaseId, supplier_id: purchase.supplierId,
      payment_method: details.payment_method?.trim() || null,
      cash_account: details.cash_account?.trim() || null,
      note: details.note?.trim() || null,
    },
  });
  await client.query(
    `SELECT finance.record_matriz_ledger_payment(
       $1::env_t,$2,$3,$4::timestamptz,$5,NULL
     )`,
    [purchase.environment, obligationId, paymentId, paidAt, matrizLedgerActor(paidBy)],
  );
  return paymentId;
}

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
  if (purchase.paymentStatus === 'pending') {
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
      {
        account_code: 'supplier_refund_receivable',
        account_class: 'asset',
        side: 'debit',
        amount,
      },
      { account_code: assetAccount, account_class: 'asset', side: 'credit', amount },
    ],
    metadata: { purchase_id: purchase.purchaseId, supplier_id: purchase.supplierId, reason },
  });
}
