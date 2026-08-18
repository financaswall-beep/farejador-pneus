import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { hasMatrizSellerColumn } from './payroll-schema.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyWholesaleStockDecrement } from './wholesale-stock.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import {
  ensureWholesaleSaleCogs, ensureWholesaleSaleRevenue, getWholesaleSaleLedgerState,
} from './matriz-ledger-wholesale-sales.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, moneyCents,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';
import {
  requireTireCondition,
  type TireCondition,
} from '../../shared/tire-condition.js';
import { assertWholesaleSaleMoney } from './sales-money.js';
import {
  createLinkedPartnerPurchase,
  resolveWholesalePartnerUnit,
} from './wholesale-partner-bridge.js';
import { resolveAdditionBuyer, resolveWholesaleBuyer } from './queries-atacado-sale-buyer.js';

interface SaleItemInput {
  measure: string;
  brand?: string | null;
  tire_condition: TireCondition | string;
  quantity: number;
  unit_price: number;
}

export interface RegisterWholesaleSaleInput {
  environment?: 'prod' | 'test';
  customer_id?: string | null;
  partner_id?: string | null;
  new_customer?: { name: string; phone?: string | null } | null;
  items: SaleItemInput[];
  sold_at?: string | null;
  paid_at?: string | null;
  notes?: string | null;
  created_by: string;
  seller_collaborator_id?: string | null;
  payment_status?: 'paid' | 'pending';
  due_date?: string | null;
  idempotency_key: string;
  parent_order_id?: string | null;
  partner_unit_id?: string | null;
}

export interface RegisterWholesaleSaleResult {
  order_id: string;
  buyer_id: string;
  buyer_name: string;
  total_amount: string;
  items_count: number;
  parent_order_id: string | null;
  partner_unit_id: string | null;
  linked_partner_purchase_id: string | null;
}

async function canonicalSaleItems(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: SaleItemInput[],
): Promise<SaleItemInput[]> {
  if (!items.length) throw new Error('items_required');
  const measures = new Map<string, string>();
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error('quantity_invalid');
    if (!Number.isFinite(item.unit_price) || item.unit_price < 0) throw new Error('price_invalid');
    const raw = item.measure.trim();
    if (!measures.has(raw)) {
      const catalog = await resolveMeasureInCatalog(client, environment, raw);
      if (!catalog) throw new Error('measure_not_in_catalog');
      measures.set(raw, catalog.measure);
    }
  }
  return items.map((item) => {
    const brand = canonicalCatalogBrand(item.brand) ?? 'Sem marca';
    const tireCondition = requireTireCondition(item.tire_condition ?? 'meia_vida');
    return {
      ...item, measure: measures.get(item.measure.trim())!,
      brand, tire_condition: tireCondition,
    };
  });
}

