import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import {
  matrizLedgerActor, matrizLedgerAmount, postMatrizLedgerTransaction,
} from './matriz-ledger-posting.js';

interface RetailSaleLedgerState {
  environment: 'prod' | 'test';
  orderId: string;
  customerId: string | null;
  totalAmount: string;
  cogsAmount: string;
  occurredAt: string;
  cashAt: string;
  paymentMethod: string | null;
  dueDate: string | null;
  fulfillmentMode: string;
  cashRealized: boolean;
  stockDecremented: boolean;
  createdBy: string | null;
}

async function getRetailSaleState(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
): Promise<RetailSaleLedgerState | null> {
  const result = await client.query<{
    customer_id: string | null; total_amount: string; cogs_amount: string;
    occurred_at: string; cash_at: string; payment_method: string | null;
    payment_due_on: string | null;
    fulfillment_mode: string; cash_realized: boolean;
    stock_decremented: boolean; created_by: string | null;
  }>(
    `SELECT COALESCE(o.customer_id,o.contact_id) customer_id,o.total_amount,
            COALESCE(sum(i.quantity*i.matriz_unit_cost)
              FILTER (WHERE i.matriz_unit_cost IS NOT NULL),0)::numeric(14,2)::text cogs_amount,
            o.created_at occurred_at,
            COALESCE(o.delivered_at,o.closed_at,o.created_at) cash_at,
            o.payment_method,o.payment_due_on,o.fulfillment_mode,o.closed_by created_by,
            (o.payment_method IS NOT NULL
              AND lower(btrim(o.payment_method))<>'a receber'
              AND (
                (o.fulfillment_mode='delivery' AND o.delivery_status='delivered')
                OR
                (o.fulfillment_mode<>'delivery'
                  AND o.status IN ('confirmed','paid','delivered','cancelled'))
              )) cash_realized,
            EXISTS (
              SELECT 1 FROM audit.events a
               WHERE a.environment=o.environment
                 AND a.entity_id=o.id
                 AND a.event_type='matriz_galpao_decrement'
            ) stock_decremented
       FROM commerce.orders o
       JOIN core.units u
         ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
       LEFT JOIN commerce.order_items i
         ON i.environment=o.environment AND i.order_id=o.id
      WHERE o.environment=$1 AND o.id=$2 AND o.partner_order_id IS NULL
      GROUP BY o.id,o.customer_id,o.contact_id,o.total_amount,o.created_at,
               o.delivered_at,o.closed_at,o.payment_method,o.payment_due_on,o.fulfillment_mode,
               o.delivery_status,o.status,o.closed_by`,
    [environment, orderId],
  );
  const row = result.rows[0];
  return row ? {
    environment, orderId, customerId: row.customer_id,
    totalAmount: row.total_amount, cogsAmount: row.cogs_amount,
    occurredAt: row.occurred_at, cashAt: row.cash_at,
    paymentMethod: row.payment_method, dueDate: row.payment_due_on,
    fulfillmentMode: row.fulfillment_mode,
    cashRealized: row.cash_realized, stockDecremented: row.stock_decremented,
    createdBy: row.created_by,
  } : null;
}

async function existing(
  client: PoolClient,
  sale: RetailSaleLedgerState,
  sourceType: string,
): Promise<{ id: string; transaction_kind: string; amount: string } | null> {
  const result = await client.query<{ id: string; transaction_kind: string; amount: string }>(
    `SELECT id,transaction_kind,amount::text
       FROM finance.matriz_ledger_transactions
      WHERE environment=$1 AND source_type=$2 AND source_id=$3`,
    [sale.environment, sourceType, sale.orderId],
  );
  return result.rows[0] ?? null;
}

async function ensureRetailRevenue(
  client: PoolClient,
  sale: RetailSaleLedgerState,
): Promise<string | null> {
  const amount = matrizLedgerAmount(sale.totalAmount, 'retail_ledger_amount_invalid');
  if (amount === 0) return null;
  const sourceType = 'commerce.order.revenue';
  const found = await existing(client, sale, sourceType);
  if (found) return found.id;
  const debitAccount = sale.cashRealized ? 'cash' : 'accounts_receivable';
  return postMatrizLedgerTransaction(client, {
    environment: sale.environment, sourceType, sourceId: sale.orderId,
    kind: sale.cashRealized ? 'sale_cash' : 'sale_receivable',
    amount, occurredAt: sale.occurredAt,
    dueDate: sale.cashRealized ? null : sale.dueDate,
    cashAt: sale.cashRealized ? sale.cashAt : null,
    description: 'Receita de venda no varejo da Matriz',
    createdBy: matrizLedgerActor(sale.createdBy),
    lines: [
      { account_code: debitAccount, account_class: 'asset', side: 'debit', amount },
      { account_code: 'sales_revenue', account_class: 'revenue', side: 'credit', amount },
    ],
    metadata: {
      order_id: sale.orderId, customer_id: sale.customerId,
      payment_method: sale.paymentMethod, fulfillment_mode: sale.fulfillmentMode,
    },
  });
}

async function ensureRetailCogs(
  client: PoolClient,
  sale: RetailSaleLedgerState,
): Promise<string | null> {
  if (!sale.stockDecremented) return null;
  const amount = matrizLedgerAmount(sale.cogsAmount, 'retail_ledger_cogs_invalid');
  if (amount === 0) return null;
  const sourceType = 'commerce.order.cogs';
  const found = await existing(client, sale, sourceType);
  if (found) return found.id;
  return postMatrizLedgerTransaction(client, {
    environment: sale.environment, sourceType, sourceId: sale.orderId,
    kind: 'cost_of_goods_sold', amount, occurredAt: sale.occurredAt,
    description: 'Custo dos pneus vendidos no varejo',
    createdBy: matrizLedgerActor(sale.createdBy),
    lines: [
      { account_code: 'cost_of_goods_sold', account_class: 'expense', side: 'debit', amount },
      { account_code: 'inventory', account_class: 'asset', side: 'credit', amount },
    ],
    metadata: { order_id: sale.orderId, customer_id: sale.customerId },
  });
}

