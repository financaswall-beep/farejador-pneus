import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { ensureWholesalePurchaseAccrual } from './matriz-ledger-purchases.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, moneyCents,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { canonicalPurchaseItems, type PurchaseItemInput } from './purchase-brand.js';
import { calculateWholesalePurchaseMoney } from './purchase-money.js';
import { normalizeBusinessFactInstant } from '../../shared/business-time.js';
import {
  getPurchaseCatalogBlockers, type PurchaseCatalogBlocker,
} from './purchase-catalog-readiness.js';
import { resolveWholesalePurchaseOrder } from './queries-purchase-orders.js';
import { calculateLotPurchaseMoney, type PurchaseLotInput } from './lot-purchase-money.js';
import { insertPurchaseLot, receivePurchaseLot } from './lot-purchase-stock.js';
import { resolveSupplier, applyPurchaseStock, type AllocatedPurchaseItem } from './purchase-registration-helpers.js';
import { linkPurchaseGroupInTransaction } from './purchase-group-links.js';

export interface RegisterWholesalePurchaseInput {
  group_id?: string | null;
  environment?: 'prod' | 'test';
  supplier_id?: string | null;
  new_supplier?: { name: string; phone?: string | null; document?: string | null } | null;
  items: PurchaseItemInput[];
  lot?: PurchaseLotInput;
  received_at?: string;
  purchased_at?: string | null;
  paid_at?: string | null;
  notes?: string | null;
  created_by: string;
  payment_status?: 'paid' | 'pending';
  due_date?: string | null;
  receipt_status?: 'pending' | 'received';
  supplier_reference?: string | null;
  purchase_order_id?: string | null;
  freight_amount?: number;
  discount_amount?: number;
  payment_method?: string | null;
  installments?: Array<{ due_date: string; amount: number }>;
  idempotency_key: string;
}

export interface RegisterWholesalePurchaseResult {
  lot_id?: string;
  lot_code?: string;
  purchase_id: string;
  supplier_id: string;
  supplier_name: string;
  total_amount: string;
  items_count: number;
  status: 'pending' | 'confirmed';
  stock_applied: boolean;
  order_id: string;
  order_code: string;
  products_amount: string;
  freight_amount: string;
  discount_amount: string;
  catalog_blockers: PurchaseCatalogBlocker[];
}

