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
import { pool } from '../persistence/db.js';
import { logger } from '../shared/logger.js';
import { ChatwootApiClient } from '../admin/chatwoot-api.client.js';
import { normalizeBrazilianPhone } from '../shared/phone.js';
import type { PartnerContext } from './auth.js';

export interface PartnerOrderItemInput {
  partner_stock_id: string;
  quantity: number;
  unit_price: number;
  discount_amount?: number;
}

export interface RegisterPartnerSaleInput {
  customer_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_cpf?: string | null;
  items: PartnerOrderItemInput[];
  payment_method: string | null;
  payment_status?: 'received' | 'receivable' | null;
  receivable_due_date?: string | null;
  receivable_installments?: number | null;
  fulfillment_mode: 'delivery' | 'pickup';
  delivery_address?: string | null;
  notes?: string | null;
  received_amount?: number | null;
  discount_amount?: number | null;
  freight_amount?: number | null;
  source_tag?: 'porta' | '2w' | 'walkin_balcao' | 'walkin_telefone' | 'outro' | null;
  idempotency_key: string;
}

export interface PartnerCustomerInput {
  name: string;
  phone?: string | null;
  cpf?: string | null;
  address?: string | null;
  address_street?: string | null;
  address_number?: string | null;
  address_neighborhood?: string | null;
  address_city?: string | null;
  is_vip?: boolean | null;
  idempotency_key?: string | null;
}

export interface SettlePartnerReceivableInstallmentInput {
  received_at?: string | null;
  payment_method?: string | null;
}

export interface UpsertPartnerStockInput {
  stock_id?: string | null;
  product_id?: string | null;
  local_sku?: string | null;
  item_name: string;
  item_type?: 'pneu' | 'insumo' | 'servico';
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
  tire_condition?: string | null;
  shelf_location?: string | null;
  tire_position?: string | null;
  is_tracked: boolean;
}

export interface RegisterPartnerPurchaseInput {
  supplier_name?: string | null;
  purchased_at?: string | null;
  payment_method?: string | null;
  payment_status?: 'paid_now' | 'payable' | null;
  payable_due_date?: string | null;
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
  category: 'employee_payment' | 'rent' | 'utilities' | 'maintenance' | 'delivery' | 'tax' | 'supplier_payment' | 'other';
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
  force_duplicate?: boolean;
}

export type UpdatePartnerPayableInput = Pick<
  RegisterPartnerPayableInput,
  'counterparty_name' | 'description' | 'category' | 'amount' | 'due_date' | 'notes'
>;

