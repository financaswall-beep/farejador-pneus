/**
 * Queries do Portal Parceiro — V2 da Etapa 5 (pos-Codex).
 *
 * TODAS as queries usam withPartnerContext(ctx.partnerUnitId, ...) que:
 *   1. Pega connection do partnerPool (role 'farejador_partner_app')
 *   2. Abre transacao com BEGIN
 *   3. Seta GUC app.partner_unit_id via SET LOCAL
 *   4. Roda callback com client da transacao
 *   5. COMMIT (ou ROLLBACK em erro)
 *
 * Isso garante que as policies RLS estritas filtram corretamente:
 *   - commerce.partner_*  → policy compara unit_id com current_partner_core_unit()
 *   - finance.partner_expenses → idem
 *   - network.partner_units → policy compara id com current_partner_unit()
 *   - network.partners → policy resolve partner_id via subquery
 *
 * Mantemos WHERE unit_id = ctx.unitId nas queries (defesa em profundidade —
 * se RLS por algum motivo nao filtrar, o WHERE protege; se WHERE for esquecido,
 * RLS protege).
 *
 * O parametro dbPool opcional desapareceu — agora tudo passa por withPartnerContext.
 * Testes que precisarem usar pool customizado devem usar testWithPartnerContext
 * (futuro helper de teste).
 */

import type { PoolClient } from 'pg';
import { withPartnerContext } from './db.js';
import { normalizeBrazilianPhone } from '../shared/phone.js';
import type { PartnerContext } from './auth.js';

export interface PartnerOrderItemInput {
  partner_stock_id: string;
  quantity: number;
  unit_price: number;
  discount_amount?: number;
}

export interface RegisterPartnerSaleInput {
  customer_name?: string | null;
  customer_phone?: string | null;
  items: PartnerOrderItemInput[];
  payment_method: string | null;
  fulfillment_mode: 'delivery' | 'pickup';
  delivery_address?: string | null;
  source_tag?: 'porta' | '2w' | 'walkin_balcao' | 'walkin_telefone' | 'outro' | null;
  idempotency_key: string;
}

export interface UpsertPartnerStockInput {
  stock_id?: string | null;
  product_id?: string | null;
  local_sku?: string | null;
  item_name: string;
  tire_size?: string | null;
  tire_width_mm?: number | null;
  tire_aspect_ratio?: number | null;
  tire_rim_diameter?: number | null;
  brand?: string | null;
  supplier_name?: string | null;
  quantity_on_hand?: number | null;
  minimum_quantity?: number | null;
  average_cost?: number | null;
  sale_price?: number | null;
  is_tracked: boolean;
}

export interface RegisterPartnerPurchaseInput {
  supplier_name?: string | null;
  purchased_at?: string | null;
  payment_method?: string | null;
  notes?: string | null;
  idempotency_key?: string | null;
  items: Array<{
    product_id?: string | null;
    item_name: string;
    tire_size?: string | null;
    tire_width_mm?: number | null;
    tire_aspect_ratio?: number | null;
    tire_rim_diameter?: number | null;
    brand?: string | null;
    quantity: number;
    unit_cost: number;
    sale_price?: number | null;
  }>;
}

export interface RegisterPartnerExpenseInput {
  expense_date?: string | null;
  category: 'employee_payment' | 'rent' | 'utilities' | 'maintenance' | 'delivery' | 'tax' | 'other';
  description: string;
  amount: number;
  payment_method?: string | null;
  idempotency_key?: string | null;
}

export interface RegisterPartnerPayableInput {
  counterparty_name?: string | null;
  description: string;
  category?: 'supplier' | 'employee' | 'rent' | 'utilities' | 'tax' | 'maintenance' | 'other' | null;
  amount: number;
  due_date?: string | null;
  status?: 'open' | 'paid' | null;
  paid_at?: string | null;
  payment_method?: string | null;
  notes?: string | null;
  idempotency_key?: string | null;
}

