import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import type { RegisterWalkinOrderInput } from './queries-pedidos.js';
import { hasMatrizSellerColumn } from './payroll-schema.js';
import { applyMatrizWalkinStockSale, prepareMatrizWalkinStock } from './matriz-walkin-stock.js';

interface ExistingOrder {
  id: string;
  environment: 'prod' | 'test';
  source: string;
}

function calculateTotal(input: RegisterWalkinOrderInput): number {
  if (input.idempotency_key.trim().length < 8) throw new Error('walkin_idempotency_required');
  if (input.items.length === 0) throw new Error('walkin_items_required');

  let total = 0;
  for (const item of input.items) {
    const discount = item.discount_amount ?? 0;
    if (
      !Number.isInteger(item.quantity) || item.quantity <= 0 ||
      !Number.isFinite(item.unit_price) || item.unit_price < 0 ||
      !Number.isFinite(discount) || discount < 0
    ) {
      throw new Error('walkin_item_invalid');
    }
    total += item.quantity * item.unit_price - discount;
  }

  if (!Number.isFinite(total) || total < 0) throw new Error('walkin_total_invalid');
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

/**
 * Registra a venda de balcao da Matriz como uma unica unidade atomica.
 * O pedido so muda para confirmed depois de itens, vendedor, custo, baixa e auditoria.
 */
export async function registerWalkinOrder(
  input: RegisterWalkinOrderInput,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const normalizedPhone = normalizeBrazilianPhone(input.customer_phone);
  const total = calculateTotal(input);
  const client = await dbPool.connect();

  try {
    await client.query('BEGIN');

    // Serializa retries/duplo clique antes de consultar ou criar o pedido.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      // O indice de idempotencia atual e global, portanto o lock tambem deve ser.
      [`walkin-order:${input.idempotency_key}`],
    );

    const existing = await client.query<ExistingOrder>(
      `SELECT id, environment::text AS environment, source
         FROM commerce.orders
        WHERE idempotency_key = $1
        LIMIT 1`,
      [input.idempotency_key],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.environment !== environment || row.source !== input.source_tag) {
        throw new Error('walkin_idempotency_conflict');
      }
      await client.query('COMMIT');
      return { order_id: row.id };
    }

    // Venda de balcao desta rota pertence exclusivamente a unidade principal da Matriz.
    const unit = await client.query<{ id: string }>(
      `SELECT id
         FROM core.units
        WHERE environment = $1 AND slug = 'main' AND is_active
          AND ($2::uuid IS NULL OR id = $2)
        LIMIT 1
        FOR SHARE`,
      [environment, input.unit_id ?? null],
    );
    const unitId = unit.rows[0]?.id;
    if (!unitId) throw new Error('walkin_unit_not_found');

    if (input.seller_collaborator_id) {
      if (!await hasMatrizSellerColumn(client, 'orders')) {
        throw new Error('seller_schema_not_ready');
      }
      const seller = await client.query<{ id: string }>(
        `SELECT id
           FROM network.matriz_collaborators
          WHERE id = $1 AND environment = $2 AND revoked_at IS NULL
          FOR SHARE`,
        [input.seller_collaborator_id, environment],
      );
      if (!seller.rows[0]) throw new Error('seller_collaborator_not_found');
    }

    // Trava e valida o saldo/custo antes de criar cliente ou pedido.
    const requestedItems = input.items.map((item) => ({
      productId: item.product_id,
      quantity: item.quantity,
    }));
    const stockPlan = await prepareMatrizWalkinStock(client, environment, requestedItems);

    // A funcao legada de cliente faz select+insert; este lock evita corrida pelo mesmo telefone.
    if (normalizedPhone) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`walkin-customer:${environment}:${normalizedPhone}`],
      );
    }
    const customer = await client.query<{ customer_id: string }>(
      `SELECT commerce.find_or_create_customer($1, $2, $3) AS customer_id`,
      [environment, input.customer_name ?? null, normalizedPhone],
    );
    const customerId = customer.rows[0]?.customer_id;
    if (!customerId) throw new Error('walkin_customer_not_found');

    const order = await client.query<{ id: string }>(
      `INSERT INTO commerce.orders (
         environment, contact_id, customer_id, source_conversation_id,
         total_amount, status, fulfillment_mode, payment_method,
         delivery_address, closed_by, closed_at,
         idempotency_key, source, unit_id
       ) VALUES (
         $1, NULL, $2, NULL,
         $3, 'open', $4, $5,
         $6, NULL, NULL,
         $7, $8, $9
       )
       RETURNING id`,
      [
        environment, customerId, total, input.fulfillment_mode, input.payment_method,
        input.delivery_address ?? null, input.idempotency_key, input.source_tag, unitId,
      ],
    );
    const orderId = order.rows[0]?.id;
    if (!orderId) throw new Error('walkin_order_not_created');

    for (const item of input.items) {
      const snapshotCost = stockPlan.costByProduct.get(item.product_id);
      if (snapshotCost === undefined) throw new Error('walkin_cost_missing');
      await client.query(
        `INSERT INTO commerce.order_items (
           environment, order_id, product_id, quantity, unit_price, discount_amount,
           matriz_unit_cost
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          environment, orderId, item.product_id, item.quantity, item.unit_price,
          item.discount_amount ?? 0, snapshotCost,
        ],
      );
    }

    if (input.seller_collaborator_id) {
      const assigned = await client.query(
        `UPDATE commerce.orders
            SET seller_collaborator_id = $3
          WHERE id = $1 AND environment = $2
          RETURNING id`,
        [orderId, environment, input.seller_collaborator_id],
      );
      if (assigned.rowCount !== 1) throw new Error('seller_collaborator_not_found');
    }

    await applyMatrizWalkinStockSale(client, environment, orderId, stockPlan);

    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type,
         actor_label, idempotency_key, payload_after
       ) VALUES (
         $1, 'orders', 'commerce.orders', $2, 'walkin_order_created',
         $3, $4, $5::jsonb
       )`,
      [environment, orderId, input.actor_label, input.idempotency_key, JSON.stringify({
        total,
        items: input.items,
        unit_id: unitId,
        customer_id: customerId,
        customer_name: input.customer_name ?? null,
        customer_phone: normalizedPhone,
        source_tag: input.source_tag,
        payment_method: input.payment_method,
        fulfillment_mode: input.fulfillment_mode,
      })],
    );

    const confirmed = await client.query(
      `UPDATE commerce.orders
          SET status = 'confirmed', closed_by = $3, closed_at = now(), updated_at = now()
        WHERE id = $1 AND environment = $2 AND status = 'open'
        RETURNING id`,
      [orderId, environment, input.actor_label],
    );
    if (confirmed.rowCount !== 1) throw new Error('walkin_order_not_confirmed');

    await client.query('COMMIT');
    return { order_id: orderId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
