import { restorePurchaseCredits } from './supplier-advance-ledger.js';
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  postWholesalePurchaseQuantityAdjustment,
  postWholesalePurchaseReceipt,
} from './matriz-ledger-purchases.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult, moneyCents,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
import { calculateReceivedPurchaseMoney } from './purchase-money.js';
import {
  getPurchaseCatalogBlockers, type PurchaseCatalogBlocker,
} from './purchase-catalog-readiness.js';
import { confirmLotPurchaseStock } from './lot-purchase-stock.js';
import { applyPurchaseStock, type AllocatedPurchaseItem } from './purchase-registration-helpers.js';
import {
  registerWholesalePurchaseOnClient, type RegisterWholesalePurchaseInput, type RegisterWholesalePurchaseResult,
} from './register-wholesale-purchase.js';

export type { RegisterWholesalePurchaseInput, RegisterWholesalePurchaseResult } from './register-wholesale-purchase.js';

export async function registerWholesalePurchase(
  input: RegisterWholesalePurchaseInput,
  dbPool: Pool = defaultPool,
): Promise<RegisterWholesalePurchaseResult> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await registerWholesalePurchaseOnClient(client, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface ConfirmWholesalePurchaseInput {
  purchase_id: string;
  confirmed_by: string;
  environment?: 'prod' | 'test';
  idempotency_key: string;
  items?: Array<{ item_id: string; accepted_quantity: number }>;
}

export async function confirmWholesalePurchase(
  input: ConfirmWholesalePurchaseInput,
  dbPool: Pool = defaultPool,
): Promise<{ purchase_id: string; confirmed_at: string; stock_applied: true;
  catalog_blockers: PurchaseCatalogBlocker[] }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  const operation = { environment, domain: 'wholesale_purchase.confirm',
    idempotencyKey: input.idempotency_key,
    fingerprint: operationFingerprint({ purchase_id: input.purchase_id,
      items: input.items ?? null }) };
  try {
    await client.query('BEGIN');
    const started = await beginIntegrityOperation<{
      purchase_id: string; confirmed_at: string; stock_applied: true;
      catalog_blockers: PurchaseCatalogBlocker[];
    }>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }
    const purchase = await client.query<{
      status: string; stock_applied: boolean; supplier_name: string; supplier_id: string;
      total_amount: string; purchased_at: string; payment_status: 'paid' | 'pending';
      due_date: string | null; paid_at: string | null; created_by: string | null;
      products_amount: string; freight_amount: string; discount_amount: string;
      purchase_kind: string;
    }>(
      `SELECT p.purchase_kind,p.status,p.stock_applied,p.supplier_id,p.total_amount,p.purchased_at,
              p.payment_status,p.due_date,p.paid_at,p.created_by,p.products_amount,
              p.freight_amount,p.discount_amount,s.name AS supplier_name
         FROM commerce.wholesale_purchases p
         JOIN commerce.wholesale_suppliers s ON s.id=p.supplier_id AND s.environment=p.environment
        WHERE p.id=$1 AND p.environment=$2 FOR UPDATE OF p`, [input.purchase_id, environment]);
    if (!purchase.rows[0]) throw new Error('purchase_not_found');
    if (purchase.rows[0].status !== 'pending' || purchase.rows[0].stock_applied) {
      throw new Error(purchase.rows[0].status === 'cancelled'
        ? 'purchase_already_cancelled' : 'purchase_already_confirmed');
    }
    if (purchase.rows[0].purchase_kind === 'lot') {
      const row = purchase.rows[0];
      const result = await confirmLotPurchaseStock(client, {
        environment, purchaseId: input.purchase_id, supplierId: row.supplier_id,
        totalAmount: row.total_amount, purchasedAt: row.purchased_at,
        paymentStatus: row.payment_status, dueDate: row.due_date, paidAt: row.paid_at,
        stockApplied: false, createdBy: row.created_by,
      }, input.confirmed_by, input.items);
      await recordIntegrityEvent(client, { environment, domain: 'wholesale_purchase',
        entityTable: 'commerce.wholesale_purchases', entityId: input.purchase_id,
        eventType: 'stock_received', actorLabel: input.confirmed_by,
        idempotencyKey: operation.idempotencyKey, after: result });
      await completeIntegrityOperation(client, operation, 'commerce.wholesale_purchases', input.purchase_id, result);
      await client.query('COMMIT');
      return result;
    }
    const items = await client.query<AllocatedPurchaseItem>(
      `SELECT id,measure,brand,tire_condition,vehicle_type,quantity,ordered_quantity,
              accepted_quantity,unit_cost::float8 AS unit_cost,
              allocated_cost::float8 AS allocated_cost
         FROM commerce.wholesale_purchase_items
         WHERE environment=$1 AND purchase_id=$2 ORDER BY measure,id`, [environment, input.purchase_id]);
    const requested = new Map((input.items ?? []).map((row) => [row.item_id, row.accepted_quantity]));
    if (input.items && requested.size !== items.rows.length) {
      throw new Error('purchase_receipt_items_incomplete');
    }
    const effective = items.rows.map((item) => {
      const accepted = input.items ? requested.get(item.id!) : item.ordered_quantity ?? item.quantity;
      if (accepted === undefined || !Number.isInteger(accepted) || accepted < 0
        || accepted > (item.ordered_quantity ?? item.quantity)) {
        throw new Error('purchase_received_quantity_invalid');
      }
      return { ...item, accepted_quantity: accepted, quantity: accepted };
    });
    if (!effective.some((item) => item.quantity > 0)) {
      throw new Error('purchase_receipt_empty');
    }
    const adjusted = calculateReceivedPurchaseMoney(
      effective, Number(purchase.rows[0].freight_amount), Number(purchase.rows[0].discount_amount),
    );
    for (const [index, item] of effective.entries()) {
      item.allocated_cost = adjusted.allocatedItemCents[index]! / 100;
      await client.query(
        `UPDATE commerce.wholesale_purchase_items
            SET accepted_quantity=$3,allocated_cost=$4
          WHERE environment=$1 AND id=$2`,
        [environment, item.id, item.accepted_quantity, item.allocated_cost],
      );
    }
    const previousTotalCents = moneyCents(Number(purchase.rows[0].total_amount));
    if (adjusted.totalCents !== previousTotalCents) {
      if (env.MATRIZ_CENTRAL_LEDGER) {
        const row=(await client.query(`SELECT finance.matriz_ledger_obligation_balance(environment,id) balance
          FROM finance.matriz_ledger_transactions WHERE environment=$1 AND source_type='commerce.wholesale_purchase.accrual'
          AND transaction_kind='purchase_payable' AND source_id=$2`,[environment,input.purchase_id])).rows[0];
        if (row) {
          const excess=previousTotalCents-adjusted.totalCents-moneyCents(Number(row.balance));
          if (excess>0) {
            await restorePurchaseCredits(client,environment,input.purchase_id,input.confirmed_by,'Conferência de quantidade',excess/100);
            purchase.rows[0].payment_status=(await client.query('SELECT payment_status FROM commerce.wholesale_purchases WHERE environment=$1 AND id=$2',[environment,input.purchase_id])).rows[0].payment_status;
          }
        }
      }
      await postWholesalePurchaseQuantityAdjustment(client, {
        environment, purchaseId: input.purchase_id,
        supplierId: purchase.rows[0].supplier_id,
        totalAmount: purchase.rows[0].total_amount,
        purchasedAt: purchase.rows[0].purchased_at,
        paymentStatus: purchase.rows[0].payment_status,
        dueDate: purchase.rows[0].due_date,
        paidAt: purchase.rows[0].paid_at,
        stockApplied: false, createdBy: purchase.rows[0].created_by,
      }, adjusted.totalCents / 100, input.confirmed_by);
      await client.query(
        `UPDATE commerce.wholesale_purchases
            SET products_amount=$3,total_amount=$4
          WHERE environment=$1 AND id=$2`,
        [environment, input.purchase_id, adjusted.productsCents / 100,
         adjusted.totalCents / 100],
      );
      await client.query(
        `WITH ranked AS (
           SELECT id,COALESCE(sum(amount) OVER (ORDER BY installment_number
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) before
            FROM commerce.wholesale_purchase_installments
           WHERE environment=$1 AND purchase_id=$2
         )
         DELETE FROM commerce.wholesale_purchase_installments i USING ranked r
          WHERE i.id=r.id AND r.before >= $3::numeric`,
        [environment, input.purchase_id, adjusted.totalCents / 100],
      );
      await client.query(
        `WITH ranked AS (
           SELECT id,amount,COALESCE(sum(amount) OVER (ORDER BY installment_number
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) before
            FROM commerce.wholesale_purchase_installments
           WHERE environment=$1 AND purchase_id=$2
         )
         UPDATE commerce.wholesale_purchase_installments i
            SET amount=LEAST(r.amount,$3::numeric-r.before)
           FROM ranked r WHERE i.id=r.id AND r.before < $3::numeric`,
        [environment, input.purchase_id, adjusted.totalCents / 100],
      );
    }
    await applyPurchaseStock(client, environment, input.purchase_id,
      purchase.rows[0].supplier_name, effective);
    const updated = await client.query<{ stock_applied_at: string }>(
      `UPDATE commerce.wholesale_purchases
          SET status='confirmed',stock_applied=true,stock_applied_at=now(),stock_applied_by=$3
        WHERE id=$1 AND environment=$2 RETURNING stock_applied_at`,
      [input.purchase_id, environment, input.confirmed_by]);
    await postWholesalePurchaseReceipt(client, {
      environment, purchaseId: input.purchase_id,
      supplierId: purchase.rows[0].supplier_id,
      totalAmount: adjusted.totalCents / 100,
      purchasedAt: purchase.rows[0].purchased_at,
      paymentStatus: purchase.rows[0].payment_status,
      dueDate: purchase.rows[0].due_date,
      paidAt: purchase.rows[0].paid_at,
      stockApplied: false,
      createdBy: purchase.rows[0].created_by,
    }, updated.rows[0]!.stock_applied_at, input.confirmed_by);
    const catalogBlockers = await getPurchaseCatalogBlockers(client, environment, effective);
    const result = integrityResult({ purchase_id: input.purchase_id,
      confirmed_at: updated.rows[0]!.stock_applied_at, stock_applied: true as const,
      catalog_blockers: catalogBlockers });
    await recordIntegrityEvent(client, { environment, domain: 'wholesale_purchase',
      entityTable: 'commerce.wholesale_purchases', entityId: input.purchase_id,
      eventType: 'stock_received', actorLabel: input.confirmed_by,
      idempotencyKey: operation.idempotencyKey,
      before: { status: 'pending', stock_applied: false },
      after: { status: 'confirmed', stock_applied: true } });
    await completeIntegrityOperation(client, operation, 'commerce.wholesale_purchases', input.purchase_id, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
