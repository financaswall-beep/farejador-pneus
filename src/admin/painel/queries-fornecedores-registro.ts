import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { addWholesaleStockEntry } from './queries-galpao.js';
import { setGalpaoMovContext } from './queries-galpao-movimentos.js';
import {
  ensureWholesalePurchaseAccrual,
  postWholesalePurchaseReceipt,
} from './matriz-ledger-purchases.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult, moneyCents,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { canonicalPurchaseItems, type PurchaseItemInput } from './purchase-brand.js';
import { assertWholesalePurchaseMoney } from './purchase-money.js';
import { normalizeBusinessFactInstant } from '../../shared/business-time.js';
import {
  getPurchaseCatalogBlockers, type PurchaseCatalogBlocker,
} from './purchase-catalog-readiness.js';

export interface RegisterWholesalePurchaseInput {
  environment?: 'prod' | 'test';
  supplier_id?: string | null;
  new_supplier?: { name: string; phone?: string | null; document?: string | null } | null;
  items: PurchaseItemInput[];
  purchased_at?: string | null;
  paid_at?: string | null;
  notes?: string | null;
  created_by: string;
  payment_status?: 'paid' | 'pending';
  due_date?: string | null;
  receipt_status?: 'pending' | 'received';
  idempotency_key: string;
}

export interface RegisterWholesalePurchaseResult {
  purchase_id: string;
  supplier_id: string;
  supplier_name: string;
  total_amount: string;
  items_count: number;
  status: 'pending' | 'confirmed';
  stock_applied: boolean;
  catalog_blockers: PurchaseCatalogBlocker[];
}

async function resolveSupplier(
  client: PoolClient,
  environment: 'prod' | 'test',
  input: RegisterWholesalePurchaseInput,
): Promise<{ id: string; name: string }> {
  if (input.supplier_id) {
    const found = await client.query<{ id: string; name: string }>(
      `SELECT id,name FROM commerce.wholesale_suppliers
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL FOR SHARE`,
      [input.supplier_id, environment]);
    if (!found.rows[0]) throw new Error('supplier_not_found');
    return found.rows[0];
  }
  const name = input.new_supplier?.name.trim();
  if (!name) throw new Error('supplier_required');
  const created = await client.query<{ id: string; name: string }>(
    `INSERT INTO commerce.wholesale_suppliers (environment,name,phone,document)
     VALUES ($1,$2,$3,$4) RETURNING id,name`,
    [environment, name, input.new_supplier?.phone
      ? normalizeBrazilianPhone(input.new_supplier.phone) : null,
     input.new_supplier?.document?.trim() || null]);
  return created.rows[0]!;
}

async function applyPurchaseStock(
  client: PoolClient,
  environment: 'prod' | 'test',
  purchaseId: string,
  supplierName: string,
  items: PurchaseItemInput[],
): Promise<void> {
  await setGalpaoMovContext(client, { source: 'compra', reason: supplierName, ref: purchaseId });
  const consolidated = new Map<string, {
    measure: string; quantity: number; valueCents: number; brand: string;
    tire_condition: PurchaseItemInput['tire_condition'];
  }>();
  for (const item of items) {
    const brand = canonicalCatalogBrand(item.brand) ?? 'Sem marca';
    const key = `${item.measure}\u0000${brand}\u0000${item.tire_condition}`;
    const current = consolidated.get(key) ?? {
      measure: item.measure, quantity: 0, valueCents: 0, brand,
      tire_condition: item.tire_condition,
    };
    current.quantity += item.quantity;
    current.valueCents += moneyCents(item.unit_cost) * item.quantity;
    consolidated.set(key, current);
  }
  for (const [, item] of [...consolidated].sort(([a], [b]) => a.localeCompare(b))) {
    await addWholesaleStockEntry({ measure: item.measure, brand: item.brand,
      tire_condition: item.tire_condition, quantity_in: item.quantity,
      unit_cost: item.valueCents / item.quantity / 100, environment,
      actor_label: `compra:${purchaseId}` }, client);
  }
}