export interface RegisterPartnerReceivableInput {
  customer_name?: string | null;
  description: string;
  source_tag?: 'porta' | '2w' | 'walkin_balcao' | 'walkin_telefone' | 'outro' | null;
  amount: number;
  due_date?: string | null;
  status?: 'open' | 'received' | null;
  received_at?: string | null;
  payment_method?: string | null;
  notes?: string | null;
  idempotency_key?: string | null;
}

// ----------------------------------------------------------------------------
// Leituras
// ----------------------------------------------------------------------------

export async function getPartnerResumo(ctx: PartnerContext): Promise<unknown> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT *
       FROM network.partner_unit_summary
       WHERE environment = $1 AND unit_id = $2`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows[0] ?? null;
  });
}

export async function getPartnerVendas(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT order_id, created_at,
              contact_name AS customer_name,
              contact_phone AS customer_phone,
              contact_name, contact_phone,
              source_tag AS source,
              source_tag,
              status, payment_method, fulfillment_mode, total_amount, items
       FROM commerce.partner_orders_full
       WHERE environment = $1 AND unit_id = $2
       ORDER BY created_at DESC
       LIMIT 100`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export async function getPartnerEstoque(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT id, product_id, local_sku, item_name, tire_size,
              tire_width_mm, tire_aspect_ratio, tire_rim_diameter,
              brand, supplier_name,
              quantity_on_hand, minimum_quantity, average_cost, sale_price,
              is_tracked, stock_status, updated_at
       FROM commerce.partner_stock_levels
       WHERE environment = $1 AND unit_id = $2 AND deleted_at IS NULL
       ORDER BY stock_status DESC, item_name ASC
       LIMIT 300`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export async function getPartnerProdutos(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT id AS stock_id,
              item_name, tire_size,
              tire_width_mm, tire_aspect_ratio, tire_rim_diameter,
              brand, sale_price, average_cost, quantity_on_hand,
              is_tracked, stock_status, local_sku
       FROM commerce.partner_stock_levels
       WHERE environment = $1 AND unit_id = $2 AND deleted_at IS NULL
       ORDER BY
         CASE stock_status
           WHEN 'in_stock' THEN 1
           WHEN 'low_stock' THEN 2
           WHEN 'unknown' THEN 3
           WHEN 'not_tracked' THEN 4
           WHEN 'out_of_stock' THEN 5
           ELSE 6
         END,
         item_name ASC
       LIMIT 300`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export async function getPartnerDespesas(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT id, expense_date, category, description, amount, payment_method, created_at
       FROM finance.partner_expenses
       WHERE environment = $1 AND unit_id = $2 AND deleted_at IS NULL
       ORDER BY expense_date DESC, created_at DESC
       LIMIT 100`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export async function getPartnerCompras(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT pp.id, pp.supplier_name, pp.purchased_at, pp.total_amount,
              pp.payment_method, pp.notes, pp.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'item_name', ppi.item_name,
                'quantity', ppi.quantity,
                'unit_cost', ppi.unit_cost,
                'subtotal', (ppi.quantity * ppi.unit_cost)
              ) ORDER BY ppi.created_at) FILTER (WHERE ppi.id IS NOT NULL), '[]'::jsonb) AS items
       FROM commerce.partner_purchases pp
       LEFT JOIN commerce.partner_purchase_items ppi
         ON ppi.purchase_id = pp.id AND ppi.environment = pp.environment
       WHERE pp.environment = $1 AND pp.unit_id = $2 AND pp.deleted_at IS NULL
       GROUP BY pp.id
       ORDER BY pp.purchased_at DESC, pp.created_at DESC
       LIMIT 100`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export async function getPartnerPayables(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT id, counterparty_name, description, category, amount, due_date,
              status, paid_at, payment_method, notes, created_at
       FROM finance.partner_payables
       WHERE environment = $1 AND unit_id = $2 AND deleted_at IS NULL
       ORDER BY
         CASE status WHEN 'open' THEN 1 WHEN 'paid' THEN 2 ELSE 3 END,
         due_date ASC NULLS LAST,
         created_at DESC
       LIMIT 100`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export async function getPartnerReceivables(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT id, customer_name, description, source_tag, amount, due_date,
              status, received_at, payment_method, notes, created_at
       FROM finance.partner_receivables
       WHERE environment = $1 AND unit_id = $2 AND deleted_at IS NULL
       ORDER BY
         CASE status WHEN 'open' THEN 1 WHEN 'received' THEN 2 ELSE 3 END,
         due_date ASC NULLS LAST,
         created_at DESC
       LIMIT 100`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

// ----------------------------------------------------------------------------
// Vendas — via function SQL atomica
// ----------------------------------------------------------------------------

export async function registerPartnerSale(
  ctx: PartnerContext,
  input: RegisterPartnerSaleInput,
): Promise<{ order_id: string }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    try {
      const normalizedPhone = normalizeBrazilianPhone(input.customer_phone);
      const result = await client.query<{ order_id: string }>(
        `SELECT commerce.register_partner_local_order(
           $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11
         ) AS order_id`,
        [
          ctx.environment,
          ctx.unitId,
          input.customer_name ?? null,
          normalizedPhone,
          JSON.stringify(input.items),
          input.payment_method,
          input.fulfillment_mode,
          input.delivery_address ?? null,
          `partner:${ctx.slug}`,
          input.idempotency_key,
          input.source_tag ?? 'porta',
        ],
      );
      return { order_id: result.rows[0]!.order_id };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Estoque insuficiente')) {
        throw new Error(err.message);
      }
      throw err;
    }
  });
}