export interface RegisterPartnerReceivableInput {
  customer_id?: string | null;
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

export type UpdatePartnerReceivableInput = Pick<
  RegisterPartnerReceivableInput,
  'customer_id' | 'customer_name' | 'description' | 'source_tag' | 'amount' | 'due_date' | 'notes'
>;

export interface SettlePartnerPayableInput {
  paid_at?: string | null;
  payment_method?: string | null;
  force_duplicate?: boolean;
}

export class DuplicateExpenseError extends Error {
  readonly code = 'duplicate_expense';
  readonly duplicates: Array<{ id: string; expense_date: string; amount: string; description: string }>;
  constructor(duplicates: DuplicateExpenseError['duplicates']) {
    super('duplicate_expense');
    this.duplicates = duplicates;
  }
}

export class InstallmentsTooSmallError extends Error {
  readonly code = 'installments_below_minimum';
  readonly total_cents: number;
  readonly installments: number;
  constructor(totalCents: number, installments: number) {
    super(`installments_below_minimum: total R$ ${(totalCents / 100).toFixed(2)} insuficiente para ${installments} parcelas (cada parcela ficaria menor que R$ 0,01)`);
    this.total_cents = totalCents;
    this.installments = installments;
  }
}

export class PaidPurchaseLockedError extends Error {
  readonly code = 'cannot_delete_paid_purchase';
  readonly purchase_id: string;
  readonly paid_payable_id: string;
  constructor(purchaseId: string, paidPayableId: string) {
    super('cannot_delete_paid_purchase');
    this.purchase_id = purchaseId;
    this.paid_payable_id = paidPayableId;
  }
}

export class PartialStockReversalError extends Error {
  readonly code = 'stock_reversal_incomplete';
  readonly failed_items: Array<{ item_name: string; quantity: number }>;
  constructor(failedItems: PartialStockReversalError['failed_items']) {
    super('stock_reversal_incomplete');
    this.failed_items = failedItems;
  }
}

export interface SettlePartnerReceivableInput {
  received_at?: string | null;
  payment_method?: string | null;
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

export async function getPartnerFluxoCaixa(ctx: PartnerContext): Promise<unknown> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT *
       FROM network.partner_cash_flow_projection
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
              customer_cpf,
              customer_id,
              contact_name, contact_phone,
              source_tag AS source,
              source_tag,
              status, payment_method, fulfillment_mode, delivery_address,
              delivery_status, delivery_courier, dispatched_at, delivered_at,
              total_amount, received_amount, notes, items
       FROM commerce.partner_orders_full
       WHERE environment = $1 AND unit_id = $2
       ORDER BY created_at DESC
       LIMIT 500`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export async function getPartnerEstoque(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT id, product_id, local_sku, item_name, item_type, tire_size,
              tire_width_mm, tire_aspect_ratio, tire_rim_diameter,
              brand, supplier_name, tire_condition, shelf_location, tire_position,
              quantity_on_hand, minimum_quantity, average_cost, sale_price,
              is_tracked, stock_status, created_at, updated_at
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
              item_name, item_type, tire_size,
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

export async function getPartnerCustomers(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT id, name, phone, cpf, address,
              address_street, address_number, address_neighborhood, address_city,
              is_vip, created_at, updated_at
       FROM commerce.partner_customers
       WHERE environment = $1
         AND unit_id = $2
         AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 300`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export async function searchPartnerCustomers(ctx: PartnerContext, q: string): Promise<unknown[]> {
  const search = q.trim();
  if (!search) return [];
  const digits = search.replace(/\D/g, '');
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT id, name, phone, cpf, address,
              address_street, address_number, address_neighborhood, address_city,
              is_vip, created_at, updated_at
       FROM commerce.partner_customers
       WHERE environment = $1
         AND unit_id = $2
         AND deleted_at IS NULL
         AND (
           lower(name) LIKE lower($3)
           OR ($4 <> '' AND phone LIKE $5)
           OR ($4 <> '' AND cpf LIKE $5)
           OR lower(COALESCE(address, '')) LIKE lower($3)
           OR lower(COALESCE(address_street, '')) LIKE lower($3)
           OR lower(COALESCE(address_neighborhood, '')) LIKE lower($3)
           OR lower(COALESCE(address_city, '')) LIKE lower($3)
         )
       ORDER BY updated_at DESC
       LIMIT 30`,
      [ctx.environment, ctx.unitId, `%${search}%`, digits, `%${digits}%`],
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
              pp.payment_status, pp.payable_due_date,
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
              status, paid_at, payment_method, notes, created_at, source_purchase_id
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
      `SELECT pr.id, pr.customer_id, pr.customer_name, pr.description, pr.source_tag, pr.amount, pr.due_date,
              pr.status, pr.received_at, pr.payment_method, pr.notes, pr.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', pri.id,
                'sequence', pri.sequence,
                'amount', pri.amount,
                'due_date', pri.due_date,
                'status', pri.status,
                'received_at', pri.received_at,
                'payment_method', pri.payment_method
              ) ORDER BY pri.sequence) FILTER (WHERE pri.id IS NOT NULL AND pri.deleted_at IS NULL), '[]'::jsonb) AS installments
       FROM finance.partner_receivables pr
       LEFT JOIN finance.partner_receivable_installments pri
         ON pri.receivable_id = pr.id AND pri.deleted_at IS NULL
       WHERE pr.environment = $1 AND pr.unit_id = $2 AND pr.deleted_at IS NULL
       GROUP BY pr.id
       ORDER BY
         CASE pr.status WHEN 'open' THEN 1 WHEN 'received' THEN 2 ELSE 3 END,
         pr.due_date ASC NULLS LAST,
         pr.created_at DESC
       LIMIT 100`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export async function settlePartnerReceivableInstallment(
  ctx: PartnerContext,
  receivableId: string,
  installmentId: string,
  input: SettlePartnerReceivableInstallmentInput,
): Promise<{ installment_id: string; received: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const receivedAt = input.received_at ?? new Date().toISOString();
    const result = await client.query<{ id: string }>(
      `UPDATE finance.partner_receivable_installments
       SET status = 'received',
           received_at = $4::timestamptz,
           payment_method = COALESCE($5, payment_method)
       WHERE id = $1
         AND receivable_id = $2
         AND environment = $3
         AND status = 'open'
         AND deleted_at IS NULL
       RETURNING id`,
      [installmentId, receivableId, ctx.environment, receivedAt, input.payment_method ?? null],
    );

    if (result.rowCount !== 1) return { installment_id: installmentId, received: false };

    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type,
         actor_label, payload_after
       ) VALUES ($1, 'partner_finance', 'finance.partner_receivable_installments', $2,
                 'partner_receivable_installment_received', $3, $4::jsonb)`,
      [
        ctx.environment,
        installmentId,
        `partner:${ctx.slug}`,
        JSON.stringify({ unit_id: ctx.unitId, receivable_id: receivableId, received_at: receivedAt }),
      ],
    );
    return { installment_id: installmentId, received: true };
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
      const normalizedCpf = normalizeCpf(input.customer_cpf);
      let customerId = input.customer_id ?? null;
      if (customerId) {
        const customer = await client.query<{ id: string }>(
          `SELECT id
           FROM commerce.partner_customers
           WHERE id = $1
             AND environment = $2
             AND unit_id = $3
             AND deleted_at IS NULL
           LIMIT 1`,
          [customerId, ctx.environment, ctx.unitId],
        );
        if (customer.rowCount !== 1) {
          throw new Error('Cliente nao encontrado nesta unidade.');
        }
      } else if (normalizeText(input.customer_name) && (normalizedPhone || normalizedCpf)) {
        customerId = await upsertPartnerCustomerWithClient(client, ctx, {
          name: input.customer_name ?? '',
          phone: normalizedPhone,
          cpf: normalizedCpf,
          idempotency_key: `sale:${input.idempotency_key}:customer`,
        });
      }

      const result = await client.query<{ order_id: string }>(
        `SELECT commerce.register_partner_local_order(
           $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13
         ) AS order_id`,
        [
          ctx.environment,
          ctx.unitId,
          input.customer_name ?? null,
          normalizedPhone,
          JSON.stringify(input.items),
          input.payment_status === 'receivable' ? 'A receber' : input.payment_method,
          input.fulfillment_mode,
          input.delivery_address ?? null,
          `partner:${ctx.slug}`,
          input.idempotency_key,
          input.source_tag ?? 'porta',
          input.discount_amount ?? 0,
          input.freight_amount ?? 0,
        ],
      );
      const orderId = result.rows[0]!.order_id;
      const normalizedNotes = normalizeText(input.notes);
      const receivedAmount = input.payment_status === 'receivable'
        ? null
        : (input.received_amount ?? null);

      if (normalizedNotes !== null || receivedAmount !== null || normalizedCpf !== null || customerId !== null) {
        await client.query(
          `UPDATE commerce.partner_orders
           SET notes = $4,
               received_amount = $5,
               customer_cpf = $6,
               customer_id = $7,
               updated_at = now()
           WHERE id = $1
             AND environment = $2
             AND unit_id = $3`,
          [orderId, ctx.environment, ctx.unitId, normalizedNotes, receivedAmount, normalizedCpf, customerId],
        );
      }

      if (input.payment_status === 'receivable') {
        const order = await client.query<{
          total_amount: string;
          customer_name: string | null;
        }>(
          `SELECT total_amount, customer_name
           FROM commerce.partner_orders
           WHERE id = $1
             AND environment = $2
             AND unit_id = $3
             AND deleted_at IS NULL
           LIMIT 1`,
          [orderId, ctx.environment, ctx.unitId],
        );

        const row = order.rows[0];
        if (!row) {
          throw new Error(
            `partner_sale_receivable_missing_order: venda ${orderId} criada mas nao encontrada para gerar conta a receber`,
          );
        }

        const receivableResult = await client.query<{ id: string }>(
          `INSERT INTO finance.partner_receivables (
             environment, unit_id, customer_id, customer_name, description, source_tag, amount,
             due_date, status, received_at, payment_method, notes, created_by,
             idempotency_key, source_order_id
           ) VALUES (
             $1, $2, $3, $4, $5, COALESCE($6, 'porta'), $7,
             $8::date, 'open', NULL, NULL, $9, $10, $11, $12
           )
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
           DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
           RETURNING id`,
          [
            ctx.environment,
            ctx.unitId,
            customerId,
            input.customer_name ?? row.customer_name ?? null,
            `Venda a receber ${orderId.slice(0, 8)}`,
            input.source_tag ?? 'porta',
            row.total_amount,
            input.receivable_due_date ?? null,
            `Gerada automaticamente pela venda ${orderId}`,
            `partner:${ctx.slug}`,
            `order:${orderId}:receivable`,
            orderId,
          ],
        );

        const receivableId = receivableResult.rows[0]?.id;
        if (receivableId) {
          await client.query(
            `INSERT INTO audit.events (
               environment, domain, entity_table, entity_id, event_type,
               actor_label, payload_after
             ) VALUES ($1, 'partner_finance', 'finance.partner_receivables', $2,
                       'partner_receivable_auto_created', $3, $4::jsonb)`,
            [
              ctx.environment,
              receivableId,
              `partner:${ctx.slug}`,
              JSON.stringify({
                unit_id: ctx.unitId,
                source_order_id: orderId,
                amount: row.total_amount,
                due_date: input.receivable_due_date ?? null,
                installments: input.receivable_installments ?? 1,
              }),
            ],
          );

          // Etapa 6: se installments > 1, cria parcelas (intervalo fixo 30d)
          const installments = Math.max(1, Math.floor(input.receivable_installments ?? 1));
          if (installments > 1 && input.receivable_due_date) {
            const totalCents = Math.round(Number(row.total_amount) * 100);
            // Fix pos-Codex: valor minimo - cada parcela precisa de pelo menos
            // 1 centavo. Sem isso, viola CHECK (amount > 0) na tabela.
            if (totalCents < installments) {
              throw new InstallmentsTooSmallError(totalCents, installments);
            }
            const baseCents = Math.floor(totalCents / installments);
            for (let i = 1; i <= installments; i++) {
              // Ultima parcela leva o resto de arredondamento
              const cents = i === installments ? totalCents - baseCents * (installments - 1) : baseCents;
              // Fix pos-Codex: ON CONFLICT garante idempotencia em retry HTTP.
              // partner_orders e partner_receivables ja deduplicam via idempotency_key;
              // sem este DO NOTHING, retry estourava UNIQUE (receivable_id, sequence).
              await client.query(
                `INSERT INTO finance.partner_receivable_installments (
                   environment, receivable_id, sequence, amount, due_date, status
                 ) VALUES ($1, $2, $3, $4::numeric / 100, ($5::date + (($3 - 1) * 30) * INTERVAL '1 day')::date, 'open')
                 ON CONFLICT (receivable_id, sequence) DO NOTHING`,
                [ctx.environment, receivableId, i, cents, input.receivable_due_date],
              );
            }
          }
        }
      }

      return { order_id: orderId };
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

