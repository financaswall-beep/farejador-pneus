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

/** Quita uma compra a prazo e liga a saida de caixa a obrigacao original. */
export async function postWholesalePurchasePayment(
  client: PoolClient,
  purchase: WholesalePurchaseLedgerState,
  paidAt: string,
  paidBy?: string | null,
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
    metadata: { purchase_id: purchase.purchaseId, supplier_id: purchase.supplierId },
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