export async function cancelPartnerSale(
  ctx: PartnerContext,
  orderId: string,
): Promise<{ order_id: string; cancelled: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const exists = await client.query<{ id: string }>(
      `SELECT id
       FROM commerce.partner_orders
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND status <> 'cancelled'
         AND deleted_at IS NULL
       LIMIT 1`,
      [orderId, ctx.environment, ctx.unitId],
    );

    if (exists.rowCount !== 1) return { order_id: orderId, cancelled: false };

    await client.query('SELECT commerce.cancel_partner_local_order($1, $2, $3)', [
      orderId,
      `partner:${ctx.slug}`,
      'cancelado pelo portal parceiro',
    ]);

    return { order_id: orderId, cancelled: true };
  });
}

// ----------------------------------------------------------------------------
// Estoque
// ----------------------------------------------------------------------------

function stockStatus(input: UpsertPartnerStockInput): string {
  if (!input.is_tracked) return 'not_tracked';
  if (input.quantity_on_hand === null || input.quantity_on_hand === undefined) return 'unknown';
  if (input.quantity_on_hand <= 0) return 'out_of_stock';
  if (input.minimum_quantity !== null && input.minimum_quantity !== undefined && input.quantity_on_hand <= input.minimum_quantity) {
    return 'low_stock';
  }
  return 'in_stock';
}

function normalizeText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function payableCategoryToExpenseCategory(
  category: RegisterPartnerPayableInput['category'],
): RegisterPartnerExpenseInput['category'] {
  const map: Record<string, RegisterPartnerExpenseInput['category']> = {
    supplier: 'maintenance',
    employee: 'employee_payment',
    rent: 'rent',
    utilities: 'utilities',
    tax: 'tax',
    maintenance: 'maintenance',
    other: 'other',
  };
  return map[category ?? 'other'] ?? 'other';
}