export interface UpdatePartnerDeliveryInput {
  delivery_status: 'pending' | 'dispatched' | 'delivered' | 'failed';
  delivery_courier?: string | null;
  // Metodo recebido na entrega (pix/dinheiro/cartao). So usado quando delivery_status='delivered':
  // dispara o recebimento da conta a receber vinculada (COD).
  payment_method?: string | null;
}

export class DeliveryAlreadyFinalizedError extends Error {
  readonly code = 'delivery_already_finalized';
  constructor() {
    super('delivery_already_finalized');
  }
}

// Atualiza o estado operacional da entrega de um pedido (fulfillment_mode=delivery).
//
// COD (0069): o pedido de entrega nasce como "a receber" (payment_method='A receber'
// + conta a receber aberta apontando via source_order_id). Os gatilhos sao:
//   - delivered (finalizada): RECEBE a conta a receber -> entra no caixa do dia +
//     marca o pedido como 'paid'. So aqui ele vira venda do mes (a view exclui
//     entrega nao-delivered).
//   - failed (nao entregue/devolvido): CANCELA o pedido (devolve estoque) + CANCELA
//     a conta a receber. Nada entra no caixa.
//   - pending/dispatched: so muda estado operacional + carimba dispatched_at.
//
// O pedido mantem payment_method='A receber' mesmo apos finalizado: o caixa vem
// SO da conta a receber recebida, pra nao duplicar.
export async function updatePartnerDeliveryStatus(
  ctx: PartnerContext,
  orderId: string,
  input: UpdatePartnerDeliveryInput,
): Promise<{ order_id: string; delivery_status: string }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const courier = normalizeText(input.delivery_courier);

    const existing = await client.query<{ status: string; delivery_status: string }>(
      `SELECT status, delivery_status
       FROM commerce.partner_orders
       WHERE id = $1 AND environment = $2 AND unit_id = $3
         AND fulfillment_mode = 'delivery' AND deleted_at IS NULL
       LIMIT 1`,
      [orderId, ctx.environment, ctx.unitId],
    );
    if (existing.rowCount !== 1) throw new Error('delivery_not_found');

    // Integridade: uma entrega ja finalizada (dinheiro no caixa) nao pode ser
    // "reaberta" por este endpoint — evita destravar caixa sem estorno controlado.
    if (existing.rows[0]!.delivery_status === 'delivered' && input.delivery_status !== 'delivered') {
      throw new DeliveryAlreadyFinalizedError();
    }

    // ── Nao entregue / devolvido: estorna estoque + cancela a receber ──
    if (input.delivery_status === 'failed') {
      if (existing.rows[0]!.status !== 'cancelled') {
        await client.query('SELECT commerce.cancel_partner_local_order($1, $2, $3)', [
          orderId,
          `partner:${ctx.slug}`,
          'entrega nao realizada (nao entregue/devolvido)',
        ]);
      }
      await client.query(
        `UPDATE commerce.partner_orders
         SET delivery_status = 'failed',
             delivery_courier = COALESCE($4, delivery_courier),
             updated_at = now()
         WHERE id = $1 AND environment = $2 AND unit_id = $3`,
        [orderId, ctx.environment, ctx.unitId, courier],
      );
      await client.query(
        `UPDATE finance.partner_receivables
         SET status = 'cancelled', deleted_at = now(), deleted_by = $4
         WHERE source_order_id = $1 AND environment = $2 AND unit_id = $3
           AND status = 'open' AND deleted_at IS NULL`,
        [orderId, ctx.environment, ctx.unitId, `partner:${ctx.slug}`],
      );
      await client.query(
        `INSERT INTO audit.events (
           environment, domain, entity_table, entity_id, event_type,
           actor_label, payload_after
         ) VALUES ($1, 'partner_orders', 'commerce.partner_orders', $2,
                   'partner_delivery_status_changed', $3, $4::jsonb)`,
        [
          ctx.environment,
          orderId,
          `partner:${ctx.slug}`,
          JSON.stringify({ unit_id: ctx.unitId, delivery_status: 'failed', delivery_courier: courier }),
        ],
      );
      return { order_id: orderId, delivery_status: 'failed' };
    }

    // ── pending / dispatched / delivered ──
    const result = await client.query<{ id: string; delivery_status: string }>(
      `UPDATE commerce.partner_orders
       SET delivery_status = $4,
           status = CASE WHEN $4 = 'delivered' THEN 'paid' ELSE status END,
           delivery_courier = COALESCE($5, delivery_courier),
           dispatched_at = CASE
             WHEN $4 IN ('dispatched', 'delivered') AND dispatched_at IS NULL THEN now()
             WHEN $4 = 'pending' THEN NULL
             ELSE dispatched_at
           END,
           delivered_at = CASE
             WHEN $4 = 'delivered' THEN now()
             ELSE NULL
           END,
           updated_at = now()
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND fulfillment_mode = 'delivery'
         AND deleted_at IS NULL
       RETURNING id, delivery_status`,
      [orderId, ctx.environment, ctx.unitId, input.delivery_status, courier],
    );

    if (result.rowCount !== 1) throw new Error('delivery_not_found');

    // Finalizada: recebe a conta a receber vinculada (COD) -> entra no caixa.
    if (input.delivery_status === 'delivered') {
      await client.query(
        `UPDATE finance.partner_receivables
         SET status = 'received', received_at = now(),
             payment_method = COALESCE($4, payment_method)
         WHERE source_order_id = $1 AND environment = $2 AND unit_id = $3
           AND status = 'open' AND deleted_at IS NULL`,
        [orderId, ctx.environment, ctx.unitId, normalizeText(input.payment_method)],
      );
    }

    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type,
         actor_label, payload_after
       ) VALUES ($1, 'partner_orders', 'commerce.partner_orders', $2,
                 'partner_delivery_status_changed', $3, $4::jsonb)`,
      [
        ctx.environment,
        orderId,
        `partner:${ctx.slug}`,
        JSON.stringify({ unit_id: ctx.unitId, delivery_status: input.delivery_status, delivery_courier: courier }),
      ],
    );

    return { order_id: orderId, delivery_status: result.rows[0]!.delivery_status };
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

function normalizeCpf(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits.length === 11 ? digits : null;
}

async function upsertPartnerCustomerWithClient(
  client: PoolClient,
  ctx: PartnerContext,
  input: PartnerCustomerInput,
): Promise<string | null> {
  const name = normalizeText(input.name);
  if (!name) return null;

  const phone = normalizeBrazilianPhone(input.phone);
  const cpf = normalizeCpf(input.cpf);
  const address = normalizeText(input.address);
  const addressStreet = normalizeText(input.address_street);
  const addressNumber = normalizeText(input.address_number);
  const addressNeighborhood = normalizeText(input.address_neighborhood);
  const addressCity = normalizeText(input.address_city);
  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM commerce.partner_customers
     WHERE environment = $1
       AND unit_id = $2
       AND deleted_at IS NULL
       AND (
         ($3::text IS NOT NULL AND cpf = $3)
         OR ($4::text IS NOT NULL AND phone = $4)
       )
     ORDER BY updated_at DESC
     LIMIT 1`,
    [ctx.environment, ctx.unitId, cpf, phone],
  );

  if (existing.rows[0]?.id) {
    const customerId = existing.rows[0].id;
    await client.query(
      `UPDATE commerce.partner_customers
       SET name = $4,
           phone = COALESCE($5, phone),
           cpf = COALESCE($6, cpf),
           address = COALESCE($7, address),
           address_street = COALESCE($8, address_street),
           address_neighborhood = COALESCE($9, address_neighborhood),
           address_city = COALESCE($10, address_city),
           address_number = COALESCE($11, address_number)
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3`,
      [
        customerId,
        ctx.environment,
        ctx.unitId,
        name,
        phone,
        cpf,
        address,
        addressStreet,
        addressNeighborhood,
        addressCity,
        addressNumber,
      ],
    );
    return customerId;
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO commerce.partner_customers (
       environment, unit_id, name, phone, cpf, address,
       address_street, address_neighborhood, address_city,
       idempotency_key, address_number
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
     DO UPDATE SET
       name = EXCLUDED.name,
       phone = COALESCE(EXCLUDED.phone, commerce.partner_customers.phone),
       cpf = COALESCE(EXCLUDED.cpf, commerce.partner_customers.cpf),
       address = COALESCE(EXCLUDED.address, commerce.partner_customers.address),
       address_street = COALESCE(EXCLUDED.address_street, commerce.partner_customers.address_street),
       address_number = COALESCE(EXCLUDED.address_number, commerce.partner_customers.address_number),
       address_neighborhood = COALESCE(EXCLUDED.address_neighborhood, commerce.partner_customers.address_neighborhood),
       address_city = COALESCE(EXCLUDED.address_city, commerce.partner_customers.address_city)
     RETURNING id`,
    [
      ctx.environment,
      ctx.unitId,
      name,
      phone,
      cpf,
      address,
      addressStreet,
      addressNeighborhood,
      addressCity,
      input.idempotency_key ?? null,
      addressNumber,
    ],
  );
  return inserted.rows[0]?.id ?? null;
}

export async function createPartnerCustomer(
  ctx: PartnerContext,
  input: PartnerCustomerInput,
): Promise<{ customer_id: string | null }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => ({
    customer_id: await upsertPartnerCustomerWithClient(client, ctx, input),
  }));
}

export async function updatePartnerCustomer(
  ctx: PartnerContext,
  customerId: string,
  input: PartnerCustomerInput,
): Promise<{ customer_id: string }> {
  const name = normalizeText(input.name);
  if (!name) throw new Error('customer_name_required');

  const phone = normalizeBrazilianPhone(input.phone);
  const cpf = normalizeCpf(input.cpf);
  const address = normalizeText(input.address);
  const addressStreet = normalizeText(input.address_street);
  const addressNumber = normalizeText(input.address_number);
  const addressNeighborhood = normalizeText(input.address_neighborhood);
  const addressCity = normalizeText(input.address_city);

  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    let result;
    try {
      result = await client.query<{ id: string }>(
        `UPDATE commerce.partner_customers
         SET name = $4,
             phone = $5,
             cpf = $6,
             address = $7,
             address_street = $8,
             address_number = $9,
             address_neighborhood = $10,
             address_city = $11
         WHERE id = $1
           AND environment = $2
           AND unit_id = $3
           AND deleted_at IS NULL
         RETURNING id`,
        [
          customerId,
          ctx.environment,
          ctx.unitId,
          name,
          phone,
          cpf,
          address,
          addressStreet,
          addressNumber,
          addressNeighborhood,
          addressCity,
        ],
      );
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        const constraint = (err as { constraint?: string })?.constraint ?? '';
        throw new Error(constraint.includes('cpf') ? 'customer_cpf_conflict' : 'customer_phone_conflict');
      }
      throw err;
    }
    const row = result.rows[0];
    if (!row) throw new Error('customer_not_found');
    return { customer_id: row.id };
  });
}

export async function deletePartnerCustomer(
  ctx: PartnerContext,
  customerId: string,
): Promise<{ customer_id: string }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE commerce.partner_customers
       SET deleted_at = now()
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND deleted_at IS NULL
       RETURNING id`,
      [customerId, ctx.environment, ctx.unitId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('customer_not_found');
    return { customer_id: row.id };
  });
}

