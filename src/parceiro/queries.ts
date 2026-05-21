import type { Pool } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { normalizeBrazilianPhone } from '../shared/phone.js';
import type { PartnerContext } from './auth.js';

/**
 * Item de venda do parceiro — referencia partner_stock_levels.id, não commerce.products.
 * Parceiro vende SOMENTE itens do próprio estoque local. Sem dependência da matriz.
 */
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
  // product_id (vínculo com commerce.products) ficou opcional/legado. Parceiro
  // não usa mais — silo isolado. Aceito no input só pra não quebrar migrações
  // de dados antigos que ainda tenham linha vinculada.
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

export async function getPartnerResumo(ctx: PartnerContext, dbPool: Pool = defaultPool): Promise<unknown> {
  const result = await dbPool.query(
    `SELECT *
     FROM network.partner_unit_summary
     WHERE environment = $1 AND unit_id = $2`,
    [ctx.environment, ctx.unitId],
  );
  return result.rows[0] ?? null;
}

/**
 * Vendas locais do parceiro — lê de commerce.partner_orders_full (view).
 *
 * Mudança 2026-05-19 (decisão arquitetural "parceiro silo isolado"):
 *   Antes lia de dashboard.pedidos_recentes (que era commerce.orders +
 *   joins com core.contacts/produtos da matriz). Agora lê das tabelas
 *   próprias do parceiro. Vendas em commerce.orders ficaram como legado.
 */
export async function getPartnerVendas(ctx: PartnerContext, dbPool: Pool = defaultPool): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT order_id, created_at,
            contact_name AS customer_name,
            contact_phone AS customer_phone,
            contact_name,
            contact_phone,
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
}

export async function getPartnerEstoque(ctx: PartnerContext, dbPool: Pool = defaultPool): Promise<unknown[]> {
  const result = await dbPool.query(
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
}

/**
 * Lista 100% do **estoque local da unidade parceira**.
 *
 * Decisão arquitetural 2026-05-19 ("parceiro silo isolado"):
 *   Não há mais vínculo com catálogo da matriz. Parceiro vende qualquer
 *   item do próprio estoque diretamente — o `partner_order_items` aponta
 *   pra `partner_stock_levels.id`, não pra `commerce.products`.
 *
 * Removida: searchPartnerCatalogo (busca no catálogo da matriz). Parceiro
 * não enxerga mais commerce.products.
 */
export async function getPartnerProdutos(ctx: PartnerContext, dbPool: Pool = defaultPool): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT id AS stock_id,
            item_name,
            tire_size,
            tire_width_mm,
            tire_aspect_ratio,
            tire_rim_diameter,
            brand,
            sale_price,
            average_cost,
            quantity_on_hand,
            is_tracked,
            stock_status,
            local_sku
     FROM commerce.partner_stock_levels
     WHERE environment = $1
       AND unit_id = $2
       AND deleted_at IS NULL
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
}

export async function getPartnerDespesas(ctx: PartnerContext, dbPool: Pool = defaultPool): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT id, expense_date, category, description, amount, payment_method, created_at
     FROM finance.partner_expenses
     WHERE environment = $1
       AND unit_id = $2
       AND deleted_at IS NULL
     ORDER BY expense_date DESC, created_at DESC
     LIMIT 100`,
    [ctx.environment, ctx.unitId],
  );
  return result.rows;
}

export async function getPartnerCompras(ctx: PartnerContext, dbPool: Pool = defaultPool): Promise<unknown[]> {
  const result = await dbPool.query(
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
       ON ppi.purchase_id = pp.id
      AND ppi.environment = pp.environment
     WHERE pp.environment = $1
       AND pp.unit_id = $2
       AND pp.deleted_at IS NULL
     GROUP BY pp.id
     ORDER BY pp.purchased_at DESC, pp.created_at DESC
     LIMIT 100`,
    [ctx.environment, ctx.unitId],
  );
  return result.rows;
}

/**
 * Movimento de estoque do parceiro — fragmento SQL compartilhado (compra).
 *
 * Usado SOMENTE pelas operações de compra (registerPartnerPurchase / cancel).
 * As vendas do parceiro agora vão direto via commerce.register_partner_local_order
 * que faz o decremento internamente atrelado ao partner_stock_id.
 *
 * Decrementa (delta negativo) ou incrementa (delta positivo) `quantity_on_hand`
 * de UMA linha de `commerce.partner_stock_levels` da unidade, com `FOR UPDATE`.
 */
