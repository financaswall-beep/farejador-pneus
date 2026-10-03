import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import {
  matrizLedgerActor, matrizLedgerAmount, postMatrizLedgerTransaction,
} from './matriz-ledger-posting.js';

export interface WholesaleSaleLedgerState {
  environment: 'prod' | 'test';
  orderId: string;
  buyerId: string;
  totalAmount: string | number;
  cogsAmount: string | number;
  soldAt: string;
  paymentStatus: 'paid' | 'pending';
  dueDate?: string | null;
  paidAt?: string | null;
  createdBy?: string | null;
  partnerTransferStatus?: 'in_transit' | 'settled' | 'received' | null;
}

export async function getWholesaleSaleLedgerState(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
): Promise<WholesaleSaleLedgerState> {
  const result = await client.query<{
    buyer_id: string; total_amount: string; cogs_amount: string; sold_at: string;
    payment_status: 'paid' | 'pending'; due_date: string | null;
    paid_at: string | null; created_by: string | null;
    partner_transfer_status: 'in_transit' | 'settled' | 'received' | null;
  }>(
    `SELECT o.buyer_id,COALESCE(o.settled_total_amount,o.total_amount) AS total_amount,
            CASE WHEN o.partner_transfer_status IN ('settled','received')
                   THEN COALESCE(o.partner_settled_at,o.sold_at)
                 ELSE o.sold_at END AS sold_at,
            o.payment_status,o.due_date,
            o.paid_at,o.created_by,o.partner_transfer_status,
            COALESCE(sum((CASE WHEN o.partner_transfer_status IN ('settled','received')
              THEN i.accepted_quantity ELSE i.quantity END)*i.unit_cost),0)::numeric(14,2)::text cogs_amount
       FROM commerce.wholesale_orders o
       LEFT JOIN commerce.wholesale_order_items i
         ON i.environment=o.environment AND i.order_id=o.id
      WHERE o.environment=$1 AND o.id=$2
      GROUP BY o.id,o.buyer_id,o.total_amount,o.settled_total_amount,
               o.partner_transfer_status,o.partner_settled_at,o.sold_at,o.payment_status,
               o.due_date,o.paid_at,o.created_by`,
    [environment, orderId],
  );
  if (!result.rows[0]) throw new Error('receivable_not_found');
  const row = result.rows[0];
  return {
    environment, orderId, buyerId: row.buyer_id,
    totalAmount: row.total_amount, cogsAmount: row.cogs_amount,
    soldAt: row.sold_at, paymentStatus: row.payment_status,
    dueDate: row.due_date, paidAt: row.paid_at, createdBy: row.created_by,
    partnerTransferStatus: row.partner_transfer_status,
  };
}