function payableCategoryToExpenseCategory(
  category: RegisterPartnerPayableInput['category'],
): RegisterPartnerExpenseInput['category'] {
  const map: Record<string, RegisterPartnerExpenseInput['category']> = {
    supplier: 'supplier_payment',
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
         sale_price, is_tracked, stock_status, updated_by, item_type,
         tire_condition, shelf_location, tire_position
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7,
         $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21, $22, $23
       )
       ON CONFLICT (id) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         local_sku = EXCLUDED.local_sku,
         item_name = EXCLUDED.item_name,
         item_type = EXCLUDED.item_type,
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
         tire_condition = EXCLUDED.tire_condition,
         shelf_location = EXCLUDED.shelf_location,
         tire_position = EXCLUDED.tire_position,
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
        input.item_type ?? 'pneu',
        input.tire_condition ?? null,
        input.shelf_location ?? null,
        input.tire_position ?? null,
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
    const paymentStatus = input.payment_status === 'payable' ? 'payable' : 'paid_now';
    if (paymentStatus === 'payable' && !input.payable_due_date) {
      throw new Error('payable_due_date_required_when_payment_status_payable');
    }
    const purchase = await client.query<{ id: string }>(
      `INSERT INTO commerce.partner_purchases (
         environment, unit_id, supplier_name, purchased_at, total_amount,
         payment_method, notes, created_by, idempotency_key,
         payment_status, payable_due_date
       ) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6, $7, $8, $9, $10, $11::date)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id`,
      [
        ctx.environment,
        ctx.unitId,
        input.supplier_name ?? null,
        input.purchased_at ?? null,
        total,
        paymentStatus === 'payable' ? 'A pagar' : input.payment_method ?? null,
        input.notes ?? null,
        `partner:${ctx.slug}`,
        input.idempotency_key ?? null,
        paymentStatus,
        paymentStatus === 'payable' ? input.payable_due_date : null,
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

    // Etapa 3: compra a prazo gera partner_payable vinculado.
    // UNIQUE parcial em source_purchase_id (Etapa 2) garante 1 payable por compra.
    if (paymentStatus === 'payable') {
      const supplierLabel = input.supplier_name?.trim() || 'fornecedor';
      const payableResult = await client.query<{ id: string }>(
        `INSERT INTO finance.partner_payables (
           environment, unit_id, counterparty_name, description, category, amount,
           due_date, status, notes, created_by, idempotency_key, source_purchase_id
         ) VALUES (
           $1, $2, $3, $4, 'supplier', $5,
           $6::date, 'open', $7, $8, $9, $10
         )
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
         DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING id`,
        [
          ctx.environment,
          ctx.unitId,
          input.supplier_name?.trim() || null,
          `Compra a pagar ${purchaseId.slice(0, 8)} (${supplierLabel})`,
          total,
          input.payable_due_date,
          `Gerado automaticamente pela compra ${purchaseId}`,
          `partner:${ctx.slug}`,
          `purchase:${purchaseId}:payable`,
          purchaseId,
        ],
      );
      const payableId = payableResult.rows[0]?.id;
      if (payableId) {
        await client.query(
          `INSERT INTO audit.events (
             environment, domain, entity_table, entity_id, event_type,
             actor_label, payload_after
           ) VALUES ($1, 'partner_finance', 'finance.partner_payables', $2,
                     'partner_payable_auto_created', $3, $4::jsonb)`,
          [
            ctx.environment,
            payableId,
            `partner:${ctx.slug}`,
            JSON.stringify({
              unit_id: ctx.unitId,
              source_purchase_id: purchaseId,
              amount: total,
              due_date: input.payable_due_date,
              supplier_name: input.supplier_name ?? null,
            }),
          ],
        );
      }
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

    // Fix pos-Codex (#3): bloqueia delete se houver payable vinculado JA PAGO.
    // Apagar a compra deixaria o pagamento orfao no caixa - trail contabil quebrado.
    // Estorno automatico fica para Etapa futura.
    const paidPayable = await client.query<{ id: string }>(
      `SELECT id FROM finance.partner_payables
       WHERE source_purchase_id = $1
         AND environment = $2
         AND unit_id = $3
         AND status = 'paid'
         AND deleted_at IS NULL
       LIMIT 1`,
      [purchaseId, ctx.environment, ctx.unitId],
    );
    if (paidPayable.rowCount && paidPayable.rowCount > 0) {
      throw new PaidPurchaseLockedError(purchaseId, paidPayable.rows[0]!.id);
    }

    const supplierName = normalizeText(purchaseRow.rows[0]!.supplier_name);
    const items = await client.query<{ product_id: string | null; item_name: string; quantity: number }>(
      `SELECT product_id, item_name, quantity
       FROM commerce.partner_purchase_items
       WHERE purchase_id = $1 AND environment = $2`,
      [purchaseId, ctx.environment],
    );

    const moves: Array<{ stock_id: string; new_qty: number; new_status: string }> = [];
    const failedReversals: Array<{ item_name: string; quantity: number }> = [];
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
      } else {
        // Fix pos-Codex (#4 mini-trava): se nao achou stock pra estornar este item,
        // registra. Se sobrar item sem estorno, ABORTA o delete inteiro abaixo
        // (rollback automatico via throw). Etapa 7 vai resolver com FK direta
        // partner_purchase_items -> partner_stock_levels.
        failedReversals.push({ item_name: item.item_name, quantity: Number(item.quantity) });
      }
    }

    if (failedReversals.length > 0) {
      throw new PartialStockReversalError(failedReversals);
    }

    await client.query(
      `UPDATE commerce.partner_purchases
       SET deleted_at = now(),
           deleted_by = $4
       WHERE id = $1 AND environment = $2 AND unit_id = $3`,
      [purchaseId, ctx.environment, ctx.unitId, `partner:${ctx.slug}`],
    );

    // Etapa 3: cancela payable vinculado em cascata (mesma logica que
    // cancel_partner_local_order faz para receivable de venda).
    const cancelledPayable = await client.query<{ id: string }>(
      `UPDATE finance.partner_payables
       SET status = 'cancelled',
           deleted_at = now(),
           deleted_by = $4
       WHERE source_purchase_id = $1
         AND environment = $2
         AND unit_id = $3
         AND status = 'open'
         AND deleted_at IS NULL
       RETURNING id`,
      [purchaseId, ctx.environment, ctx.unitId, `partner:${ctx.slug}`],
    );
    if (cancelledPayable.rowCount && cancelledPayable.rowCount > 0) {
      await client.query(
        `INSERT INTO audit.events (
           environment, domain, entity_table, entity_id, event_type,
           actor_label, payload_after
         ) VALUES ($1, 'partner_finance', 'finance.partner_payables', $2,
                   'partner_payable_cancelled_by_purchase_delete', $3, $4::jsonb)`,
        [
          ctx.environment,
          cancelledPayable.rows[0]!.id,
          `partner:${ctx.slug}`,
          JSON.stringify({ source_purchase_id: purchaseId, unit_id: ctx.unitId }),
        ],
      );
    }

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
    const wantedStatus = input.status ?? 'open';
    // SEMPRE insere em 'open'. Se input.status='paid', o pagamento eh feito
    // logo abaixo via _settlePartnerPayableWithClient (caminho unico para
    // criar expense com source_payable_id e rodar dedupe).
    const result = await client.query<{ id: string }>(
      `INSERT INTO finance.partner_payables (
         environment, unit_id, counterparty_name, description, category, amount,
         due_date, status, paid_at, payment_method, notes, created_by, idempotency_key
       ) VALUES ($1, $2, $3, $4, COALESCE($5, 'other'), $6,
                 $7::date, 'open', NULL, $8, $9, $10, $11)
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
        input.payment_method ?? null,
        normalizeText(input.notes),
        `partner:${ctx.slug}`,
        input.idempotency_key ?? null,
      ],
    );

    const payableId = result.rows[0]!.id;

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
          status: 'open',
          requested_paid: wantedStatus === 'paid',
        }),
      ],
    );

    // Se foi pedido criar ja como pago, usa o helper interno (mesma transacao).
    // Helper preenche source_payable_id no expense e roda dedupe.
    if (wantedStatus === 'paid') {
      await _settlePartnerPayableWithClient(client, ctx, payableId, {
        paid_at: input.paid_at ?? null,
        payment_method: input.payment_method ?? null,
        force_duplicate: input.force_duplicate,
      });
    }

    return { payable_id: payableId };
  });
}

// Helper interno: executa o settle dentro de um client/transacao ja aberto.
// Usado tanto pelo endpoint publico settlePartnerPayable quanto pelo
// registerPartnerPayable quando o payable ja vem com status='paid'
// (evita abrir nova transacao - a conta recem-criada poderia nao estar
// visivel ainda em outra connection).
async function _settlePartnerPayableWithClient(
  client: PoolClient,
  ctx: PartnerContext,
  payableId: string,
  input: SettlePartnerPayableInput,
): Promise<{ payable_id: string; paid: boolean }> {
    const paidAt = input.paid_at ?? new Date().toISOString();
    const result = await client.query<{
      id: string;
      description: string;
      category: RegisterPartnerPayableInput['category'];
      amount: string;
      payment_method: string | null;
      source_purchase_id: string | null;
    }>(
      `UPDATE finance.partner_payables
       SET status = 'paid',
           paid_at = $4::timestamptz,
           payment_method = COALESCE($5, payment_method)
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND status = 'open'
         AND deleted_at IS NULL
       RETURNING id, description, category, amount, payment_method, source_purchase_id`,
      [payableId, ctx.environment, ctx.unitId, paidAt, input.payment_method ?? null],
    );

    if (result.rowCount !== 1) return { payable_id: payableId, paid: false };

    const row = result.rows[0]!;
    const idempotencyKey = `payable:${payableId}:expense`;

    // Etapa 3: se o payable veio de uma compra (source_purchase_id preenchido),
    // NAO cria expense. A compra ja foi contabilizada como saida no momento
    // da entrada de estoque - criar expense aqui contaria a saida duas vezes.
    // (Etapa 4 vai reescrever o resumo separando competencia vs caixa de fato.)
    if (row.source_purchase_id) {
      await client.query(
        `INSERT INTO audit.events (
           environment, domain, entity_table, entity_id, event_type,
           actor_label, payload_after
         ) VALUES ($1, 'partner_finance', 'finance.partner_payables', $2,
                   'partner_payable_paid', $3, $4::jsonb)`,
        [
          ctx.environment,
          payableId,
          `partner:${ctx.slug}`,
          JSON.stringify({
            unit_id: ctx.unitId,
            paid_at: paidAt,
            amount: row.amount,
            source_purchase_id: row.source_purchase_id,
            expense_skipped: 'origin_is_purchase',
          }),
        ],
      );
      return { payable_id: payableId, paid: true };
    }

    // Trava de duplicidade (BUG #3): se ja existe despesa com mesma descricao
    // e mesmo valor nos ultimos 7 dias E ela nao foi gerada por este mesmo payable
    // (via FK source_payable_id, introduzida na Etapa 2), bloqueia e pede
    // confirmacao do usuario (force_duplicate=true).
    if (!input.force_duplicate) {
      const dup = await client.query<{
        id: string;
        expense_date: string;
        amount: string;
        description: string;
      }>(
        `SELECT id, expense_date::text, amount::text, description
         FROM finance.partner_expenses
         WHERE environment = $1
           AND unit_id = $2
           AND deleted_at IS NULL
           AND lower(trim(description)) = lower(trim($3))
           AND amount = $4::numeric
           AND expense_date >= (($5::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '7 days')
           AND expense_date <= (($5::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '7 days')
           AND (source_payable_id IS NULL OR source_payable_id <> $6::uuid)
         ORDER BY expense_date DESC, created_at DESC
         LIMIT 5`,
        [ctx.environment, ctx.unitId, row.description, row.amount, paidAt, payableId],
      );
      if (dup.rowCount && dup.rowCount > 0) {
        throw new DuplicateExpenseError(dup.rows);
      }
    }

    await client.query(
      `INSERT INTO finance.partner_expenses (
         environment, unit_id, expense_date, category, description, amount,
         payment_method, created_by, idempotency_key, source_payable_id
       ) VALUES (
         $1, $2, ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
         $4, $5, $6, $7, $8, $9, $10
       )
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key`,
      [
        ctx.environment,
        ctx.unitId,
        paidAt,
        payableCategoryToExpenseCategory(row.category),
        row.description,
        row.amount,
        row.payment_method,
        `partner:${ctx.slug}`,
        idempotencyKey,
        payableId,
      ],
    );

    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type,
         actor_label, payload_after
       ) VALUES ($1, 'partner_finance', 'finance.partner_payables', $2,
                 'partner_payable_paid', $3, $4::jsonb)`,
      [
        ctx.environment,
        payableId,
        `partner:${ctx.slug}`,
        JSON.stringify({ unit_id: ctx.unitId, paid_at: paidAt, amount: row.amount }),
      ],
    );

    return { payable_id: payableId, paid: true };
}

export async function settlePartnerPayable(
  ctx: PartnerContext,
  payableId: string,
  input: SettlePartnerPayableInput,
): Promise<{ payable_id: string; paid: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    return _settlePartnerPayableWithClient(client, ctx, payableId, input);
  });
}

export async function updatePartnerPayable(
  ctx: PartnerContext,
  payableId: string,
  input: UpdatePartnerPayableInput,
): Promise<{ payable_id: string; updated: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE finance.partner_payables
       SET counterparty_name = $4,
           description = $5,
           category = COALESCE($6, 'other'),
           amount = $7,
           due_date = $8::date,
           notes = $9
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND status = 'open'
         AND deleted_at IS NULL
       RETURNING id`,
      [
        payableId,
        ctx.environment,
        ctx.unitId,
        normalizeText(input.counterparty_name),
        input.description,
        input.category ?? 'other',
        input.amount,
        input.due_date ?? null,
        normalizeText(input.notes),
      ],
    );

    if (result.rowCount === 1) {
      await client.query(
        `INSERT INTO audit.events (
           environment, domain, entity_table, entity_id, event_type,
           actor_label, payload_after
         ) VALUES ($1, 'partner_finance', 'finance.partner_payables', $2,
                   'partner_payable_updated', $3, $4::jsonb)`,
        [
          ctx.environment,
          payableId,
          `partner:${ctx.slug}`,
          JSON.stringify({
            unit_id: ctx.unitId,
            counterparty_name: input.counterparty_name,
            description: input.description,
            category: input.category ?? 'other',
            amount: input.amount,
            due_date: input.due_date,
          }),
        ],
      );
    }

    return { payable_id: payableId, updated: result.rowCount === 1 };
  });
}

export async function cancelPartnerPayable(
  ctx: PartnerContext,
  payableId: string,
): Promise<{ payable_id: string; cancelled: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<{ id: string; description: string; amount: string }>(
      `UPDATE finance.partner_payables
       SET status = 'cancelled',
           deleted_at = now(),
           deleted_by = $4
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND status = 'open'
         AND deleted_at IS NULL
       RETURNING id, description, amount`,
      [payableId, ctx.environment, ctx.unitId, `partner:${ctx.slug}`],
    );

    if (result.rowCount === 1) {
      await client.query(
        `INSERT INTO audit.events (
           environment, domain, entity_table, entity_id, event_type,
           actor_label, payload_after
         ) VALUES ($1, 'partner_finance', 'finance.partner_payables', $2,
                   'partner_payable_cancelled', $3, $4::jsonb)`,
        [
          ctx.environment,
          payableId,
          `partner:${ctx.slug}`,
          JSON.stringify({
            unit_id: ctx.unitId,
            description: result.rows[0]!.description,
            amount: result.rows[0]!.amount,
          }),
        ],
      );
    }

    return { payable_id: payableId, cancelled: result.rowCount === 1 };
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
         environment, unit_id, customer_id, customer_name, description, source_tag, amount,
         due_date, status, received_at, payment_method, notes, created_by, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'porta'), $7,
                 $8::date, $9, $10::timestamptz, $11, $12, $13, $14)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id`,
      [
        ctx.environment,
        ctx.unitId,
        input.customer_id ?? null,
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

export async function settlePartnerReceivable(
  ctx: PartnerContext,
  receivableId: string,
  input: SettlePartnerReceivableInput,
): Promise<{ receivable_id: string; received: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const receivedAt = input.received_at ?? new Date().toISOString();
    const result = await client.query<{ id: string; description: string; amount: string }>(
      `UPDATE finance.partner_receivables
       SET status = 'received',
           received_at = $4::timestamptz,
           payment_method = COALESCE($5, payment_method)
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND status = 'open'
         AND deleted_at IS NULL
       RETURNING id, description, amount`,
      [receivableId, ctx.environment, ctx.unitId, receivedAt, input.payment_method ?? null],
    );

    if (result.rowCount !== 1) return { receivable_id: receivableId, received: false };

    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type,
         actor_label, payload_after
       ) VALUES ($1, 'partner_finance', 'finance.partner_receivables', $2,
                 'partner_receivable_received', $3, $4::jsonb)`,
      [
        ctx.environment,
        receivableId,
        `partner:${ctx.slug}`,
        JSON.stringify({
          unit_id: ctx.unitId,
          received_at: receivedAt,
          amount: result.rows[0]!.amount,
        }),
      ],
    );

    return { receivable_id: receivableId, received: true };
  });
}

export async function updatePartnerReceivable(
  ctx: PartnerContext,
  receivableId: string,
  input: UpdatePartnerReceivableInput,
): Promise<{ receivable_id: string; updated: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE finance.partner_receivables
       SET customer_id = $4,
           customer_name = $5,
           description = $6,
           source_tag = COALESCE($7, 'porta'),
           amount = $8,
           due_date = $9::date,
           notes = $10
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND status = 'open'
         AND deleted_at IS NULL
       RETURNING id`,
      [
        receivableId,
        ctx.environment,
        ctx.unitId,
        input.customer_id ?? null,
        normalizeText(input.customer_name),
        input.description,
        input.source_tag ?? 'porta',
        input.amount,
        input.due_date ?? null,
        normalizeText(input.notes),
      ],
    );

    if (result.rowCount === 1) {
      await client.query(
        `INSERT INTO audit.events (
           environment, domain, entity_table, entity_id, event_type,
           actor_label, payload_after
         ) VALUES ($1, 'partner_finance', 'finance.partner_receivables', $2,
                   'partner_receivable_updated', $3, $4::jsonb)`,
        [
          ctx.environment,
          receivableId,
          `partner:${ctx.slug}`,
          JSON.stringify({
            unit_id: ctx.unitId,
            customer_name: input.customer_name,
            description: input.description,
            source_tag: input.source_tag ?? 'porta',
            amount: input.amount,
            due_date: input.due_date,
          }),
        ],
      );
    }

    return { receivable_id: receivableId, updated: result.rowCount === 1 };
  });
}