export async function upsertPartnerStock(
  ctx: PartnerContext,
  input: UpsertPartnerStockInput,
): Promise<{ stock_id: string }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const isCreate = !input.stock_id;
    const result = await client.query<{ id: string }>(
      `INSERT INTO commerce.partner_stock_levels (
         id, environment, unit_id, product_id, local_sku, item_name, tire_size,
         tire_width_mm, tire_aspect_ratio, tire_rim_diameter,
         brand, supplier_name, quantity_on_hand, minimum_quantity, average_cost,
         sale_price, is_tracked, stock_status, updated_by
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7,
         $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19
       )
       ON CONFLICT (id) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         local_sku = EXCLUDED.local_sku,
         item_name = EXCLUDED.item_name,
         tire_size = EXCLUDED.tire_size,
         tire_width_mm = EXCLUDED.tire_width_mm,
         tire_aspect_ratio = EXCLUDED.tire_aspect_ratio,
         tire_rim_diameter = EXCLUDED.tire_rim_diameter,
         brand = EXCLUDED.brand,
         supplier_name = EXCLUDED.supplier_name,
         quantity_on_hand = EXCLUDED.quantity_on_hand,
         minimum_quantity = EXCLUDED.minimum_quantity,
         average_cost = EXCLUDED.average_cost,
         sale_price = EXCLUDED.sale_price,
         is_tracked = EXCLUDED.is_tracked,
         stock_status = EXCLUDED.stock_status,
         updated_by = EXCLUDED.updated_by
       WHERE commerce.partner_stock_levels.environment = $2
         AND commerce.partner_stock_levels.unit_id = $3
       RETURNING id`,
      [
        input.stock_id ?? null,
        ctx.environment,
        ctx.unitId,
        input.product_id ?? null,
        input.local_sku ?? null,
        input.item_name,
        input.tire_size ?? null,
        input.tire_width_mm ?? null,
        input.tire_aspect_ratio ?? null,
        input.tire_rim_diameter ?? null,
        input.brand ?? null,
        input.supplier_name ?? null,
        input.is_tracked ? input.quantity_on_hand ?? null : null,
        input.minimum_quantity ?? null,
        input.average_cost ?? null,
        input.sale_price ?? null,
        input.is_tracked,
        stockStatus(input),
        `partner:${ctx.slug}`,
      ],
    );

    const stockId = result.rows[0]!.id;

    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type,
         actor_label, payload_after
       ) VALUES ($1, 'stock', 'commerce.partner_stock_levels', $2, $3, $4, $5::jsonb)`,
      [
        ctx.environment,
        stockId,
        isCreate ? 'stock_item_created' : 'stock_item_updated',
        `partner:${ctx.slug}`,
        JSON.stringify({
          unit_id: ctx.unitId,
          item_name: input.item_name,
          tire_size: input.tire_size,
          brand: input.brand,
          supplier_name: input.supplier_name,
          quantity_on_hand: input.quantity_on_hand,
          minimum_quantity: input.minimum_quantity,
          average_cost: input.average_cost,
          sale_price: input.sale_price,
          is_tracked: input.is_tracked,
        }),
      ],
    );

    return { stock_id: stockId };
  });
}

export async function deletePartnerStock(
  ctx: PartnerContext,
  stockId: string,
): Promise<{ stock_id: string; deleted: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<{ id: string; item_name: string; quantity_on_hand: number | null }>(
      `UPDATE commerce.partner_stock_levels
       SET deleted_at = now(),
           updated_by = $4
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND deleted_at IS NULL
       RETURNING id, item_name, quantity_on_hand`,
      [stockId, ctx.environment, ctx.unitId, `partner:${ctx.slug}`],
    );

    if (result.rowCount === 1) {
      await client.query(
        `INSERT INTO audit.events (
           environment, domain, entity_table, entity_id, event_type,
           actor_label, payload_after
         ) VALUES ($1, 'stock', 'commerce.partner_stock_levels', $2, 'stock_item_inactivated', $3, $4::jsonb)`,
        [
          ctx.environment,
          stockId,
          `partner:${ctx.slug}`,
          JSON.stringify({
            unit_id: ctx.unitId,
            item_name: result.rows[0]!.item_name,
            last_quantity: result.rows[0]!.quantity_on_hand,
          }),
        ],
      );
    }

    return { stock_id: stockId, deleted: result.rowCount === 1 };
  });
}

// ----------------------------------------------------------------------------
// Compras
// ----------------------------------------------------------------------------

export async function registerPartnerPurchase(
  ctx: PartnerContext,
  input: RegisterPartnerPurchaseInput,
): Promise<{ purchase_id: string }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const total = input.items.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0);
    const purchase = await client.query<{ id: string }>(
      `INSERT INTO commerce.partner_purchases (
         environment, unit_id, supplier_name, purchased_at, total_amount,
         payment_method, notes, created_by, idempotency_key
       ) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6, $7, $8, $9)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id`,
      [
        ctx.environment,
        ctx.unitId,
        input.supplier_name ?? null,
        input.purchased_at ?? null,
        total,
        input.payment_method ?? null,
        input.notes ?? null,
        `partner:${ctx.slug}`,
        input.idempotency_key ?? null,
      ],
    );

    const purchaseId = purchase.rows[0]!.id;
    const moves: Array<{ stock_id: string; new_qty: number; new_status: string }> = [];

    const existingItems = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM commerce.partner_purchase_items WHERE purchase_id = $1`,
      [purchaseId],
    );
    const alreadyProcessed = Number(existingItems.rows[0]?.cnt ?? 0) > 0;
    if (alreadyProcessed) {
      return { purchase_id: purchaseId };
    }

    for (const item of input.items) {
      await client.query(
        `INSERT INTO commerce.partner_purchase_items (
           environment, purchase_id, product_id, item_name, quantity, unit_cost
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [ctx.environment, purchaseId, item.product_id ?? null, item.item_name, item.quantity, item.unit_cost],
      );

      const supplierName = normalizeText(input.supplier_name);
      const itemName = item.item_name.trim();
      const tireSize = normalizeText(item.tire_size);
      const brand = normalizeText(item.brand);
      const quantity = Number(item.quantity);
      const unitCost = Number(item.unit_cost);

      const existingStock = await client.query<{ stock_id: string; quantity_on_hand: number | null; average_cost: string | null }>(
        `SELECT id AS stock_id, quantity_on_hand, average_cost
         FROM commerce.partner_stock_levels
         WHERE environment = $1
           AND unit_id = $2
           AND lower(trim(item_name)) = lower(trim($3))
           AND lower(trim(COALESCE(tire_size,''))) = lower(trim(COALESCE($4::text,'')))
           AND lower(trim(COALESCE(brand,''))) = lower(trim(COALESCE($5::text,'')))
           AND lower(trim(COALESCE(supplier_name,''))) = lower(trim(COALESCE($6::text,'')))
           AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 1
         FOR UPDATE`,
        [ctx.environment, ctx.unitId, itemName, tireSize, brand, supplierName],
      );

      if (existingStock.rowCount && existingStock.rowCount > 0) {
        const prevQty = Number(existingStock.rows[0]!.quantity_on_hand ?? 0);
        const prevAvg = Number(existingStock.rows[0]!.average_cost ?? 0);
        const newTotalQty = prevQty + quantity;
        const weightedAvgCost = newTotalQty > 0
          ? ((prevAvg * prevQty) + (unitCost * quantity)) / newTotalQty
          : unitCost;

        const updated = await client.query<{ stock_id: string; new_qty: number; new_status: string }>(
          `UPDATE commerce.partner_stock_levels
           SET quantity_on_hand = COALESCE(quantity_on_hand, 0) + $4,
               average_cost = $5,
               sale_price = COALESCE($6, sale_price),
               is_tracked = true,
               stock_status = CASE
                 WHEN COALESCE(quantity_on_hand, 0) + $4 <= 0 THEN 'out_of_stock'
                 WHEN minimum_quantity IS NOT NULL
                      AND COALESCE(quantity_on_hand, 0) + $4 <= minimum_quantity THEN 'low_stock'
                 ELSE 'in_stock'
               END,
               updated_by = $7,
               updated_at = now()
           WHERE id = $1
             AND environment = $2
             AND unit_id = $3
           RETURNING id AS stock_id, quantity_on_hand AS new_qty, stock_status AS new_status`,
          [
            existingStock.rows[0]!.stock_id,
            ctx.environment,
            ctx.unitId,
            quantity,
            weightedAvgCost,
            item.sale_price ?? null,
            `partner:${ctx.slug}`,
          ],
        );
        if (updated.rowCount && updated.rowCount > 0) moves.push(updated.rows[0]!);
      } else {
        const inserted = await client.query<{ stock_id: string; new_qty: number; new_status: string }>(
          `INSERT INTO commerce.partner_stock_levels (
             environment, unit_id, product_id, item_name, tire_size,
             tire_width_mm, tire_aspect_ratio, tire_rim_diameter,
             brand, supplier_name, quantity_on_hand, minimum_quantity,
             average_cost, sale_price, is_tracked, stock_status, updated_by
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8,
             $9, $10, $11, NULL,
             $12, $13, true,
             CASE WHEN $11 <= 0 THEN 'out_of_stock' ELSE 'in_stock' END,
             $14
           )
           RETURNING id AS stock_id, quantity_on_hand AS new_qty, stock_status AS new_status`,
          [
            ctx.environment,
            ctx.unitId,
            item.product_id ?? null,
            itemName,
            tireSize,
            item.tire_width_mm ?? null,
            item.tire_aspect_ratio ?? null,
            item.tire_rim_diameter ?? null,
            brand,
            supplierName,
            quantity,
            unitCost,
            item.sale_price ?? null,
            `partner:${ctx.slug}`,
          ],
        );
        if (inserted.rowCount && inserted.rowCount > 0) moves.push(inserted.rows[0]!);
      }
    }

    if (moves.length > 0) {
      await client.query(
        `INSERT INTO audit.events (
           environment, domain, entity_table, entity_id, event_type,
           actor_label, payload_after
         ) VALUES ($1, 'stock', 'commerce.partner_stock_levels', $2,
                   'stock_increment_purchase', $3, $4::jsonb)`,
        [
          ctx.environment,
          purchaseId,
          `partner:${ctx.slug}`,
          JSON.stringify({ purchase_id: purchaseId, moves, items: input.items }),
        ],
      );
    }

    return { purchase_id: purchaseId };
  });
}

export async function deletePartnerPurchase(
  ctx: PartnerContext,
  purchaseId: string,
): Promise<{ purchase_id: string; deleted: boolean; stock_moves: Array<{ stock_id: string; new_qty: number; new_status: string }> }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const purchaseRow = await client.query<{ id: string; supplier_name: string | null }>(
      `SELECT id, supplier_name
       FROM commerce.partner_purchases
       WHERE id = $1 AND environment = $2 AND unit_id = $3 AND deleted_at IS NULL
       FOR UPDATE`,
      [purchaseId, ctx.environment, ctx.unitId],
    );

    if (purchaseRow.rowCount !== 1) {
      return { purchase_id: purchaseId, deleted: false, stock_moves: [] };
    }

    const supplierName = normalizeText(purchaseRow.rows[0]!.supplier_name);
    const items = await client.query<{ product_id: string | null; item_name: string; quantity: number }>(
      `SELECT product_id, item_name, quantity
       FROM commerce.partner_purchase_items
       WHERE purchase_id = $1 AND environment = $2`,
      [purchaseId, ctx.environment],
    );

    const moves: Array<{ stock_id: string; new_qty: number; new_status: string }> = [];
    for (const item of items.rows) {
      const moved = await client.query<{ stock_id: string; new_qty: number; new_status: string }>(
        `WITH target AS (
           SELECT id
           FROM commerce.partner_stock_levels
           WHERE environment = $1
             AND unit_id = $2
             AND lower(item_name) = lower($3)
             AND supplier_name IS NOT DISTINCT FROM $4
             AND deleted_at IS NULL
             AND is_tracked
             AND quantity_on_hand >= $5
           ORDER BY updated_at DESC
           LIMIT 1
           FOR UPDATE
         )
         UPDATE commerce.partner_stock_levels ps
         SET quantity_on_hand = ps.quantity_on_hand - $5,
             stock_status = CASE
               WHEN ps.quantity_on_hand - $5 <= 0 THEN 'out_of_stock'
               WHEN ps.minimum_quantity IS NOT NULL
                    AND ps.quantity_on_hand - $5 <= ps.minimum_quantity THEN 'low_stock'
               ELSE 'in_stock'
             END,
             updated_by = $6,
             updated_at = now()
         FROM target
         WHERE ps.id = target.id
         RETURNING ps.id AS stock_id, ps.quantity_on_hand AS new_qty, ps.stock_status AS new_status`,
        [ctx.environment, ctx.unitId, item.item_name, supplierName, Number(item.quantity), `partner:${ctx.slug}`],
      );
      if (moved.rowCount && moved.rowCount > 0) {
        moves.push(moved.rows[0]!);
      }
    }

    await client.query(
      `UPDATE commerce.partner_purchases
       SET deleted_at = now(),
           deleted_by = $4
       WHERE id = $1 AND environment = $2 AND unit_id = $3`,
      [purchaseId, ctx.environment, ctx.unitId, `partner:${ctx.slug}`],
    );

    if (moves.length > 0) {
      await client.query(
        `INSERT INTO audit.events (
           environment, domain, entity_table, entity_id, event_type,
           actor_label, payload_after
         ) VALUES ($1, 'stock', 'commerce.partner_stock_levels', $2,
                   'stock_decrement_purchase_cancel', $3, $4::jsonb)`,
        [
          ctx.environment,
          purchaseId,
          `partner:${ctx.slug}`,
          JSON.stringify({ purchase_id: purchaseId, moves, items: items.rows }),
        ],
      );
    }

    return { purchase_id: purchaseId, deleted: true, stock_moves: moves };
  });
}

// ----------------------------------------------------------------------------
// Despesas
// ----------------------------------------------------------------------------

export async function registerPartnerExpense(
  ctx: PartnerContext,
  input: RegisterPartnerExpenseInput,
): Promise<{ expense_id: string }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO finance.partner_expenses (
         environment, unit_id, expense_date, category, description, amount,
         payment_method, created_by, idempotency_key
       ) VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6, $7, $8, $9)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id`,
      [
        ctx.environment,
        ctx.unitId,
        input.expense_date ?? null,
        input.category,
        input.description,
        input.amount,
        input.payment_method ?? null,
        `partner:${ctx.slug}`,
        input.idempotency_key ?? null,
      ],
    );

    const expenseId = result.rows[0]!.id;

    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type,
         actor_label, idempotency_key, payload_after
       ) VALUES ($1, 'partner_expenses', 'finance.partner_expenses', $2,
                 'partner_expense_created', $3, $4, $5::jsonb)`,
      [
        ctx.environment,
        expenseId,
        `partner:${ctx.slug}`,
        input.idempotency_key ?? null,
        JSON.stringify({
          unit_id: ctx.unitId,
          category: input.category,
          description: input.description,
          amount: input.amount,
          expense_date: input.expense_date,
        }),
      ],
    );

    return { expense_id: expenseId };
  });
}

export async function deletePartnerExpense(
  ctx: PartnerContext,
  expenseId: string,
): Promise<{ expense_id: string; deleted: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<{ id: string; description: string; amount: string }>(
      `UPDATE finance.partner_expenses
       SET deleted_at = now(),
           deleted_by = $4
       WHERE id = $1 AND environment = $2 AND unit_id = $3 AND deleted_at IS NULL
       RETURNING id, description, amount`,
      [expenseId, ctx.environment, ctx.unitId, `partner:${ctx.slug}`],
    );

    if (result.rowCount === 1) {
      await client.query(
        `INSERT INTO audit.events (
           environment, domain, entity_table, entity_id, event_type,
           actor_label, payload_after
         ) VALUES ($1, 'partner_expenses', 'finance.partner_expenses', $2,
                   'partner_expense_deleted', $3, $4::jsonb)`,
        [
          ctx.environment,
          expenseId,
          `partner:${ctx.slug}`,
          JSON.stringify({
            unit_id: ctx.unitId,
            description: result.rows[0]!.description,
            amount: result.rows[0]!.amount,
          }),
        ],
      );
    }

    return { expense_id: expenseId, deleted: result.rowCount === 1 };
  });
}

// ----------------------------------------------------------------------------
// Contas a pagar / receber
// ----------------------------------------------------------------------------

export async function registerPartnerPayable(
  ctx: PartnerContext,
  input: RegisterPartnerPayableInput,
): Promise<{ payable_id: string }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const status = input.status ?? 'open';
    const result = await client.query<{ id: string }>(
      `INSERT INTO finance.partner_payables (
         environment, unit_id, counterparty_name, description, category, amount,
         due_date, status, paid_at, payment_method, notes, created_by, idempotency_key
       ) VALUES ($1, $2, $3, $4, COALESCE($5, 'other'), $6,
                 $7::date, $8, $9::timestamptz, $10, $11, $12, $13)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id`,
      [
        ctx.environment,
        ctx.unitId,
        normalizeText(input.counterparty_name),
        input.description,
        input.category ?? 'other',
        input.amount,
        input.due_date ?? null,
        status,
        status === 'paid' ? input.paid_at ?? null : null,
        input.payment_method ?? null,
        normalizeText(input.notes),
        `partner:${ctx.slug}`,
        input.idempotency_key ?? null,
      ],
    );

    const payableId = result.rows[0]!.id;

    if (status === 'paid') {
      await client.query(
        `INSERT INTO finance.partner_expenses (
           environment, unit_id, expense_date, category, description, amount,
           payment_method, created_by, idempotency_key
         ) VALUES (
           $1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6, $7, $8, $9
         )
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
         DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key`,
        [
          ctx.environment,
          ctx.unitId,
          input.paid_at ? input.paid_at.slice(0, 10) : null,
          payableCategoryToExpenseCategory(input.category),
          input.description,
          input.amount,
          input.payment_method ?? null,
          `partner:${ctx.slug}`,
          input.idempotency_key ? `${input.idempotency_key}:expense` : null,
        ],
      );
    }

    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type,
         actor_label, idempotency_key, payload_after
       ) VALUES ($1, 'partner_finance', 'finance.partner_payables', $2,
                 'partner_payable_created', $3, $4, $5::jsonb)`,
      [
        ctx.environment,
        payableId,
        `partner:${ctx.slug}`,
        input.idempotency_key ?? null,
        JSON.stringify({
          unit_id: ctx.unitId,
          counterparty_name: input.counterparty_name,
          description: input.description,
          category: input.category ?? 'other',
          amount: input.amount,
          due_date: input.due_date,
          status,
          paid_at: status === 'paid' ? input.paid_at : null,
        }),
      ],
    );

    return { payable_id: payableId };
  });
}