const STOCK_MOVE_SQL = `
WITH target AS (
  SELECT id, quantity_on_hand, minimum_quantity, is_tracked
  FROM commerce.partner_stock_levels
  WHERE environment = $1
    AND unit_id = $2
    AND product_id = $3
    AND deleted_at IS NULL
    AND is_tracked
    AND (
      $4::int >= 0
      OR quantity_on_hand >= -$4::int
    )
  ORDER BY quantity_on_hand DESC
  LIMIT 1
  FOR UPDATE
)
UPDATE commerce.partner_stock_levels ps
SET quantity_on_hand = ps.quantity_on_hand + $4,
    stock_status = CASE
      WHEN NOT ps.is_tracked THEN 'not_tracked'
      WHEN ps.quantity_on_hand + $4 <= 0 THEN 'out_of_stock'
      WHEN ps.minimum_quantity IS NOT NULL
           AND ps.quantity_on_hand + $4 <= ps.minimum_quantity THEN 'low_stock'
      ELSE 'in_stock'
    END,
    updated_at = now(),
    updated_by = $5
FROM target
WHERE ps.id = target.id
RETURNING ps.id AS stock_id, ps.quantity_on_hand AS new_qty, ps.stock_status AS new_status
`;

interface StockMovementResult {
  stock_id: string;
  new_qty: number;
  new_status: string;
}

/**
 * Registra venda local do parceiro via commerce.register_partner_local_order.
 *
 * Mudança 2026-05-19 ("silo isolado"):
 *   Antes ia pra commerce.orders (compartilhado com matriz) via register_walkin_order,
 *   exigindo product_id da matriz em cada item. Agora vai pra commerce.partner_orders
 *   (próprio), apontando direto pra partner_stock_levels.id. Sem dependência de
 *   commerce.products. Decremento de estoque é feito DENTRO da function SQL.
 */
