import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { addWholesaleStockEntry } from './queries-galpao.js';
import { setGalpaoMovContext } from './queries-galpao-movimentos.js';
import {
  ensureWholesalePurchaseAccrual,
  postWholesalePurchaseQuantityAdjustment,
  postWholesalePurchaseReceipt,
} from './matriz-ledger-purchases.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, integrityResult, moneyCents,
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
type AllocatedPurchaseItem = PurchaseItemInput & {
  id?: string;
  ordered_quantity?: number;
  accepted_quantity?: number | null;
  allocated_cost: number;
};

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
  supplier_reference?: string | null;
  purchase_order_id?: string | null;
  freight_amount?: number;
  discount_amount?: number;
  payment_method?: string | null;
  installments?: Array<{ due_date: string; amount: number }>;
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
  order_id: string;
  order_code: string;
  products_amount: string;
  freight_amount: string;
  discount_amount: string;
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
  items: AllocatedPurchaseItem[],
): Promise<void> {
  await setGalpaoMovContext(client, { source: 'compra', reason: supplierName, ref: purchaseId });
  const consolidated = new Map<string, {
    measure: string; quantity: number; valueCents: number; brand: string;
    tire_condition: PurchaseItemInput['tire_condition'];
  }>();
  for (const item of items) {
    const quantity = item.accepted_quantity ?? item.quantity;
    if (quantity <= 0) continue;
    const brand = canonicalCatalogBrand(item.brand) ?? 'Sem marca';
    const key = `${item.measure}\u0000${brand}\u0000${item.tire_condition}`;
    const current = consolidated.get(key) ?? {
      measure: item.measure, quantity: 0, valueCents: 0, brand,
      tire_condition: item.tire_condition,
    };
    current.quantity += quantity;
    current.valueCents += moneyCents(item.allocated_cost);
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
  calculateWholesalePurchaseMoney(
    input.items ?? [], input.freight_amount ?? 0, input.discount_amount ?? 0,
  );
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
        payment_method: input.payment_method?.trim() || null,
        supplier_reference: input.supplier_reference?.trim() || null,
        purchase_order_id: input.purchase_order_id ?? null,
        freight_amount_cents: moneyCents(input.freight_amount ?? 0),
        discount_amount_cents: moneyCents(input.discount_amount ?? 0),
        installments: (input.installments ?? []).map((row) => ({
          due_date: row.due_date, amount_cents: moneyCents(row.amount),
        })),
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

    const canonicalItems = await canonicalPurchaseItems(client, environment, rawItems, input.created_by);
    const totals = calculateWholesalePurchaseMoney(
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
         discount_amount,payment_method)
       VALUES ($1,$2,COALESCE($3::timestamptz,now()),$9,'pending',false,NULL,NULL,
         $4,$5,$6,$7::date,$8::timestamptz,$10,$11,$12,$13,$14,$15)
       RETURNING id,purchased_at,paid_at`,
      [environment, supplier.id, purchasedAt ?? null, input.created_by, input.notes ?? null,
       pendingPayment ? 'pending' : 'paid', dueDate,
       env.WHOLESALE_FINANCE && !pendingPayment
         ? paidAt ?? purchasedAt ?? requestNow.toISOString() : null,
       totals.totalCents / 100, order.id, input.supplier_reference?.trim() || null,
       totals.productsCents / 100, totals.freightCents / 100, totals.discountCents / 100,
       input.payment_method?.trim() || null]);
    const purchaseId = purchase.rows[0]!.id;
    for (const item of items) {
      await client.query(
        `INSERT INTO commerce.wholesale_purchase_items
          (environment,purchase_id,measure,brand,tire_condition,quantity,unit_cost,
           ordered_quantity,accepted_quantity,allocated_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8,$9)`,
        [
          environment, purchaseId, item.measure, item.brand ?? null,
          item.tire_condition, item.quantity, item.unit_cost,
          receiptStatus === 'received' ? item.quantity : null, item.allocated_cost,
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
      await applyPurchaseStock(client, environment, purchaseId, supplier.name, items);
      await client.query(
        `UPDATE commerce.wholesale_purchases
            SET status='confirmed',stock_applied=true,stock_applied_at=now(),stock_applied_by=$2
          WHERE id=$1`, [purchaseId, input.created_by]);
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
    const catalogBlockers = await getPurchaseCatalogBlockers(client, environment, items);
    const result = { purchase_id: purchaseId, supplier_id: supplier.id,
      supplier_name: supplier.name, total_amount: (totals.totalCents / 100).toFixed(2),
      items_count: items.length, status: received ? 'confirmed' as const : 'pending' as const,
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
    }>(
      `SELECT p.status,p.stock_applied,p.supplier_id,p.total_amount,p.purchased_at,
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
    const items = await client.query<AllocatedPurchaseItem>(
      `SELECT id,measure,brand,tire_condition,quantity,ordered_quantity,
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
    const adjusted = calculateWholesalePurchaseMoney(
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