export async function cancelPartnerReceivable(
  ctx: PartnerContext,
  receivableId: string,
): Promise<{ receivable_id: string; cancelled: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<{ id: string; description: string; amount: string }>(
      `UPDATE finance.partner_receivables
       SET status = 'cancelled',
           deleted_at = now(),
           deleted_by = $4
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND status = 'open'
         AND deleted_at IS NULL
       RETURNING id, description, amount`,
      [receivableId, ctx.environment, ctx.unitId, `partner:${ctx.slug}`],
    );

    if (result.rowCount === 1) {
      await client.query(
        `INSERT INTO audit.events (
           environment, domain, entity_table, entity_id, event_type,
           actor_label, payload_after
         ) VALUES ($1, 'partner_finance', 'finance.partner_receivables', $2,
                   'partner_receivable_cancelled', $3, $4::jsonb)`,
        [
          ctx.environment,
          receivableId,
          `partner:${ctx.slug}`,
          JSON.stringify({
            unit_id: ctx.unitId,
            description: result.rows[0]!.description,
            amount: result.rows[0]!.amount,
          }),
        ],
      );
    }

    return { receivable_id: receivableId, cancelled: result.rowCount === 1 };
  });
}

// ============================================================
// Chat unificado (Fatia 1.3) — LEITURA das conversas/mensagens
// espelhadas pelo fan-out (commerce.partner_*). Só lê; o envio é
// Fatia 2. RLS isola por unidade; o WHERE unit_id é defesa extra.
// ============================================================

