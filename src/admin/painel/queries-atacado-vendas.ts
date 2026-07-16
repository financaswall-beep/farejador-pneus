import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { hasMatrizSellerColumn } from './payroll-schema.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyWholesaleStockDecrement } from './wholesale-stock.js';
import {
  beginIntegrityOperation, completeIntegrityOperation, moneyCents,
  operationFingerprint, recordIntegrityEvent,
} from './stage5-integrity.js';

export interface WholesaleBuyerRow {
  customer_id: string | null;
  partner_id: string | null;
  name: string;
  phone: string | null;
  is_partner: boolean;
}

export async function listWholesaleBuyers(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleBuyerRow[]> {
  const result = await dbPool.query<WholesaleBuyerRow>(
    `SELECT id AS customer_id, partner_id, name, phone, (partner_id IS NOT NULL) AS is_partner
       FROM commerce.wholesale_customers
      WHERE environment=$1 AND deleted_at IS NULL
     UNION ALL
     SELECT NULL::uuid, p.id, p.trade_name, p.whatsapp_phone, true
       FROM network.partners p
      WHERE p.environment=$1 AND p.deleted_at IS NULL AND p.status='active'
        AND NOT EXISTS (SELECT 1 FROM commerce.wholesale_customers c
          WHERE c.environment=p.environment AND c.partner_id=p.id AND c.deleted_at IS NULL)
     ORDER BY name`,
    [environment],
  );
  return result.rows;
}

export async function getWholesaleRanking(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT buyer_id,partner_id,name,phone,is_partner,orders_count,total_bought,last_purchase_at,days_since_last
       FROM commerce.wholesale_buyer_summary WHERE environment=$1
     UNION ALL
     SELECT NULL::uuid,p.id,p.trade_name,p.whatsapp_phone,true,0,0::numeric,NULL::timestamptz,NULL::int
       FROM network.partners p
      WHERE p.environment=$1 AND p.deleted_at IS NULL AND p.status='active'
        AND NOT EXISTS (SELECT 1 FROM commerce.wholesale_customers c
          WHERE c.environment=p.environment AND c.partner_id=p.id AND c.deleted_at IS NULL)
     ORDER BY total_bought DESC,last_purchase_at DESC NULLS LAST,name`,
    [environment],
  );
  return result.rows;
}

interface SaleItemInput {
  measure: string;
  brand?: string | null;
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
  notes?: string | null;
  created_by: string;
  seller_collaborator_id?: string | null;
  payment_status?: 'paid' | 'pending';
  due_date?: string | null;
  idempotency_key: string;
}

export interface RegisterWholesaleSaleResult {
  order_id: string;
  buyer_id: string;
  buyer_name: string;
  total_amount: string;
  items_count: number;
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
  return items.map((item) => ({ ...item, measure: measures.get(item.measure.trim())! }));
}

async function resolveBuyer(
  client: PoolClient,
  environment: 'prod' | 'test',
  input: RegisterWholesaleSaleInput,
): Promise<{ id: string; name: string }> {
  if (input.customer_id) {
    const found = await client.query<{ id: string; name: string }>(
      `SELECT id,name FROM commerce.wholesale_customers
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL`,
      [input.customer_id, environment],
    );
    if (!found.rows[0]) throw new Error('buyer_not_found');
    return found.rows[0];
  }
  if (input.partner_id) {
    const partner = await client.query<{ trade_name: string; whatsapp_phone: string | null }>(
      `SELECT trade_name,whatsapp_phone FROM network.partners
        WHERE id=$1 AND environment=$2 AND deleted_at IS NULL AND status='active' FOR SHARE`,
      [input.partner_id, environment],
    );
    if (!partner.rows[0]) throw new Error('partner_not_found');
    const buyer = await client.query<{ id: string; name: string }>(
      `INSERT INTO commerce.wholesale_customers (environment,partner_id,name,phone)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (environment,partner_id) WHERE partner_id IS NOT NULL AND deleted_at IS NULL
       DO UPDATE SET updated_at=commerce.wholesale_customers.updated_at
       RETURNING id,name`,
      [environment, input.partner_id, partner.rows[0].trade_name, partner.rows[0].whatsapp_phone],
    );
    return buyer.rows[0]!;
  }
  const name = input.new_customer?.name.trim();
  if (!name) throw new Error('buyer_required');
  const buyer = await client.query<{ id: string; name: string }>(
    `INSERT INTO commerce.wholesale_customers (environment,name,phone)
     VALUES ($1,$2,$3) RETURNING id,name`,
    [environment, name, input.new_customer?.phone
      ? normalizeBrazilianPhone(input.new_customer.phone) : null],
  );
  return buyer.rows[0]!;
}

async function insertSaleHeader(
  client: PoolClient,
  environment: 'prod' | 'test',
  buyerId: string,
  input: RegisterWholesaleSaleInput,
): Promise<string> {
  const pending = env.WHOLESALE_FINANCE && input.payment_status === 'pending';
  const values = [environment, buyerId, input.sold_at ?? null, input.created_by,
    input.notes ?? null, pending ? 'pending' : 'paid', pending ? (input.due_date ?? null) : null,
    env.WHOLESALE_FINANCE && !pending ? new Date().toISOString() : null,
    input.seller_collaborator_id ?? null];
  const sellerReady = await hasMatrizSellerColumn(client, 'wholesale_orders');
  const sellerSql = sellerReady
    ? `,seller_collaborator_id) VALUES ($1::env_t,$2,COALESCE($3::timestamptz,now()),0,$4,$5,$6,$7::date,$8::timestamptz,
       (SELECT id FROM network.matriz_collaborators WHERE id=$9 AND environment=$1::env_t AND revoked_at IS NULL))`
    : `) VALUES ($1,$2,COALESCE($3::timestamptz,now()),0,$4,$5,$6,$7::date,$8::timestamptz)`;
  const result = await client.query<{ id: string }>(
    `INSERT INTO commerce.wholesale_orders
       (environment,buyer_id,sold_at,total_amount,created_by,notes,payment_status,due_date,paid_at${sellerSql}
     RETURNING id`, sellerReady ? values : values.slice(0, 8),
  );
  return result.rows[0]!.id;
}

export async function registerWholesaleSale(
  input: RegisterWholesaleSaleInput,
  dbPool: Pool = defaultPool,
): Promise<RegisterWholesaleSaleResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const rawItems = input.items ?? [];
    const fingerprint = operationFingerprint({
      customer_id: input.customer_id ?? null, partner_id: input.partner_id ?? null,
      new_customer: input.new_customer ? { name: input.new_customer.name.trim(),
        phone: input.new_customer.phone ? normalizeBrazilianPhone(input.new_customer.phone) : null } : null,
      sold_at: input.sold_at ?? null, notes: input.notes?.trim() || null,
      payment_status: input.payment_status ?? 'paid', due_date: input.due_date ?? null,
      seller_collaborator_id: input.seller_collaborator_id ?? null,
      items: rawItems.map((item) => ({ measure: item.measure.trim(), brand: item.brand ?? null,
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
    const buyer = await resolveBuyer(client, environment, input);
    const orderId = await insertSaleHeader(client, environment, buyer.id, input);
    const requested = new Map<string, number>();
    for (const item of items) requested.set(item.measure, (requested.get(item.measure) ?? 0) + item.quantity);
    const costs = new Map<string, number>();
    const short: Array<{ measure: string; available: number; requested: number }> = [];
    for (const [measure, quantity] of [...requested].sort(([a], [b]) => a.localeCompare(b))) {
      const stock = await client.query<{ quantity_on_hand: number; unit_cost: string }>(
        `SELECT quantity_on_hand,unit_cost FROM commerce.wholesale_stock
          WHERE environment=$1 AND measure=$2 FOR UPDATE`, [environment, measure]);
      const available = Number(stock.rows[0]?.quantity_on_hand ?? 0);
      if (available < quantity) short.push({ measure, available, requested: quantity });
      costs.set(measure, Number(stock.rows[0]?.unit_cost ?? 0));
    }
    if (short.length) throw new Error('oversell:' + JSON.stringify(short));

    for (const item of items) {
      await client.query(
        `INSERT INTO commerce.wholesale_order_items
           (environment,order_id,measure,brand,quantity,unit_price,unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [environment, orderId, item.measure, item.brand ?? null, item.quantity,
         item.unit_price, costs.get(item.measure) ?? 0],
      );
    }
    await applyWholesaleStockDecrement(client, environment, items, true, orderId);
    const total = await client.query<{ total_amount: string }>(
      `UPDATE commerce.wholesale_orders SET total_amount=COALESCE(
         (SELECT sum(line_total) FROM commerce.wholesale_order_items WHERE order_id=$1),0)
       WHERE id=$1 RETURNING total_amount`, [orderId]);
    const result = { order_id: orderId, buyer_id: buyer.id, buyer_name: buyer.name,
      total_amount: total.rows[0]!.total_amount, items_count: items.length };
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