async function insertSaleHeader(
  client: PoolClient,
  environment: 'prod' | 'test',
  buyerId: string,
  partnerUnitId: string | null,
  input: RegisterWholesaleSaleInput,
): Promise<string> {
  const pending = env.WHOLESALE_FINANCE && input.payment_status === 'pending';
  const values = [environment, buyerId, input.sold_at ?? null, input.created_by,
    input.notes ?? null, pending ? 'pending' : 'paid', pending ? (input.due_date ?? null) : null,
    env.WHOLESALE_FINANCE && !pending
      ? input.paid_at ?? input.sold_at ?? new Date().toISOString() : null,
    input.seller_collaborator_id ?? null];
  const sellerReady = await hasMatrizSellerColumn(client, 'wholesale_orders');
  const sellerSql = sellerReady
    ? `,seller_collaborator_id,parent_order_id,partner_unit_id,
         dispatched_total_amount,partner_transfer_status)
       VALUES ($1::env_t,$2,COALESCE($3::timestamptz,now()),0,$4,$5,$6,$7::date,$8::timestamptz,
       (SELECT id FROM network.matriz_collaborators WHERE id=$9 AND environment=$1::env_t AND revoked_at IS NULL),
       $10::uuid,$11::uuid,CASE WHEN $11::uuid IS NULL THEN NULL ELSE 0 END,
       CASE WHEN $11::uuid IS NULL THEN NULL ELSE 'in_transit' END)`
    : `,parent_order_id,partner_unit_id,dispatched_total_amount,partner_transfer_status)
       VALUES ($1,$2,COALESCE($3::timestamptz,now()),0,$4,$5,$6,$7::date,$8::timestamptz,
       $9::uuid,$10::uuid,CASE WHEN $10::uuid IS NULL THEN NULL ELSE 0 END,
       CASE WHEN $10::uuid IS NULL THEN NULL ELSE 'in_transit' END)`;
  const result = await client.query<{ id: string }>(
    `INSERT INTO commerce.wholesale_orders
       (environment,buyer_id,sold_at,total_amount,created_by,notes,payment_status,due_date,paid_at${sellerSql}
     RETURNING id`, sellerReady
      ? [...values, input.parent_order_id ?? null, partnerUnitId]
      : [...values.slice(0, 8), input.parent_order_id ?? null, partnerUnitId],
  );
  return result.rows[0]!.id;
}