export async function getPartnerChatConversations(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT c.id, c.chatwoot_conversation_id, c.channel,
              c.customer_name, c.customer_identifier, c.customer_avatar_url,
              c.customer_location, c.initial_intent,
              c.status, c.last_message_at, c.unread_count, c.created_at, c.updated_at,
              (SELECT m.content
                 FROM commerce.partner_messages m
                WHERE m.conversation_id = c.id AND m.environment = c.environment
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1) AS last_message
       FROM commerce.partner_conversations c
       WHERE c.environment = $1 AND c.unit_id = $2
       ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
       LIMIT 100`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export async function getPartnerChatMessages(
  ctx: PartnerContext,
  conversationId: string,
): Promise<unknown[] | null> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    // Confirma que a conversa existe e pertence à unidade (RLS + WHERE).
    // null distingue "conversa inexistente/de outro parceiro" (404) de
    // "conversa sem mensagens" ([]), pra a rota responder certo.
    const conv = await client.query(
      `SELECT 1 FROM commerce.partner_conversations
       WHERE id = $1 AND environment = $2 AND unit_id = $3`,
      [conversationId, ctx.environment, ctx.unitId],
    );
    if (conv.rowCount !== 1) return null;

    const result = await client.query(
      `SELECT id, chatwoot_message_id, direction, sender, content, attachments, created_at
       FROM commerce.partner_messages
       WHERE environment = $1 AND unit_id = $2 AND conversation_id = $3
       ORDER BY created_at ASC, id ASC
       LIMIT 500`,
      [ctx.environment, ctx.unitId, conversationId],
    );
    return result.rows;
  });
}

// ============================================================
// Chat unificado (Fatia 2) — ENVIO. O parceiro responde o cliente
// pelo portal: grava a msg otimista no banco (pool do parceiro, RLS
// via WITH CHECK garante a unidade), manda pro Chatwoot com
// echo_id = client_token, e o eco do webhook casa essa msg e preenche
// o chatwoot_message_id (fan-out). Sem duplicar na tela.
// ============================================================

export type SendPartnerChatStatus = 'ok' | 'not_found' | 'send_failed';

export interface SendPartnerChatResult {
  status: SendPartnerChatStatus;
  message?: Record<string, unknown>;
}

export async function sendPartnerChatMessage(
  ctx: PartnerContext,
  conversationId: string,
  content: string,
  clientToken: string,
): Promise<SendPartnerChatResult> {
  // 1) Acha a conversa (RLS) e insere a mensagem otimista. O portal só tem
  //    SELECT/INSERT em partner_messages; o chatwoot_message_id fica NULL até
  //    o eco. last_message_at/unread não mexem aqui (sem grant de UPDATE na
  //    conversa) — o eco do fan-out cuida disso quando a msg volta.
  const inserted = await withPartnerContext(ctx.partnerUnitId, async (client) => {
    const conv = await client.query(
      `SELECT chatwoot_conversation_id FROM commerce.partner_conversations
        WHERE id = $1 AND environment = $2 AND unit_id = $3`,
      [conversationId, ctx.environment, ctx.unitId],
    );
    if (conv.rowCount !== 1) return null;

    const msg = await client.query(
      `INSERT INTO commerce.partner_messages
         (environment, unit_id, conversation_id, chatwoot_message_id, direction, sender, content, client_token)
       VALUES ($1, $2, $3, NULL, 'outbound', 'partner', $4, $5)
       RETURNING id, chatwoot_message_id, direction, sender, content, attachments, created_at`,
      [ctx.environment, ctx.unitId, conversationId, content, clientToken],
    );
    return {
      chatwootConversationId: Number(conv.rows[0]!.chatwoot_conversation_id),
      message: msg.rows[0] as Record<string, unknown>,
    };
  });

  if (!inserted) return { status: 'not_found' };

  // 2) Manda pro Chatwoot com echo_id = client_token (o eco preenche o id).
  try {
    const api = new ChatwootApiClient();
    await api.sendMessage(inserted.chatwootConversationId, content, clientToken);
  } catch (err) {
    // 3) Falhou o envio: remove a msg otimista pra não ficar fantasma na tela.
    //    Partner não tem DELETE; usa o pool do bot (bypassa RLS) com unit_id
    //    explícito pra segurança.
    await pool
      .query(
        `DELETE FROM commerce.partner_messages
          WHERE id = $1 AND environment = $2 AND unit_id = $3`,
        [(inserted.message as { id: string }).id, ctx.environment, ctx.unitId],
      )
      .catch((cleanupErr) =>
        logger.error({ err: cleanupErr, conversationId }, 'falha ao limpar msg otimista'),
      );
    logger.error({ err, conversationId }, 'partner chat send failed');
    return { status: 'send_failed' };
  }

  return { status: 'ok', message: inserted.message };
}

// ============================================================
// Chat unificado (Fatia 2) — MARCAR COMO LIDO. Zera unread_count
// quando o parceiro abre a conversa. O portal só tem SELECT na
// conversa (sem UPDATE), então o reset vai pelo pool do bot com
// unit_id/environment explícitos (mesmo padrão da limpeza de envio).
// ============================================================

export async function markPartnerChatRead(
  ctx: PartnerContext,
  conversationId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE commerce.partner_conversations
        SET unread_count = 0
      WHERE id = $1 AND environment = $2 AND unit_id = $3 AND unread_count <> 0`,
    [conversationId, ctx.environment, ctx.unitId],
  );
  // rowCount 0 = conversa inexistente/de outra unidade OU já estava zerada.
  // Confirmamos existência separado pra distinguir 404 de "já lido".
  if ((result.rowCount ?? 0) > 0) return true;
  const exists = await pool.query(
    `SELECT 1 FROM commerce.partner_conversations
      WHERE id = $1 AND environment = $2 AND unit_id = $3`,
    [conversationId, ctx.environment, ctx.unitId],
  );
  return (exists.rowCount ?? 0) > 0;
}