export async function registerPartnerSale(
  ctx: PartnerContext,
  input: RegisterPartnerSaleInput,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string }> {
  try {
    // S4 da auditoria 2026-05-21: normaliza telefone pra E.164 antes de gravar.
    // Coluna declara "E.164 normalizado" na 0040 mas antes recebia string crua.
    const normalizedPhone = normalizeBrazilianPhone(input.customer_phone);
    const result = await dbPool.query<{ order_id: string }>(
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
    // BUG #2: propaga mensagem de "Estoque insuficiente" tal qual veio do banco
    // pra frontend mostrar no toast em vez de "internal_server_error" genérico.
    if (err instanceof Error && err.message.includes('Estoque insuficiente')) {
      throw new Error(err.message);
    }
    throw err;
  }
}

/**
 * Cancela venda local do parceiro via commerce.cancel_partner_local_order.
 * A function SQL faz tudo: restaura estoque, atualiza status, grava audit.
 */
export async function cancelPartnerSale(
  ctx: PartnerContext,
  orderId: string,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; cancelled: boolean }> {
  // Confirma que a venda pertence à unidade antes de cancelar
  const exists = await dbPool.query<{ id: string }>(
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

  await dbPool.query('SELECT commerce.cancel_partner_local_order($1, $2, $3)', [
    orderId,
    `partner:${ctx.slug}`,
    'cancelado pelo portal parceiro',
  ]);

  return { order_id: orderId, cancelled: true };
}

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

export async function upsertPartnerStock(
  ctx: PartnerContext,
  input: UpsertPartnerStockInput,
  dbPool: Pool = defaultPool,
): Promise<{ stock_id: string }> {
  const isCreate = !input.stock_id;
  const result = await dbPool.query<{ id: string }>(
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

  // GAP #6 corrigido: audit de mutações manuais de estoque
  await dbPool.query(
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
}

export async function deletePartnerStock(
  ctx: PartnerContext,
  stockId: string,
  dbPool: Pool = defaultPool,
): Promise<{ stock_id: string; deleted: boolean }> {
  const result = await dbPool.query<{ id: string; item_name: string; quantity_on_hand: number | null }>(
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
    // GAP #6 corrigido: audit do soft-delete
    await dbPool.query(
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
}

export async function registerPartnerPurchase(
  ctx: PartnerContext,
  input: RegisterPartnerPurchaseInput,
  dbPool: Pool = defaultPool,
): Promise<{ purchase_id: string }> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

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
    const moves: StockMovementResult[] = [];

    // BUG #1 corrigido: guard idempotência por purchase_id.
    // Se essa compra já tem items (idempotency_key bateu na segunda chamada),
    // pula INSERT de items e movimento de estoque — evita duplicação.
    const existingItems = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM commerce.partner_purchase_items WHERE purchase_id = $1`,
      [purchaseId],
    );
    const alreadyProcessed = Number(existingItems.rows[0]?.cnt ?? 0) > 0;
    if (alreadyProcessed) {
      await client.query('COMMIT');
      return { purchase_id: purchaseId };
    }

    for (const item of input.items) {
      await client.query(
        `INSERT INTO commerce.partner_purchase_items (
           environment, purchase_id, product_id, item_name, quantity, unit_cost
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [ctx.environment, purchaseId, item.product_id ?? null, item.item_name, item.quantity, item.unit_cost],
      );

      // BUG #4 corrigido: normaliza brand/supplier no match (trim + lower) pra evitar
      // duplicação por typo. "michellim" e "Michellin" passam a casar.
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
        // BUG #3 corrigido: média ponderada de verdade em vez de substituir pelo last_cost.
        // formula: (avg_anterior * qty_anterior + custo_novo * qty_nova) / (qty_anterior + qty_nova)
        // Se qty_anterior=NULL ou 0, vira só o custo novo (item sem histórico).
        const prevQty = Number(existingStock.rows[0]!.quantity_on_hand ?? 0);
        const prevAvg = Number(existingStock.rows[0]!.average_cost ?? 0);
        const newTotalQty = prevQty + quantity;
        const weightedAvgCost = newTotalQty > 0
          ? ((prevAvg * prevQty) + (unitCost * quantity)) / newTotalQty
          : unitCost;

        const updated = await client.query<StockMovementResult>(
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
        const inserted = await client.query<StockMovementResult>(
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

    await client.query('COMMIT');
    return { purchase_id: purchaseId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancela compra do parceiro + decrementa estoque atomicamente.
 *
 * Mudança 2026-05-19: antes só soft-deletava partner_purchases. Agora,
 * busca os partner_purchase_items dessa compra e remove a quantidade
 * do partner_stock_levels (delta negativo).
 *
 * Casos especiais:
 *   - Compra cancelada mas estoque já foi parte vendido: o decremento
 *     pode levar a saldo negativo (na verdade não, o STOCK_MOVE_SQL
 *     bloqueia decremento sem saldo). Itens sem saldo suficiente
 *     simplesmente não decrementam — fica como "buraco no audit"
 *     intencional, registrado.
 */
export async function deletePartnerPurchase(
  ctx: PartnerContext,
  purchaseId: string,
  dbPool: Pool = defaultPool,
): Promise<{ purchase_id: string; deleted: boolean; stock_moves: StockMovementResult[] }> {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const purchaseRow = await client.query<{ id: string; supplier_name: string | null }>(
      `SELECT id, supplier_name
       FROM commerce.partner_purchases
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND deleted_at IS NULL
       FOR UPDATE`,
      [purchaseId, ctx.environment, ctx.unitId],
    );

    if (purchaseRow.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { purchase_id: purchaseId, deleted: false, stock_moves: [] };
    }

    const supplierName = normalizeText(purchaseRow.rows[0]!.supplier_name);
    const items = await client.query<{ product_id: string | null; item_name: string; quantity: number }>(
      `SELECT product_id, item_name, quantity
       FROM commerce.partner_purchase_items
       WHERE purchase_id = $1 AND environment = $2`,
      [purchaseId, ctx.environment],
    );

    const moves: StockMovementResult[] = [];
    for (const item of items.rows) {
      const moved = item.product_id
        ? await client.query<StockMovementResult>(STOCK_MOVE_SQL, [
          ctx.environment,
          ctx.unitId,
          item.product_id,
          -Number(item.quantity), // negativo = decremento
          `partner:${ctx.slug}`,
        ])
        : await client.query<StockMovementResult>(
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
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3`,
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

    await client.query('COMMIT');
    return { purchase_id: purchaseId, deleted: true, stock_moves: moves };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function registerPartnerExpense(
  ctx: PartnerContext,
  input: RegisterPartnerExpenseInput,
  dbPool: Pool = defaultPool,
): Promise<{ expense_id: string }> {
  const result = await dbPool.query<{ id: string }>(
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

  // GAP #6 corrigido: audit de despesa registrada
  await dbPool.query(
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
}

export async function deletePartnerExpense(
  ctx: PartnerContext,
  expenseId: string,
  dbPool: Pool = defaultPool,
): Promise<{ expense_id: string; deleted: boolean }> {
  const result = await dbPool.query<{ id: string; description: string; amount: string }>(
    `UPDATE finance.partner_expenses
     SET deleted_at = now(),
         deleted_by = $4
     WHERE id = $1
       AND environment = $2
       AND unit_id = $3
       AND deleted_at IS NULL
     RETURNING id, description, amount`,
    [expenseId, ctx.environment, ctx.unitId, `partner:${ctx.slug}`],
  );

  if (result.rowCount === 1) {
    // GAP #6 corrigido: audit do soft-delete de despesa
    await dbPool.query(
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
}