export async function registerWholesalePurchase(
  input: RegisterWholesalePurchaseInput,
  dbPool: Pool = defaultPool,
): Promise<RegisterWholesalePurchaseResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  assertWholesalePurchaseMoney(input.items ?? []);
  const requestNow = new Date();
  const purchasedAt = normalizeBusinessFactInstant(
    input.purchased_at, requestNow, 'purchased_at_future',
  );
  const paidAt = normalizeBusinessFactInstant(input.paid_at, requestNow, 'paid_at_future');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const rawItems = input.items ?? [];
    const receiptStatus = input.receipt_status ?? 'received';
    const operation = { environment, domain: 'wholesale_purchase.create',
      idempotencyKey: input.idempotency_key, fingerprint: operationFingerprint({
        supplier_id: input.supplier_id ?? null,
        new_supplier: input.new_supplier ? { name: input.new_supplier.name.trim(),
          phone: input.new_supplier.phone ? normalizeBrazilianPhone(input.new_supplier.phone) : null,
          document: input.new_supplier.document?.replace(/\D/g, '') || null } : null,
        purchased_at: input.purchased_at ?? null, paid_at: input.paid_at ?? null,
        notes: input.notes?.trim() || null,
        payment_status: input.payment_status ?? 'paid', due_date: input.due_date ?? null,
        receipt_status: receiptStatus,
        items: rawItems.map((item) => ({ measure: item.measure.trim(),
          brand: canonicalCatalogBrand(item.brand),
          tire_condition: item.tire_condition,
          quantity: item.quantity, unit_cost_cents: moneyCents(item.unit_cost) })),
      }) };
    const started = await beginIntegrityOperation<RegisterWholesalePurchaseResult>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }

    const items = await canonicalPurchaseItems(client, environment, rawItems, input.created_by);
    const supplier = await resolveSupplier(client, environment, input);
    const pendingPayment = env.WHOLESALE_FINANCE && input.payment_status === 'pending';
    const purchase = await client.query<{ id: string; purchased_at: string; paid_at: string | null }>(
      `INSERT INTO commerce.wholesale_purchases
        (environment,supplier_id,purchased_at,total_amount,status,stock_applied,
         stock_applied_at,stock_applied_by,created_by,notes,payment_status,due_date,paid_at)
       VALUES ($1,$2,COALESCE($3::timestamptz,now()),0,'pending',false,NULL,NULL,$4,$5,$6,$7::date,$8::timestamptz)
       RETURNING id,purchased_at,paid_at`,
      [environment, supplier.id, purchasedAt ?? null, input.created_by, input.notes ?? null,
       pendingPayment ? 'pending' : 'paid', pendingPayment ? (input.due_date ?? null) : null,
       env.WHOLESALE_FINANCE && !pendingPayment
         ? paidAt ?? purchasedAt ?? requestNow.toISOString() : null]);
    const purchaseId = purchase.rows[0]!.id;
    for (const item of items) {
      await client.query(
        `INSERT INTO commerce.wholesale_purchase_items
          (environment,purchase_id,measure,brand,tire_condition,quantity,unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          environment, purchaseId, item.measure, item.brand ?? null,
          item.tire_condition, item.quantity, item.unit_cost,
        ]);
    }
    const total = await client.query<{ total_amount: string }>(
      `UPDATE commerce.wholesale_purchases SET total_amount=COALESCE(
         (SELECT sum(line_total) FROM commerce.wholesale_purchase_items WHERE purchase_id=$1),0)
       WHERE id=$1 RETURNING total_amount`, [purchaseId]);
    const received = receiptStatus === 'received';
    if (received) {
      await applyPurchaseStock(client, environment, purchaseId, supplier.name, items);
      await client.query(
        `UPDATE commerce.wholesale_purchases
            SET status='confirmed',stock_applied=true,stock_applied_at=now(),stock_applied_by=$2
          WHERE id=$1`, [purchaseId, input.created_by]);
    }
    await ensureWholesalePurchaseAccrual(client, {
      environment, purchaseId, supplierId: supplier.id,
      totalAmount: total.rows[0]!.total_amount,
      purchasedAt: purchase.rows[0]!.purchased_at,
      paymentStatus: pendingPayment ? 'pending' : 'paid',
      dueDate: pendingPayment ? input.due_date ?? null : null,
      paidAt: purchase.rows[0]!.paid_at,
      stockApplied: received, createdBy: input.created_by,
    });
    const catalogBlockers = await getPurchaseCatalogBlockers(client, environment, items);
    const result = { purchase_id: purchaseId, supplier_id: supplier.id,
      supplier_name: supplier.name, total_amount: total.rows[0]!.total_amount,
      items_count: items.length, status: received ? 'confirmed' as const : 'pending' as const,
      stock_applied: received, catalog_blockers: catalogBlockers };
    await recordIntegrityEvent(client, { environment, domain: 'wholesale_purchase',
      entityTable: 'commerce.wholesale_purchases', entityId: purchaseId,
      eventType: received ? 'created_received' : 'created_pending', actorLabel: input.created_by,
      idempotencyKey: operation.idempotencyKey, after: result });
    await completeIntegrityOperation(client, operation, 'commerce.wholesale_purchases', purchaseId, result);
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
    fingerprint: operationFingerprint({ purchase_id: input.purchase_id }) };
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
    }>(
      `SELECT p.status,p.stock_applied,p.supplier_id,p.total_amount,p.purchased_at,
              p.payment_status,p.due_date,p.paid_at,p.created_by,s.name AS supplier_name
         FROM commerce.wholesale_purchases p
         JOIN commerce.wholesale_suppliers s ON s.id=p.supplier_id AND s.environment=p.environment
        WHERE p.id=$1 AND p.environment=$2 FOR UPDATE OF p`, [input.purchase_id, environment]);
    if (!purchase.rows[0]) throw new Error('purchase_not_found');
    if (purchase.rows[0].status !== 'pending' || purchase.rows[0].stock_applied) {
      throw new Error(purchase.rows[0].status === 'cancelled'
        ? 'purchase_already_cancelled' : 'purchase_already_confirmed');
    }
    const items = await client.query<PurchaseItemInput>(
      `SELECT measure,brand,tire_condition,quantity,unit_cost::float8 AS unit_cost
         FROM commerce.wholesale_purchase_items
        WHERE environment=$1 AND purchase_id=$2 ORDER BY measure,id`, [environment, input.purchase_id]);
    await applyPurchaseStock(client, environment, input.purchase_id,
      purchase.rows[0].supplier_name, items.rows);
    const updated = await client.query<{ stock_applied_at: string }>(
      `UPDATE commerce.wholesale_purchases
          SET status='confirmed',stock_applied=true,stock_applied_at=now(),stock_applied_by=$3
        WHERE id=$1 AND environment=$2 RETURNING stock_applied_at`,
      [input.purchase_id, environment, input.confirmed_by]);
    await postWholesalePurchaseReceipt(client, {
      environment, purchaseId: input.purchase_id,
      supplierId: purchase.rows[0].supplier_id,
      totalAmount: purchase.rows[0].total_amount,
      purchasedAt: purchase.rows[0].purchased_at,
      paymentStatus: purchase.rows[0].payment_status,
      dueDate: purchase.rows[0].due_date,
      paidAt: purchase.rows[0].paid_at,
      stockApplied: false,
      createdBy: purchase.rows[0].created_by,
    }, updated.rows[0]!.stock_applied_at, input.confirmed_by);
    const catalogBlockers = await getPurchaseCatalogBlockers(client, environment, items.rows);
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
