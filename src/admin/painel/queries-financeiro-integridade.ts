import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getWholesalePurchaseLedgerState, postWholesalePurchasePayment } from './matriz-ledger-purchases.js';
import { getWholesaleSaleLedgerState, postWholesaleSalePayment } from './matriz-ledger-wholesale-sales.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
import { settleLinkedPartnerPayable } from './wholesale-partner-bridge.js';

export interface MatrizWriteOptions {
  idempotency_key: string;
  actor_label?: string | null;
  reason?: string | null;
  paid_at?: string | null;
  payment_method?: string | null;
  cash_account?: string | null;
  note?: string | null;
}

async function settleWholesalePayment(
  kind: 'order' | 'purchase',
  entityId: string,
  environment: 'prod' | 'test',
  dbPool: Pool,
  options: MatrizWriteOptions,
): Promise<{ id: string; paid_at: string }> {
  const client = await dbPool.connect();
  const sale = kind === 'order';
  const table = sale ? 'commerce.wholesale_orders' : 'commerce.wholesale_purchases';
  const domain = sale ? 'wholesale_sale.pay' : 'wholesale_purchase.pay';
  const operation = { environment, domain, idempotencyKey: options.idempotency_key,
    fingerprint: operationFingerprint({
      id: entityId, paid_at: options.paid_at ?? null,
      payment_method: options.payment_method?.trim().toLowerCase() ?? null,
      cash_account: options.cash_account?.trim().toLowerCase() ?? null,
      note: options.note?.trim() || null,
    }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<{ id: string; paid_at: string }>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const activeStatus = sale
      ? `status='confirmed' AND (partner_transfer_status IS NULL
          OR partner_transfer_status IN ('settled','received'))`
      : `status<>'cancelled'`;
    const current = await client.query<{ payment_status: string; total_amount: string }>(
      `SELECT payment_status,total_amount FROM ${table}
        WHERE id=$1 AND environment=$2 AND ${activeStatus} FOR UPDATE`, [entityId, environment]);
    const notFound = sale ? 'receivable_not_found' : 'payable_not_found';
    if (!current.rows[0] || current.rows[0].payment_status !== 'pending') throw new Error(notFound);
    const saleLedger = env.MATRIZ_CENTRAL_LEDGER && sale
      ? await getWholesaleSaleLedgerState(client, environment, entityId) : null;
    const purchaseLedger = env.MATRIZ_CENTRAL_LEDGER && !sale
      ? await getWholesalePurchaseLedgerState(client, environment, entityId) : null;
    const paidAt = options.paid_at ?? new Date().toISOString();
    const paid = await client.query<{ id: string; paid_at: string }>(
      `UPDATE ${table} SET payment_status='paid',paid_at=$3::timestamptz
        ${sale ? ',payment_method=COALESCE($4,payment_method)' : ''}
        WHERE id=$1 AND environment=$2 AND payment_status='pending' RETURNING id,paid_at`,
      sale
        ? [entityId, environment, paidAt, options.payment_method?.trim() || null]
        : [entityId, environment, paidAt]);
    if (!paid.rows[0]) throw new Error(notFound);
    const result = integrityResult(paid.rows[0]!);
    if (saleLedger) await postWholesaleSalePayment(
      client, saleLedger, result.paid_at, options.actor_label, options);
    if (sale) await settleLinkedPartnerPayable(
      client, environment, entityId, result.paid_at,
      options.actor_label ?? 'financeiro-matriz', options.payment_method,
    );
    if (purchaseLedger) await postWholesalePurchasePayment(
      client, purchaseLedger, result.paid_at, options.actor_label, options);
    await recordIntegrityEvent(client, { environment,
      domain: sale ? 'wholesale_sale' : 'wholesale_purchase', entityTable: table,
      entityId, eventType: 'payment_settled', actorLabel: options.actor_label,
      idempotencyKey: operation.idempotencyKey,
      before: { payment_status: 'pending', total_amount: current.rows[0].total_amount },
      after: {
        payment_status: 'paid', paid_at: result.paid_at,
        payment_method: options.payment_method?.trim() || null,
        cash_account: options.cash_account?.trim() || null,
        note: options.note?.trim() || null,
      } });
    await completeIntegrityOperation(client, operation, table, entityId, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function settleWholesaleOrderPayment(
  orderId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  options: MatrizWriteOptions,
): Promise<{ id: string; paid_at: string }> {
  return settleWholesalePayment('order', orderId, environment, dbPool, options);
}

export function settleWholesalePurchasePayment(
  purchaseId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  options: MatrizWriteOptions,
): Promise<{ id: string; paid_at: string }> {
  return settleWholesalePayment('purchase', purchaseId, environment, dbPool, options);
}

export * from './queries-financeiro-despesas-integridade.js';
export { removeMatrizExpense } from './queries-financeiro-despesas-remove.js';