export async function registerWholesalePurchaseOnClient(
  client: PoolClient,
  input: RegisterWholesalePurchaseInput,
): Promise<RegisterWholesalePurchaseResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const lotTotals = input.lot
    ? calculateLotPurchaseMoney(input.lot, input.freight_amount ?? 0, input.discount_amount ?? 0)
    : null;
  if (input.lot && input.items.length) throw new Error('purchase_kind_items_mismatch');
  if (input.payment_status === 'pending' && !env.WHOLESALE_FINANCE) {
    throw new Error('wholesale_finance_disabled');
  }
  if (!lotTotals) calculateWholesalePurchaseMoney(
    input.items ?? [], input.freight_amount ?? 0, input.discount_amount ?? 0);
  const requestNow = new Date();
  const purchasedAt = normalizeBusinessFactInstant(
    input.purchased_at, requestNow, 'purchased_at_future',
  );
  const paidAt = normalizeBusinessFactInstant(input.paid_at, requestNow, 'paid_at_future');
  const receivedAt = input.lot
    ? normalizeBusinessFactInstant(input.received_at, requestNow, 'received_at_future') : null;
  const rawItems = input.items ?? [];
  const receiptStatus = input.receipt_status ?? 'received';
  const operation = { environment, domain: 'wholesale_purchase.create',
    idempotencyKey: input.idempotency_key, fingerprint: operationFingerprint({
      ...(input.group_id ? { group_id: input.group_id } : {}),
      supplier_id: input.supplier_id ?? null,
      new_supplier: input.new_supplier ? { name: input.new_supplier.name.trim(),
        phone: input.new_supplier.phone ? normalizeBrazilianPhone(input.new_supplier.phone) : null,
        document: input.new_supplier.document?.replace(/\D/g, '') || null } : null,
      purchased_at: input.purchased_at ?? null, paid_at: input.paid_at ?? null,
      notes: input.notes?.trim() || null,
      payment_status: input.payment_status ?? 'paid', due_date: input.due_date ?? null,
      payment_method: input.payment_method?.trim() || null,
      supplier_reference: input.supplier_reference?.trim() || null,
      purchase_order_id: input.purchase_order_id ?? null,
      freight_amount_cents: moneyCents(input.freight_amount ?? 0),
      discount_amount_cents: moneyCents(input.discount_amount ?? 0),
      installments: (input.installments ?? []).map((row) => ({
        due_date: row.due_date, amount_cents: moneyCents(row.amount),
      })),
      receipt_status: receiptStatus,
      ...(input.lot ? { lot: { description: input.lot.description.trim(),
        ...(input.lot.vehicle_type ? {vehicle_type: input.lot.vehicle_type} : {}),
        quantity: input.lot.quantity, total_cost_cents: moneyCents(input.lot.total_cost) },
        received_at: input.received_at ?? null } : {}),
      items: rawItems.map((item) => ({ measure: item.measure.trim(),
        brand: canonicalCatalogBrand(item.brand),
        tire_condition: item.tire_condition,
        ...(item.vehicle_type ? {vehicle_type: item.vehicle_type} : {}),
        quantity: item.quantity, unit_cost_cents: moneyCents(item.unit_cost) })),
    }) };
  const started = await beginIntegrityOperation<RegisterWholesalePurchaseResult>(client, operation);
  if (started.replayed) return started.result;

  const canonicalItems = input.lot ? [] : await canonicalPurchaseItems(client, environment, rawItems, input.created_by);
  const totals = lotTotals ?? calculateWholesalePurchaseMoney(
    canonicalItems, input.freight_amount ?? 0, input.discount_amount ?? 0,
  );
  const items: AllocatedPurchaseItem[] = canonicalItems.map((item, index) => ({
    ...item, allocated_cost: totals.allocatedItemCents[index]! / 100,
  }));
  const supplier = await resolveSupplier(client, environment, input);
  const order = await resolveWholesalePurchaseOrder(
    client, environment, supplier.id, input.created_by, input.purchase_order_id,
  );
  const pendingPayment = env.WHOLESALE_FINANCE && input.payment_status === 'pending';
  if (pendingPayment && !input.due_date && !input.installments?.length) throw new Error('due_date_required');
  const installments = pendingPayment
    ? (input.installments?.length ? input.installments : [{
      due_date: input.due_date!, amount: totals.totalCents / 100,
    }]).map((row, index) => ({ ...row, installment_number: index + 1 })) : [];
  if (pendingPayment && (totals.totalCents <= 0
    || installments.reduce((sum, row) => sum + moneyCents(row.amount), 0)
      !== totals.totalCents)) {
    throw new Error('installments_total_mismatch');
  }
  const dueDate = installments.length
    ? [...installments].sort((a, b) => a.due_date.localeCompare(b.due_date))[0]!.due_date
    : null;
  const purchase = await client.query<{ id: string; purchased_at: string; paid_at: string | null }>(
    `INSERT INTO commerce.wholesale_purchases
      (environment,supplier_id,purchased_at,total_amount,status,stock_applied,
       stock_applied_at,stock_applied_by,created_by,notes,payment_status,due_date,paid_at,
       purchase_order_id,supplier_reference,products_amount,freight_amount,
       discount_amount,payment_method,purchase_kind)
     VALUES ($1,$2,COALESCE($3::timestamptz,now()),$9,'pending',false,NULL,NULL,
       $4,$5,$6,$7::date,$8::timestamptz,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id,purchased_at,paid_at`,
    [environment, supplier.id, purchasedAt ?? null, input.created_by, input.notes ?? null,
     pendingPayment ? 'pending' : 'paid', dueDate,
     env.WHOLESALE_FINANCE && !pendingPayment
       ? paidAt ?? purchasedAt ?? requestNow.toISOString() : null,
     totals.totalCents / 100, order.id, input.supplier_reference?.trim() || null,
     totals.productsCents / 100, totals.freightCents / 100, totals.discountCents / 100,
     input.payment_method?.trim() || null, input.lot ? 'lot' : 'catalog']);
  const purchaseId = purchase.rows[0]!.id;
  await linkPurchaseGroupInTransaction(client, { environment, group_id: input.group_id,
    kind: 'purchase', record_id: purchaseId, actor: input.created_by, idempotency_key: input.idempotency_key });
  const lotRecord = input.lot
    ? await insertPurchaseLot(client, environment, purchaseId, input.lot, totals.totalCents / 100)
    : null;
  for (const item of items) {
    await client.query(
      `INSERT INTO commerce.wholesale_purchase_items
        (environment,purchase_id,measure,brand,tire_condition,quantity,unit_cost,
         ordered_quantity,accepted_quantity,allocated_cost,vehicle_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10)`,
      [
        environment, purchaseId, item.measure, item.brand ?? null,
        item.tire_condition, item.quantity, item.unit_cost,
        receiptStatus === 'received' ? item.quantity : null, item.allocated_cost, item.vehicle_type ?? null,
      ]);
  }
  for (const installment of installments) {
    await client.query(
      `INSERT INTO commerce.wholesale_purchase_installments
        (environment,purchase_id,installment_number,due_date,amount)
       VALUES ($1,$2,$3,$4::date,$5)`,
      [environment, purchaseId, installment.installment_number,
       installment.due_date, installment.amount],
    );
  }
  const received = receiptStatus === 'received';
  if (received) {
    if (input.lot) await receivePurchaseLot(client, environment, purchaseId,
      input.created_by, receivedAt ?? requestNow.toISOString());
    else await applyPurchaseStock(client, environment, purchaseId, supplier.name, items);
    await client.query(
      `UPDATE commerce.wholesale_purchases
          SET status='confirmed',stock_applied=true,stock_applied_at=COALESCE($3::timestamptz,now()),stock_applied_by=$2
        WHERE id=$1`, [purchaseId, input.created_by, receivedAt]);
  }
  await ensureWholesalePurchaseAccrual(client, {
    environment, purchaseId, supplierId: supplier.id,
    totalAmount: totals.totalCents / 100,
    purchasedAt: purchase.rows[0]!.purchased_at,
    paymentStatus: pendingPayment ? 'pending' : 'paid',
    dueDate,
    paidAt: purchase.rows[0]!.paid_at,
    stockApplied: received, createdBy: input.created_by,
  });
  const catalogBlockers = input.lot ? [] : await getPurchaseCatalogBlockers(client, environment, items);
  const result = { purchase_id: purchaseId, supplier_id: supplier.id,
    supplier_name: supplier.name, total_amount: (totals.totalCents / 100).toFixed(2),
    items_count: input.lot ? 1 : items.length, status: received ? 'confirmed' as const : 'pending' as const,
    ...(lotRecord ? { lot_id: lotRecord.id, lot_code: lotRecord.lot_code } : {}),
    stock_applied: received, order_id: order.id, order_code: order.order_code,
    products_amount: (totals.productsCents / 100).toFixed(2),
    freight_amount: (totals.freightCents / 100).toFixed(2),
    discount_amount: (totals.discountCents / 100).toFixed(2),
    catalog_blockers: catalogBlockers };
  await recordIntegrityEvent(client, { environment, domain: 'wholesale_purchase',
    entityTable: 'commerce.wholesale_purchases', entityId: purchaseId,
    eventType: received ? 'created_received' : 'created_pending', actorLabel: input.created_by,
    idempotencyKey: operation.idempotencyKey, after: result });
  await completeIntegrityOperation(client, operation, 'commerce.wholesale_purchases', purchaseId, result);
  return result;
}