export async function registerPartnerReceivable(
  ctx: PartnerContext,
  input: RegisterPartnerReceivableInput,
): Promise<{ receivable_id: string }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const status = input.status ?? 'open';
    const result = await client.query<{ id: string }>(
      `INSERT INTO finance.partner_receivables (
         environment, unit_id, customer_name, description, source_tag, amount,
         due_date, status, received_at, payment_method, notes, created_by, idempotency_key
       ) VALUES ($1, $2, $3, $4, COALESCE($5, 'porta'), $6,
                 $7::date, $8, $9::timestamptz, $10, $11, $12, $13)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id`,
      [
        ctx.environment,
        ctx.unitId,
        normalizeText(input.customer_name),
        input.description,
        input.source_tag ?? 'porta',
        input.amount,
        status === 'open' ? input.due_date ?? null : null,
        status,
        status === 'received' ? input.received_at ?? null : null,
        input.payment_method ?? null,
        normalizeText(input.notes),
        `partner:${ctx.slug}`,
        input.idempotency_key ?? null,
      ],
    );

    const receivableId = result.rows[0]!.id;
    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type,
         actor_label, idempotency_key, payload_after
       ) VALUES ($1, 'partner_finance', 'finance.partner_receivables', $2,
                 'partner_receivable_created', $3, $4, $5::jsonb)`,
      [
        ctx.environment,
        receivableId,
        `partner:${ctx.slug}`,
        input.idempotency_key ?? null,
        JSON.stringify({
          unit_id: ctx.unitId,
          customer_name: input.customer_name,
          description: input.description,
          source_tag: input.source_tag ?? 'porta',
          amount: input.amount,
          due_date: input.due_date,
          status,
          received_at: status === 'received' ? input.received_at : null,
        }),
      ],
    );

    return { receivable_id: receivableId };
  });
}