export async function registerWholesaleSale(
  input: RegisterWholesaleSaleInput,
  dbPool: Pool = defaultPool,
): Promise<RegisterWholesaleSaleResult> {
  const rawItems = input.items ?? [];
  assertWholesaleSaleMoney(rawItems);
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const fingerprint = operationFingerprint({
      customer_id: input.customer_id ?? null, partner_id: input.partner_id ?? null,
      new_customer: input.new_customer ? { name: input.new_customer.name.trim(),
        phone: input.new_customer.phone ? normalizeBrazilianPhone(input.new_customer.phone) : null } : null,
      sold_at: input.sold_at ?? null, paid_at: input.paid_at ?? null,
      notes: input.notes?.trim() || null,
      payment_status: input.payment_status ?? 'paid', due_date: input.due_date ?? null,
      seller_collaborator_id: input.seller_collaborator_id ?? null,
      parent_order_id: input.parent_order_id ?? null,
      partner_unit_id: input.partner_unit_id ?? null,
      items: rawItems.map((item) => ({ measure: item.measure.trim(), brand: item.brand ?? null,
        tire_condition: item.tire_condition,
        quantity: item.quantity, unit_price_cents: moneyCents(item.unit_price) })),
    });
    const operation = { environment, domain: 'wholesale_sale.create',
      idempotencyKey: input.idempotency_key, fingerprint };
    const started = await beginIntegrityOperation<RegisterWholesaleSaleResult>(client, operation);
    if (started.replayed) {
      await client.query('COMMIT');
      return started.result;
    }

    const items = await canonicalSaleItems(client, environment, rawItems);
    let buyer: { id: string; name: string; partner_id: string | null };
    let requestedPartnerUnitId = input.partner_unit_id ?? null;
    if (input.parent_order_id) {
      const parent = await resolveAdditionBuyer(client, environment, input.parent_order_id);
      buyer = { id: parent.id, name: parent.name, partner_id: parent.partner_id };
      if (parent.partner_unit_id && requestedPartnerUnitId
          && parent.partner_unit_id !== requestedPartnerUnitId) {
        throw new Error('wholesale_addition_partner_unit_mismatch');
      }
      requestedPartnerUnitId = parent.partner_unit_id ?? requestedPartnerUnitId;
    } else {
      buyer = await resolveWholesaleBuyer(client, environment, input);
    }
    const partnerUnit = await resolveWholesalePartnerUnit(
      client, environment, buyer.partner_id, requestedPartnerUnitId,
    );
    const orderId = await insertSaleHeader(
      client, environment, buyer.id, partnerUnit?.partner_unit_id ?? null, input,
    );
    const requested = new Map<string, {
      measure: string; brand: string; tire_condition: TireCondition; quantity: number;
    }>();
    for (const item of items) {
      const brand = item.brand!;
      const tireCondition = requireTireCondition(item.tire_condition);
      const key = `${item.measure}\u0000${brand}\u0000${tireCondition}`;
      const current = requested.get(key) ?? {
        measure: item.measure, brand, tire_condition: tireCondition, quantity: 0,
      };
      current.quantity += item.quantity;
      requested.set(key, current);
    }
    const costs = new Map<string, number>();
    const short: Array<{ measure: string; brand: string; tire_condition: TireCondition;
      available: number; requested: number }> = [];
    for (const [key, variant] of [...requested].sort(([a], [b]) => a.localeCompare(b))) {
      const stock = await client.query<{ quantity_on_hand: number; quantity_reserved: number; unit_cost: string }>(
        `SELECT quantity_on_hand,quantity_reserved,unit_cost FROM commerce.wholesale_stock
          WHERE environment=$1 AND measure=$2 AND brand=$3 AND tire_condition=$4
          FOR UPDATE`,
        [environment, variant.measure, variant.brand, variant.tire_condition]);
      const available = Number(stock.rows[0]?.quantity_on_hand ?? 0)
        - Number(stock.rows[0]?.quantity_reserved ?? 0);
      if (available < variant.quantity) short.push({
        measure: variant.measure, brand: variant.brand,
        tire_condition: variant.tire_condition,
        available, requested: variant.quantity,
      });
      costs.set(key, Number(stock.rows[0]?.unit_cost ?? 0));
    }
    if (short.length) throw new Error('oversell:' + JSON.stringify(short));

    for (const item of items) {
      await client.query(
        `INSERT INTO commerce.wholesale_order_items
           (environment,order_id,measure,brand,tire_condition,quantity,unit_price,unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [environment, orderId, item.measure, item.brand ?? null, item.tire_condition,
         item.quantity, item.unit_price,
         costs.get(`${item.measure}\u0000${item.brand}\u0000${item.tire_condition}`) ?? 0],
      );
    }
    await applyWholesaleStockDecrement(client, environment, items, true, orderId);
    const total = await client.query<{ total_amount: string }>(
      `UPDATE commerce.wholesale_orders SET total_amount=COALESCE(
         (SELECT sum(line_total) FROM commerce.wholesale_order_items WHERE order_id=$1),0),
         dispatched_total_amount=CASE WHEN partner_unit_id IS NULL THEN NULL ELSE COALESCE(
           (SELECT sum(line_total) FROM commerce.wholesale_order_items WHERE order_id=$1),0) END
       WHERE id=$1 RETURNING total_amount`, [orderId]);
    const linkedPurchase = partnerUnit
      ? await createLinkedPartnerPurchase(client, environment, orderId, input.created_by)
      : null;
    if (env.MATRIZ_CENTRAL_LEDGER) {
      const ledgerState = await getWholesaleSaleLedgerState(client, environment, orderId);
      await ensureWholesaleSaleRevenue(client, ledgerState);
      await ensureWholesaleSaleCogs(client, ledgerState);
    }
    const result = { order_id: orderId, buyer_id: buyer.id, buyer_name: buyer.name,
      total_amount: total.rows[0]!.total_amount, items_count: items.length,
      parent_order_id: input.parent_order_id ?? null,
      partner_unit_id: partnerUnit?.partner_unit_id ?? null,
      linked_partner_purchase_id: linkedPurchase?.purchase_id ?? null };
    await recordIntegrityEvent(client, { environment, domain: 'wholesale_sale',
      entityTable: 'commerce.wholesale_orders', entityId: orderId, eventType: 'created',
      actorLabel: input.created_by, idempotencyKey: operation.idempotencyKey,
      after: { ...result, payment_status: input.payment_status ?? 'paid' } });
    await completeIntegrityOperation(client, operation, 'commerce.wholesale_orders', orderId, result);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