async function existingTransaction(
  client: PoolClient,
  sale: WholesaleSaleLedgerState,
  sourceType: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM finance.matriz_ledger_transactions
      WHERE environment=$1 AND source_type=$2 AND source_id=$3`,
    [sale.environment, sourceType, sale.orderId],
  );
  return result.rows[0]?.id ?? null;
}

export async function ensureWholesaleSaleRevenue(
  client: PoolClient,
  sale: WholesaleSaleLedgerState,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  if (sale.partnerTransferStatus === 'in_transit') return null;
  const amount = matrizLedgerAmount(sale.totalAmount, 'sale_ledger_amount_invalid');
  if (amount === 0) return null;
  const partnerRecognized = sale.partnerTransferStatus === 'settled'
    || sale.partnerTransferStatus === 'received';
  const sourceType = partnerRecognized
    ? 'commerce.wholesale_order.arrival_revenue'
    : 'commerce.wholesale_order.revenue';
  const existing = await existingTransaction(client, sale, sourceType)
    ?? (partnerRecognized
      ? await existingTransaction(client, sale, 'commerce.wholesale_order.revenue')
      : null);
  if (existing) return existing;
  const debitAccount = sale.paymentStatus === 'pending' ? 'accounts_receivable' : 'cash';
  return postMatrizLedgerTransaction(client, {
    environment: sale.environment, sourceType, sourceId: sale.orderId,
    kind: sale.paymentStatus === 'pending' ? 'sale_receivable' : 'sale_cash',
    amount, occurredAt: sale.soldAt,
    dueDate: sale.paymentStatus === 'pending' ? sale.dueDate : null,
    cashAt: sale.paymentStatus === 'paid' ? (sale.paidAt ?? sale.soldAt) : null,
    description: 'Receita de venda no atacado',
    createdBy: matrizLedgerActor(sale.createdBy),
    lines: [
      { account_code: debitAccount, account_class: 'asset', side: 'debit', amount },
      { account_code: 'sales_revenue', account_class: 'revenue', side: 'credit', amount },
    ],
    metadata: {
      order_id: sale.orderId, buyer_id: sale.buyerId,
      payment_status: sale.paymentStatus,
    },
  });
}

export async function ensureWholesaleSaleCogs(
  client: PoolClient,
  sale: WholesaleSaleLedgerState,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  if (sale.partnerTransferStatus === 'in_transit') return null;
  const amount = matrizLedgerAmount(sale.cogsAmount, 'sale_ledger_cogs_invalid');
  if (amount === 0) return null;
  const partnerTransfer = sale.partnerTransferStatus === 'settled'
    || sale.partnerTransferStatus === 'received';
  const sourceType = partnerTransfer
    ? 'commerce.wholesale_order.arrival_cogs'
    : 'commerce.wholesale_order.cogs';
  const existing = await existingTransaction(client, sale, sourceType)
    ?? (partnerTransfer
      ? await existingTransaction(client, sale, 'commerce.wholesale_order.cogs')
      : null);
  if (existing) return existing;
  return postMatrizLedgerTransaction(client, {
    environment: sale.environment, sourceType, sourceId: sale.orderId,
    kind: 'cost_of_goods_sold', amount, occurredAt: sale.soldAt,
    description: 'Custo dos pneus vendidos no atacado',
    createdBy: matrizLedgerActor(sale.createdBy),
    lines: [
      { account_code: 'cost_of_goods_sold', account_class: 'expense', side: 'debit', amount },
      { account_code: partnerTransfer ? 'inventory_in_transit' : 'inventory',
        account_class: 'asset', side: 'credit', amount },
    ],
    metadata: { order_id: sale.orderId, buyer_id: sale.buyerId },
  });
}

export async function postWholesaleSalePayment(
  client: PoolClient,
  sale: WholesaleSaleLedgerState,
  paidAt: string,
  paidBy?: string | null,
  details: import('./matriz-ledger-posting.js').MatrizLedgerPaymentDetails = {},
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const amount = matrizLedgerAmount(sale.totalAmount, 'sale_ledger_amount_invalid');
  if (amount === 0) return null;
  const obligationId = await ensureWholesaleSaleRevenue(client, {
    ...sale, paymentStatus: 'pending', paidAt: null,
  });
  if (!obligationId) return null;
  const paymentId = await postMatrizLedgerTransaction(client, {
    environment: sale.environment,
    sourceType: 'commerce.wholesale_order.payment', sourceId: sale.orderId,
    kind: 'payment', amount, occurredAt: paidAt, cashAt: paidAt,
    description: 'Recebimento de venda no atacado',
    createdBy: matrizLedgerActor(paidBy),
    lines: [
      { account_code: 'cash', account_class: 'asset', side: 'debit', amount },
      { account_code: 'accounts_receivable', account_class: 'asset', side: 'credit', amount },
    ],
    metadata: {
      order_id: sale.orderId, buyer_id: sale.buyerId,
      payment_method: details.payment_method?.trim() || null,
      cash_account: details.cash_account?.trim() || null,
      note: details.note?.trim() || null,
    },
  });
  await client.query(
    `SELECT finance.record_matriz_ledger_payment(
       $1::env_t,$2,$3,$4::timestamptz,$5,NULL
     )`,
    [sale.environment, obligationId, paymentId, paidAt, matrizLedgerActor(paidBy)],
  );
  return paymentId;
}

export { postWholesaleSaleCancellation } from './matriz-ledger-wholesale-cancel.js';