export async function postMatrizRetailSaleFacts(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
): Promise<void> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return;
  const sale = await getRetailSaleState(client, environment, orderId);
  if (!sale) return;
  await ensureRetailRevenue(client, sale);
  await ensureRetailCogs(client, sale);
}

export async function postMatrizRetailPaymentIfRealized(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  actorLabel?: string | null,
): Promise<string | null> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const sale = await getRetailSaleState(client, environment, orderId);
  if (!sale || !sale.cashRealized) return null;
  const amount = matrizLedgerAmount(sale.totalAmount, 'retail_ledger_amount_invalid');
  if (amount === 0) return null;
  const revenueId = await ensureRetailRevenue(client, { ...sale, cashRealized: false });
  if (!revenueId) return null;
  const revenue = await existing(client, sale, 'commerce.order.revenue');
  if (revenue?.transaction_kind === 'sale_cash') return null;
  const prior = await existing(client, sale, 'commerce.order.payment');
  if (prior) return prior.id;
  const paymentId = await postMatrizLedgerTransaction(client, {
    environment, sourceType: 'commerce.order.payment', sourceId: orderId,
    kind: 'payment', amount, occurredAt: sale.cashAt, cashAt: sale.cashAt,
    description: 'Recebimento de venda no varejo',
    createdBy: matrizLedgerActor(actorLabel),
    lines: [
      { account_code: 'cash', account_class: 'asset', side: 'debit', amount },
      { account_code: 'accounts_receivable', account_class: 'asset', side: 'credit', amount },
    ],
    metadata: { order_id: orderId, customer_id: sale.customerId },
  });
  await client.query(
    `SELECT finance.record_matriz_ledger_payment(
       $1::env_t,$2,$3,$4::timestamptz,$5,NULL
     )`,
    [environment, revenueId, paymentId, sale.cashAt, matrizLedgerActor(actorLabel)],
  );
  return paymentId;
}

async function reverseRetailTransaction(
  client: PoolClient,
  sale: RetailSaleLedgerState,
  originalId: string,
  sourceType: string,
  cancelledAt: string,
  actorLabel: string,
  description: string,
  reason: string,
): Promise<void> {
  await client.query(
    `SELECT finance.reverse_matriz_ledger_transaction(
       $1::env_t,$2,$3,$4,
       ($5::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
       $6,$7,NULL,$8::jsonb
     )`,
    [
      sale.environment, originalId, sourceType, sale.orderId, cancelledAt,
      description, matrizLedgerActor(actorLabel),
      JSON.stringify({ order_id: sale.orderId, reason }),
    ],
  );
}

export async function postMatrizRetailCancellation(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  cancelledAt: string,
  actorLabel: string,
  reason: string,
): Promise<void> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return;
  const sale = await getRetailSaleState(client, environment, orderId);
  if (!sale) return;
  const revenue = await existing(client, sale, 'commerce.order.revenue');
  if (revenue) {
    const balanceResult = await client.query<{ balance: string }>(
      `SELECT finance.matriz_ledger_obligation_balance($1::env_t,$2)::text balance`,
      [environment, revenue.id],
    );
    const balance = revenue.transaction_kind === 'sale_receivable'
      ? Number(balanceResult.rows[0]?.balance ?? 0) : 0;
    const amount = matrizLedgerAmount(revenue.amount, 'retail_ledger_amount_invalid');
    if (revenue.transaction_kind === 'sale_receivable' && balance === amount) {
      await reverseRetailTransaction(client, sale, revenue.id,
        'commerce.order.revenue_cancel', cancelledAt, actorLabel,
        'Cancelamento de venda nao recebida', reason);
    } else {
      const refund = Math.max(amount - balance, 0);
      const credits = [
        ...(balance > 0 ? [{
          account_code: 'accounts_receivable', account_class: 'asset' as const,
          side: 'credit' as const, amount: balance,
        }] : []),
        ...(refund > 0 ? [{
          account_code: 'customer_refund_payable', account_class: 'liability' as const,
          side: 'credit' as const, amount: refund,
        }] : []),
      ];
      await postMatrizLedgerTransaction(client, {
        environment, sourceType: 'commerce.order.revenue_cancel', sourceId: orderId,
        kind: 'customer_refund_payable', amount, occurredAt: cancelledAt,
        description: 'Cancelamento financeiro de venda no varejo',
        createdBy: matrizLedgerActor(actorLabel),
        lines: [
          { account_code: 'sales_returns', account_class: 'revenue', side: 'debit', amount },
          ...credits,
        ],
        metadata: { order_id: orderId, reason, unpaid_amount: balance, refund_amount: refund },
      });
    }
  }
  const cogs = await existing(client, sale, 'commerce.order.cogs');
  if (cogs) {
    const returned = await client.query(
      `SELECT 1 FROM audit.events
        WHERE environment=$1 AND entity_id=$2
          AND event_type='matriz_galpao_return' LIMIT 1`,
      [environment, orderId],
    );
    if (returned.rows[0]) await reverseRetailTransaction(client, sale, cogs.id,
      'commerce.order.cogs_cancel', cancelledAt, actorLabel,
      'Retorno do custo ao estoque no cancelamento', reason);
  }
}
