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

import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withPartnerContext } from './db.js';
import { hashPassword, verifyPassword, fakeVerify, newSessionToken, hashSessionToken } from './password.js';
import { pool } from '../persistence/db.js';
import { logger } from '../shared/logger.js';
import { ChatwootApiClient } from '../admin/chatwoot-api.client.js';
import { normalizeBrazilianPhone } from '../shared/phone.js';
import { resolvePartnerPermissions, PARTNER_SCREENS, type PartnerContext, type PartnerPermissions } from './auth.js';
import { lineCommission, type PartnerCommissionConfig } from './commission.js';
export type { PartnerCommissionConfig } from './commission.js';

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

// Parcelamento desligado: o negocio nao vende parcelado (recebimento a vista
// ou na entrega/COD em parcela unica). Recusado no servidor como defesa em
// profundidade — o front tambem envia sempre receivable_installments=1.
export class InstallmentsNotAllowedError extends Error {
  readonly code = 'installments_not_supported';
  constructor() {
    super('installments_not_supported: venda parcelada nao e suportada (recebimento a vista ou na entrega)');
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

// 0076: ajuste/edição de estoque que deixaria quantity_on_hand abaixo do reservado
// (viola o CHECK partner_stock_levels_reserved_check). Vira 409/422 amigável na route.
export class StockBelowReservedError extends Error {
  readonly code = 'saldo_below_reserved';
  constructor() {
    super('saldo_below_reserved');
  }
}

// 0076: tentativa de inativar item de estoque que tem reserva aberta (entrega em curso).
export class StockReservedCannotDeleteError extends Error {
  readonly code = 'stock_reserved_cannot_delete';
  readonly stock_id: string;
  constructor(stockId: string) {
    super('stock_reserved_cannot_delete');
    this.stock_id = stockId;
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
    const base = result.rows[0];
    if (!base) return null;

    // Pesquisa de satisfação (0105, Tijolo 4): média + nº de notas da PRÓPRIA loja
    // (RLS isola por unidade). Vazio quando a flag está off / sem respostas — o card
    // no Resumo só aparece com satisfaction_count > 0. FAIL-SAFE: erro aqui NUNCA
    // derruba o Resumo do dono — degrada sem o card.
    let satisfaction_avg: number | null = null;
    let satisfaction_count = 0;
    try {
      const sat = await client.query<{ avg: string | null; n: string }>(
        `SELECT round(avg(rating)::numeric, 1) AS avg, count(id) AS n
           FROM commerce.satisfaction_surveys
          WHERE environment = $1 AND unit_id = $2 AND status = 'answered'`,
        [ctx.environment, ctx.unitId],
      );
      satisfaction_avg = sat.rows[0]?.avg != null ? Number(sat.rows[0].avg) : null;
      satisfaction_count = Number(sat.rows[0]?.n ?? 0);
    } catch (err) {
      logger.warn({ err, unit_id: ctx.unitId }, 'resumo: resumo de satisfacao indisponivel (degrada sem o card)');
    }

    return { ...base, satisfaction_avg, satisfaction_count };
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

/**
 * Opções das listas de histórico/financeiro (0108+). `includeArchived` = mostra
 * também os "tirados da tela" (arquivar). NUNCA usar isto em totais/caixa/comissão
 * nem no Relatório — o filtro de arquivados é SÓ de exibição de lista.
 */
export interface PartnerListOpts {
  includeArchived?: boolean;
}

// Tipos que o borracheiro pode "tirar da tela" (0108). Allowlist fixa — fora daqui
// o endpoint recusa (400). 🔒 REGRA DE OURO: só entram tipos cujos TOTAIS vêm do
// BACKEND (resumo) — arquivar NUNCA pode sumir dinheiro do total. 'payable'/
// 'receivable' ficam de FORA por enquanto: os totais "em aberto/pago" deles são
// somados da LISTA no front (app.financeiro.kpis.js), então arquivá-los baixaria
// o total. Entram quando esses KPIs forem pro backend (fase Relatórios/agregados).
const DISMISSIBLE_TYPES = ['order', 'expense', 'purchase'] as const;
export type DismissibleType = (typeof DISMISSIBLE_TYPES)[number];
export function isDismissibleType(t: string): t is DismissibleType {
  return (DISMISSIBLE_TYPES as readonly string[]).includes(t);
}

/**
 * Arquivar = tirar da tela SEM apagar do banco (0108). Via withPartnerContext: a
 * RLS (WITH CHECK unit_id = current_partner_core_unit()) garante que só dá pra
 * arquivar item da PRÓPRIA loja. Idempotente (ON CONFLICT). NÃO valida se o id
 * existe: arquivar um id que não é seu cria, no máximo, uma linha que nunca casa
 * com nada que você vê — inofensivo, e a RLS impede arquivar pra outra unidade.
 */
export async function archivePartnerItem(ctx: PartnerContext, itemType: DismissibleType, itemId: string): Promise<void> {
  await withPartnerContext(ctx.partnerUnitId, async (client) => {
    await client.query(
      `INSERT INTO commerce.partner_dismissed_items
         (environment, unit_id, item_type, item_id, dismissed_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (environment, unit_id, item_type, item_id) DO NOTHING`,
      [ctx.environment, ctx.unitId, itemType, itemId, `${ctx.role}:${ctx.tokenId}`],
    );
  });
}

/** Desarquivar = devolve o item pra tela (remove a linha). RLS escopa por unidade. */
export async function unarchivePartnerItem(ctx: PartnerContext, itemType: DismissibleType, itemId: string): Promise<void> {
  await withPartnerContext(ctx.partnerUnitId, async (client) => {
    await client.query(
      `DELETE FROM commerce.partner_dismissed_items
        WHERE environment = $1 AND unit_id = $2 AND item_type = $3 AND item_id = $4`,
      [ctx.environment, ctx.unitId, itemType, itemId],
    );
  });
}

export async function getPartnerVendas(ctx: PartnerContext, opts: PartnerListOpts = {}): Promise<unknown[]> {
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
              awaiting_pickup, retrieved_at,
              total_amount, received_amount, notes, items
       FROM commerce.partner_orders_full
       WHERE environment = $1 AND unit_id = $2
         AND ($3 OR NOT EXISTS (
           SELECT 1 FROM commerce.partner_dismissed_items d
            WHERE d.environment = $1 AND d.unit_id = $2
              AND d.item_type = 'order' AND d.item_id = order_id::text))
       ORDER BY created_at DESC
       LIMIT 500`,
      [ctx.environment, ctx.unitId, opts.includeArchived === true],
    );

    // FOTO SOB DEMANDA (0094): pedido que nasceu de uma foto aprovada ganha o
    // id da foto — o card "Em separação" mostra o thumb (o separador pega o
    // pneu CERTO). Uma query só (mapa order→foto), SEM tocar os bytes; a RLS
    // de photo_requests já isola por unidade. Pedido sem foto = campo ausente.
    const photos = await client.query<{ order_id: string; photo_request_id: string }>(
      `SELECT poi.order_id, pr.id AS photo_request_id
         FROM commerce.photo_requests pr
         JOIN commerce.partner_order_items poi ON poi.id = pr.order_item_id
        WHERE pr.environment = $1 AND pr.order_item_id IS NOT NULL`,
      [ctx.environment],
    );
    if (photos.rowCount === 0) return result.rows;
    const photoByOrder = new Map(photos.rows.map((p) => [p.order_id, p.photo_request_id]));
    return result.rows.map((row) => {
      const orderId = (row as { order_id?: string }).order_id;
      const photoRequestId = orderId ? photoByOrder.get(orderId) : undefined;
      return photoRequestId ? { ...row, photo_request_id: photoRequestId } : row;
    });
  });
}

/**
 * Relatório de VENDAS (0108): histórico de pedidos por período + status. SEMPRE
 * mostra TUDO — inclusive os arquivados (flag `arquivado` pra o front oferecer
 * "desarquivar"). NÃO filtra dismissed (o relatório é o backstop "puxar tudo").
 * Owner-only no endpoint. RLS isola por unidade.
 */
export interface RelatorioVendasOpts { from?: string | null; to?: string | null; status?: string | null; }
export async function getPartnerRelatorioVendas(ctx: PartnerContext, opts: RelatorioVendasOpts = {}): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const res = await client.query(
      `SELECT pof.order_id, pof.created_at, pof.contact_name AS customer_name,
              pof.fulfillment_mode, pof.status, pof.delivery_status, pof.awaiting_pickup,
              pof.total_amount, pof.source_tag,
              EXISTS (SELECT 1 FROM commerce.partner_dismissed_items d
                       WHERE d.environment = $1 AND d.unit_id = $2
                         AND d.item_type = 'order' AND d.item_id = pof.order_id::text) AS arquivado
         FROM commerce.partner_orders_full pof
        WHERE pof.environment = $1 AND pof.unit_id = $2
          AND ($3::timestamptz IS NULL OR pof.created_at >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR pof.created_at <  $4::timestamptz)
          AND ($5::text IS NULL
               OR ($5 = 'cancelados' AND pof.status = 'cancelled')
               OR ($5 = 'ativos'     AND pof.status <> 'cancelled'))
        ORDER BY pof.created_at DESC
        LIMIT 1000`,
      [ctx.environment, ctx.unitId, opts.from ?? null, opts.to ?? null, opts.status ?? null],
    );
    return res.rows;
  });
}

/**
 * Fila da tela RETIRADAS: só os pedidos de retirada (pickup) RESERVADOS aguardando
 * o cliente vir buscar — a fila de ação do balcão. Deriva de getPartnerVendas e
 * filtra no servidor pra que a tela Retiradas tenha um feed PRÓPRIO (guard
 * requireScreen('retiradas')): o balconista vê só a fila de retirada, sem precisar
 * da permissão 'vendas' (que escancararia o histórico inteiro). Mesma forma de
 * linha das vendas — o front reusa os mesmos campos.
 */
export async function getPartnerRetiradas(ctx: PartnerContext): Promise<unknown[]> {
  const all = await getPartnerVendas(ctx);
  return all.filter((row) => {
    const o = row as { fulfillment_mode?: string; awaiting_pickup?: boolean; status?: string };
    return o.fulfillment_mode === 'pickup' && o.awaiting_pickup === true && o.status !== 'cancelled';
  });
}

export async function getPartnerEstoque(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT ps.id, ps.product_id, ps.local_sku, ps.item_name, ps.item_type, ps.tire_size,
              ps.tire_width_mm, ps.tire_aspect_ratio, ps.tire_rim_diameter,
              ps.brand, ps.supplier_name, ps.tire_condition, ps.shelf_location, ps.tire_position,
              ps.quantity_on_hand, ps.quantity_reserved, ps.minimum_quantity, ps.average_cost, ps.sale_price,
              ps.is_tracked, ps.stock_status, ps.created_at, ps.updated_at,
              -- P1: nome do produto do catálogo central VINCULADO (NULL = item "livre",
              -- que o bot não consegue rotear). LEFT JOIN: vínculo é opcional.
              cp.product_name AS catalog_product_name
       FROM commerce.partner_stock_levels ps
       LEFT JOIN commerce.products cp ON cp.id = ps.product_id AND cp.environment = ps.environment
       WHERE ps.environment = $1 AND ps.unit_id = $2 AND ps.deleted_at IS NULL
       ORDER BY ps.stock_status DESC, ps.item_name ASC
       LIMIT 300`,
      [ctx.environment, ctx.unitId],
    );
    return result.rows;
  });
}

export interface CatalogSearchRow {
  id: string;
  product_code: string | null;
  product_name: string;
  brand: string | null;
  product_type: string | null;
}

/**
 * P1 (Fundação Bot→Rede): busca read-only no CATÁLOGO CENTRAL pro parceiro VINCULAR
 * um item de estoque a um produto do catálogo (preenche `partner_stock_levels.product_id`).
 * É o ponteiro que o bot usa pra casar cotação↔estoque do parceiro e rotear a venda (2w).
 *
 * NÃO reabre o catálogo pra VENDA: a venda do parceiro continua silo (aponta pra
 * `partner_stock_levels.id` — decisão "silo isolado" 2026-05-19). Aqui é só LEITURA, e
 * só pro cadastro de estoque. O role `farejador_partner_app` já tem SELECT em
 * `commerce.products` (sem RLS); a view `product_full` fica fora (sem grant) — por isso
 * a busca é direta na tabela base. A medida costuma vir embutida no `product_name`.
 */
export async function searchPartnerCatalog(ctx: PartnerContext, termo: string): Promise<CatalogSearchRow[]> {
  const q = termo.trim();
  if (q.length < 2) return [];
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query<CatalogSearchRow>(
      `SELECT id, product_code, product_name, brand, product_type
       FROM commerce.products
       WHERE environment = $1 AND deleted_at IS NULL
         AND (product_name ILIKE $2 OR product_code ILIKE $2 OR brand ILIKE $2)
       ORDER BY product_name ASC
       LIMIT 20`,
      [ctx.environment, `%${q}%`],
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
              brand, sale_price, average_cost, quantity_on_hand, quantity_reserved,
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

export async function getPartnerDespesas(ctx: PartnerContext, opts: PartnerListOpts = {}): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT id, expense_date, category, description, amount, payment_method, created_at
       FROM finance.partner_expenses
       WHERE environment = $1 AND unit_id = $2 AND deleted_at IS NULL
         AND ($3 OR NOT EXISTS (
           SELECT 1 FROM commerce.partner_dismissed_items d
            WHERE d.environment = $1 AND d.unit_id = $2
              AND d.item_type = 'expense' AND d.item_id = id::text))
       ORDER BY expense_date DESC, created_at DESC
       LIMIT 100`,
      [ctx.environment, ctx.unitId, opts.includeArchived === true],
    );
    return result.rows;
  });
}

export async function getPartnerCompras(ctx: PartnerContext, opts: PartnerListOpts = {}): Promise<unknown[]> {
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
         AND ($3 OR NOT EXISTS (
           SELECT 1 FROM commerce.partner_dismissed_items d
            WHERE d.environment = $1 AND d.unit_id = $2
              AND d.item_type = 'purchase' AND d.item_id = pp.id::text))
       GROUP BY pp.id
       ORDER BY pp.purchased_at DESC, pp.created_at DESC
       LIMIT 100`,
      [ctx.environment, ctx.unitId, opts.includeArchived === true],
    );
    return result.rows;
  });
}

export async function getPartnerPayables(ctx: PartnerContext, opts: PartnerListOpts = {}): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const result = await client.query(
      `SELECT id, counterparty_name, description, category, amount, due_date,
              status, paid_at, payment_method, notes, created_at, source_purchase_id
       FROM finance.partner_payables
       WHERE environment = $1 AND unit_id = $2 AND deleted_at IS NULL
         AND ($3 OR NOT EXISTS (
           SELECT 1 FROM commerce.partner_dismissed_items d
            WHERE d.environment = $1 AND d.unit_id = $2
              AND d.item_type = 'payable' AND d.item_id = id::text))
       ORDER BY
         CASE status WHEN 'open' THEN 1 WHEN 'paid' THEN 2 ELSE 3 END,
         due_date ASC NULLS LAST,
         created_at DESC
       LIMIT 100`,
      [ctx.environment, ctx.unitId, opts.includeArchived === true],
    );
    return result.rows;
  });
}

export async function getPartnerReceivables(ctx: PartnerContext, opts: PartnerListOpts = {}): Promise<unknown[]> {
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
         AND ($3 OR NOT EXISTS (
           SELECT 1 FROM commerce.partner_dismissed_items d
            WHERE d.environment = $1 AND d.unit_id = $2
              AND d.item_type = 'receivable' AND d.item_id = pr.id::text))
       GROUP BY pr.id
       ORDER BY
         CASE pr.status WHEN 'open' THEN 1 WHEN 'received' THEN 2 ELSE 3 END,
         pr.due_date ASC NULLS LAST,
         pr.created_at DESC
       LIMIT 100`,
      [ctx.environment, ctx.unitId, opts.includeArchived === true],
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
  // Parcelamento desligado: o negocio nao vende parcelado. Recusa antes de
  // qualquer escrita. O front ja envia sempre 1; este guard e defesa em profundidade.
  if (Number(input.receivable_installments ?? 1) > 1) {
    throw new InstallmentsNotAllowedError();
  }
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

      // Carimba o OPERADOR (quem finalizou a venda no balcão) = base da comissão por
      // pessoa (Bloco 2, migration 0099). ctx.tokenId é o login = vínculo pessoa↔loja.
      // Só quando ainda está NULL: re-submit idempotente (mesma idempotency_key) devolve
      // o pedido existente e NÃO reescreve o finalizador original. Mesma transação da
      // venda (withPartnerContext = BEGIN/COMMIT) → carimbo e venda commitam juntos.
      await client.query(
        `UPDATE commerce.partner_orders
            SET operator_token_id = $4
          WHERE id = $1 AND environment = $2 AND unit_id = $3
            AND operator_token_id IS NULL`,
        [orderId, ctx.environment, ctx.unitId, ctx.tokenId],
      );

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

      // Conta a receber (fiado) só pra venda que NÃO é entrega. A entrega (COD) é paga
      // quando o cliente recebe — não é dívida; o caixa entra no "marcar entregue".
      // Sem este recorte, todo pedido de entrega inflava o "a receber". (Wallace 06-08)
      if (input.payment_status === 'receivable' && input.fulfillment_mode !== 'delivery') {
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
  reason?: string | null,
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

    // Motivo do cancelamento (free-text do parceiro). Fica gravado no audit e alimenta
    // o antifraude da matriz (2w cancelado + venda porta do mesmo cliente).
    const motivo = (reason ?? '').trim().slice(0, 500) || 'cancelado pelo portal parceiro';
    await client.query('SELECT commerce.cancel_partner_local_order($1, $2, $3)', [
      orderId,
      `partner:${ctx.slug}`,
      motivo,
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
  // Motivo (free-text) do "não entregue" (failed). Vai pro cancel + audit.
  reason?: string | null;
}

export class DeliveryAlreadyFinalizedError extends Error {
  readonly code = 'delivery_already_finalized';
  constructor() {
    super('delivery_already_finalized');
  }
}

export class PickupAlreadyRetrievedError extends Error {
  readonly code = 'pickup_already_retrieved';
  constructor() {
    super('pickup_already_retrieved');
  }
}

export interface MarkPickupRetrievedInput {
  // Forma de pagamento recebida no balcão na hora da retirada (pix/dinheiro/cartao).
  payment_method?: string | null;
}

// Marca uma RETIRADA RESERVADA como retirada (cliente veio e pagou no balcão):
//  - converte a RESERVA em baixa física (complete_partner_pickup);
//  - marca o pedido como pago + carimba retrieved_at (vira venda realizada NA RETIRADA);
//  - lança o caixa: conta a receber já 'received' (espelha o COD entregue), source 2w.
// Só age em pickup com awaiting_pickup=true e não cancelado. Idempotente (re-clique seguro).
export async function markPartnerPickupRetrieved(
  ctx: PartnerContext,
  orderId: string,
  input: MarkPickupRetrievedInput,
): Promise<{ order_id: string; retrieved: boolean }> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const existing = await client.query<{
      awaiting_pickup: boolean; status: string; total_amount: string;
      customer_id: string | null; customer_name: string | null;
    }>(
      `SELECT awaiting_pickup, status, total_amount, customer_id, customer_name
       FROM commerce.partner_orders
       WHERE id = $1 AND environment = $2 AND unit_id = $3
         AND fulfillment_mode = 'pickup' AND deleted_at IS NULL
       LIMIT 1`,
      [orderId, ctx.environment, ctx.unitId],
    );
    if (existing.rowCount !== 1) throw new Error('pickup_not_found');
    const row = existing.rows[0]!;
    if (row.status === 'cancelled') throw new Error('pickup_not_found');
    if (!row.awaiting_pickup) throw new PickupAlreadyRetrievedError();

    // 1) reserva → baixa física (a função SQL levanta erro se não estiver aguardando).
    await client.query('SELECT commerce.complete_partner_pickup($1, $2)', [
      orderId,
      `partner:${ctx.slug}`,
    ]);

    // 2) marca retirado: pago + data de realização da venda (retrieved_at) + carimba o
    //    OPERADOR que finalizou = base da comissão por pessoa (0099). Pedido do bot nasce
    //    com operator_token_id NULL; quem dá baixa na retirada é "quem finaliza" → leva.
    //    COALESCE trava o 1º finalizador (não reescreve num eventual reprocesso).
    await client.query(
      `UPDATE commerce.partner_orders
       SET awaiting_pickup = false, retrieved_at = now(), status = 'paid', updated_at = now(),
           operator_token_id = COALESCE(operator_token_id, $4)
       WHERE id = $1 AND environment = $2 AND unit_id = $3`,
      [orderId, ctx.environment, ctx.unitId, ctx.tokenId],
    );

    // 3) caixa: cliente pagou no balcão → conta a receber já recebida (source 2w).
    await client.query(
      `INSERT INTO finance.partner_receivables (
         environment, unit_id, customer_id, customer_name, description, source_tag, amount,
         due_date, status, received_at, payment_method, notes, created_by, idempotency_key, source_order_id
       ) VALUES ($1, $2, $3, $4, $5, '2w', $6, NULL, 'received', now(), $7, $8, $9, $10, $11)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [
        ctx.environment,
        ctx.unitId,
        row.customer_id,
        row.customer_name,
        `Retirada ${orderId.slice(0, 8)}`,
        row.total_amount,
        normalizeText(input.payment_method),
        `Retirada paga no balcão — pedido ${orderId.slice(0, 8)}`,
        `partner:${ctx.slug}`,
        `order:${orderId}:pickup-receivable`,
        orderId,
      ],
    );

    await client.query(
      `INSERT INTO audit.events (
         environment, domain, entity_table, entity_id, event_type, actor_label, payload_after
       ) VALUES ($1, 'partner_orders', 'commerce.partner_orders', $2,
                 'partner_pickup_retrieved', $3, $4::jsonb)`,
      [
        ctx.environment,
        orderId,
        `partner:${ctx.slug}`,
        JSON.stringify({ unit_id: ctx.unitId, payment_method: normalizeText(input.payment_method) }),
      ],
    );

    return { order_id: orderId, retrieved: true };
  });
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

    const existing = await client.query<{
      status: string; delivery_status: string;
      total_amount: string; customer_id: string | null; customer_name: string | null;
    }>(
      `SELECT status, delivery_status, total_amount, customer_id, customer_name
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
        const motivoFalha = (input.reason ?? '').trim().slice(0, 500) || 'entrega nao realizada (nao entregue/devolvido)';
        await client.query('SELECT commerce.cancel_partner_local_order($1, $2, $3)', [
          orderId,
          `partner:${ctx.slug}`,
          motivoFalha,
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
    // P2/Codex#3: na TRANSIÇÃO para delivered, converte a reserva em baixa física
    // ANTES de marcar o pedido como delivered. A função SQL levanta erro se o pedido
    // já estiver delivered, então a ordem importa: deliver primeiro, UPDATE depois.
    // O guard !== 'delivered' evita que duplo-clique inocente vire erro.
    if (input.delivery_status === 'delivered' && existing.rows[0]!.delivery_status !== 'delivered') {
      await client.query('SELECT commerce.deliver_partner_local_order($1, $2)', [
        orderId,
        `partner:${ctx.slug}`,
      ]);
    }

    const result = await client.query<{ id: string; delivery_status: string }>(
      `UPDATE commerce.partner_orders
       SET delivery_status = $4,
           status = CASE WHEN $4 = 'delivered' THEN 'paid' ELSE status END,
           -- Carimba o OPERADOR só ao FINALIZAR (delivered) = base da comissão (0099).
           -- "Quem finaliza ganha": é quem marca entregue, não o entregador (courier).
           -- COALESCE trava o 1º finalizador; só escreve em delivered (estado terminal).
           operator_token_id = CASE WHEN $4 = 'delivered'
             THEN COALESCE(operator_token_id, $6) ELSE operator_token_id END,
           delivery_courier = COALESCE($5, delivery_courier),
           dispatched_at = CASE
             WHEN $4 IN ('dispatched', 'delivered') AND dispatched_at IS NULL THEN now()
             WHEN $4 = 'pending' THEN NULL
             ELSE dispatched_at
           END,
           delivered_at = CASE
             WHEN $4 = 'delivered' AND delivered_at IS NULL THEN now()
             WHEN $4 = 'delivered' THEN delivered_at
             ELSE NULL
           END,
           updated_at = now()
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND fulfillment_mode = 'delivery'
         AND deleted_at IS NULL
       RETURNING id, delivery_status`,
      [orderId, ctx.environment, ctx.unitId, input.delivery_status, courier, ctx.tokenId],
    );

    if (result.rowCount !== 1) throw new Error('delivery_not_found');

    // Finalizada: AQUI o dinheiro entra no caixa — cria a conta a receber já 'received'
    // (não existe mais 'open' no nascimento; espelha o "marcar retirado" da retirada).
    // ON CONFLICT cobre o pedido LEGADO que ainda tinha 'open' (flipa pra received, sem
    // duplicar) — mesma idempotency_key da venda.
    if (input.delivery_status === 'delivered') {
      const od = existing.rows[0]!;
      await client.query(
        `INSERT INTO finance.partner_receivables (
           environment, unit_id, customer_id, customer_name, description, source_tag, amount,
           due_date, status, received_at, payment_method, notes, created_by, idempotency_key, source_order_id
         ) VALUES ($1, $2, $3, $4, $5, '2w', $6, NULL, 'received', now(), $7, $8, $9, $10, $11)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
         DO UPDATE SET status = 'received', received_at = now(),
                       payment_method = COALESCE(EXCLUDED.payment_method, finance.partner_receivables.payment_method)`,
        [
          ctx.environment, ctx.unitId, od.customer_id, od.customer_name,
          `Entrega ${orderId.slice(0, 8)}`, od.total_amount,
          normalizeText(input.payment_method),
          `Entrega paga no recebimento — pedido ${orderId.slice(0, 8)}`,
          `partner:${ctx.slug}`, `order:${orderId}:receivable`, orderId,
        ],
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

export async function upsertPartnerCustomerWithClient(
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
    let result;
    try {
      result = await client.query<{ id: string }>(
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
    } catch (err) {
      // P3/A3: o upsert grava quantity_on_hand. Se um "Ajustar saldo" tentar deixar
      // on_hand < quantity_reserved, o CHECK partner_stock_levels_reserved_check dispara
      // aqui (transação faz rollback). Devolve erro sinalizável (saldo_below_reserved).
      if ((err as { code?: string })?.code === '23514') {
        throw new StockBelowReservedError();
      }
      throw err;
    }

    const stockId = result.rows[0]!.id;

    // P3: stock_status é dono do banco. O upsert acima gravou um status calculado pelo
    // helper TS que NÃO conhece o quantity_reserved real da linha. Recalcula agora pelo
    // helper SQL com o reserved atual — fonte única de status (item reservado mantém
    // 'reserved' mesmo ao editar preço/custo).
    await client.query(
      `UPDATE commerce.partner_stock_levels
       SET stock_status = commerce.partner_stock_status(
             quantity_on_hand, quantity_reserved, minimum_quantity, is_tracked)
       WHERE id = $1 AND environment = $2 AND unit_id = $3`,
      [stockId, ctx.environment, ctx.unitId],
    );

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
    const stock = await client.query<{
      id: string;
      item_name: string;
      quantity_on_hand: number | null;
      quantity_reserved: number | null;
    }>(
      `SELECT id, item_name, quantity_on_hand, quantity_reserved
       FROM commerce.partner_stock_levels
       WHERE id = $1
         AND environment = $2
         AND unit_id = $3
         AND deleted_at IS NULL
       FOR UPDATE`,
      [stockId, ctx.environment, ctx.unitId],
    );

    if (stock.rowCount !== 1) {
      return { stock_id: stockId, deleted: false };
    }

    if (Number(stock.rows[0]!.quantity_reserved ?? 0) > 0) {
      throw new StockReservedCannotDeleteError(stockId);
    }

    const result = await client.query<{ id: string }>(
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
            item_name: stock.rows[0]!.item_name,
            last_quantity: stock.rows[0]!.quantity_on_hand,
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
               stock_status = commerce.partner_stock_status(
                 COALESCE(quantity_on_hand, 0) + $4,
                 quantity_reserved,
                 minimum_quantity,
                 true
               ),
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
             commerce.partner_stock_status($11, 0, NULL, true),
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
             -- A5: estorno de compra recalcula status pelo helper. Se o disponível
             -- voltar a <= 0 com reserva aberta, o item volta corretamente a 'reserved'.
             stock_status = commerce.partner_stock_status(
               ps.quantity_on_hand - $5, ps.quantity_reserved, ps.minimum_quantity, ps.is_tracked),
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

// Fase 2a do chat: liga a conversa ao cliente cadastrado (por telefone) e
// devolve metricas reais de compra. Retorna null se a conversa nao existe/
// nao e da unidade (404). Sem match -> { linked:false, suggestion } pra o
// front oferecer "cadastrar". Read-only; nao cria nada.
export async function getPartnerChatCustomer(
  ctx: PartnerContext,
  conversationId: string,
): Promise<unknown | null> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const conv = await client.query<{ customer_name: string | null; customer_identifier: string | null; customer_id: string | null }>(
      `SELECT customer_name, customer_identifier, customer_id
         FROM commerce.partner_conversations
        WHERE id = $1 AND environment = $2 AND unit_id = $3`,
      [conversationId, ctx.environment, ctx.unitId],
    );
    const convRow = conv.rows[0];
    if (!convRow) return null;

    // Monta o payload "vinculado" (cliente + métricas + últimas compras).
    // Só conta COMPRA REALIZADA: descarta cancelada e descarta entrega COD
    // ainda não finalizada (a venda só se realiza na entrega — regra do 0069).
    // Pickup (delivery_status NULL) e entrega 'delivered' contam; o resto não.
    const REALIZED_SALE = `status <> 'cancelled'
        AND NOT (fulfillment_mode = 'delivery' AND delivery_status IS DISTINCT FROM 'delivered')
        AND NOT awaiting_pickup`;
    const buildLinked = async (customer: { id: string }): Promise<unknown> => {
      const agg = await client.query(
        `SELECT COUNT(*)::int AS purchase_count,
                COALESCE(SUM(total_amount), 0)::float AS total_spent,
                COALESCE(AVG(total_amount), 0)::float AS avg_ticket
           FROM commerce.partner_orders_full
          WHERE environment = $1 AND unit_id = $2 AND customer_id = $3
            AND ${REALIZED_SALE}`,
        [ctx.environment, ctx.unitId, customer.id],
      );
      const last = await client.query(
        `SELECT order_id, created_at, total_amount, status, delivery_status, items
           FROM commerce.partner_orders_full
          WHERE environment = $1 AND unit_id = $2 AND customer_id = $3
            AND ${REALIZED_SALE}
          ORDER BY created_at DESC
          LIMIT 5`,
        [ctx.environment, ctx.unitId, customer.id],
      );
      return { linked: true, customer, metrics: agg.rows[0], last_orders: last.rows };
    };

    const CUSTOMER_COLS = `id, name, phone, cpf, address,
            address_street, address_number, address_neighborhood, address_city,
            is_vip, created_at`;

    // 1) Vínculo DURÁVEL por customer_id (gravado ao cadastrar/vincular pelo
    //    chat). Funciona em qualquer canal — não depende de telefone.
    if (convRow.customer_id) {
      const byId = await client.query(
        `SELECT ${CUSTOMER_COLS}
           FROM commerce.partner_customers
          WHERE id = $1 AND environment = $2 AND unit_id = $3 AND deleted_at IS NULL`,
        [convRow.customer_id, ctx.environment, ctx.unitId],
      );
      if (byId.rowCount === 1) return buildLinked(byId.rows[0] as { id: string });
      // cliente excluído/inconsistente → cai pro match por telefone abaixo.
    }

    // 2) Fallback legado: casa por telefone (WhatsApp sem vínculo gravado).
    const phone = normalizeBrazilianPhone(convRow.customer_identifier ?? '');
    const suggestion = { name: convRow.customer_name ?? null, phone: phone ?? null };
    if (!phone) return { linked: false, suggestion };

    const cust = await client.query(
      `SELECT ${CUSTOMER_COLS}
         FROM commerce.partner_customers
        WHERE environment = $1 AND unit_id = $2 AND phone = $3 AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      [ctx.environment, ctx.unitId, phone],
    );
    if (cust.rowCount !== 1) return { linked: false, suggestion };
    return buildLinked(cust.rows[0] as { id: string });
  });
}

// ============================================================
// Chat unificado — VINCULAR CLIENTE à conversa (vínculo durável).
// Grava partner_conversations.customer_id pelo pool do bot (o portal
// só tem SELECT na conversa), com unit_id/environment explícitos —
// mesmo padrão de markPartnerChatRead. Valida que o cliente é da
// unidade antes de gravar.
// ============================================================

export type LinkPartnerChatCustomerStatus = 'ok' | 'conversation_not_found' | 'customer_not_found';

export async function linkPartnerChatCustomer(
  ctx: PartnerContext,
  conversationId: string,
  customerId: string,
): Promise<LinkPartnerChatCustomerStatus> {
  const cust = await pool.query(
    `SELECT 1 FROM commerce.partner_customers
      WHERE id = $1 AND environment = $2 AND unit_id = $3 AND deleted_at IS NULL`,
    [customerId, ctx.environment, ctx.unitId],
  );
  if ((cust.rowCount ?? 0) === 0) return 'customer_not_found';

  const upd = await pool.query(
    `UPDATE commerce.partner_conversations
        SET customer_id = $4
      WHERE id = $1 AND environment = $2 AND unit_id = $3`,
    [conversationId, ctx.environment, ctx.unitId, customerId],
  );
  if ((upd.rowCount ?? 0) === 0) return 'conversation_not_found';
  return 'ok';
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

// ─────────────────────────────────────────────────────────────────────────
// Etapa 4c — funcionários (logins de funcionário do parceiro)
//
// O DONO cria/lista/revoga logins de funcionário. Tudo escopado ao
// ctx.partnerUnitId (a própria unidade do dono autenticado) e gateado por
// requireOwner na rota. Usa o pool admin (mesmo padrão do chat acima e do
// cadastro de parceiro no admin) — o pool restrito do portal não tem GRANT
// em network.partner_access_tokens de propósito.
//
// Segurança embutida:
//   - role é SEMPRE 'funcionario' (dono não cria outro dono por aqui → sem
//     escalonamento de privilégio).
//   - criar/listar/revogar só mexem em partner_unit_id = ctx.partnerUnitId.
//   - revogar só pega tokens role='funcionario' → o dono nunca revoga (nem se
//     trava fora) o próprio login de dono por esta tela.
// ─────────────────────────────────────────────────────────────────────────

export interface PartnerTokenRow {
  id: string;
  label: string | null;
  username: string | null;
  role: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface CreatedFuncionario {
  id: string;
  label: string | null;
  username: string;
  created_at: string;
}

/** Login (usuário) já em uso nesta unidade — 23505 no índice único de username. */
export class PartnerUsernameConflictError extends Error {
  readonly code = 'username_taken';
  constructor() {
    super('username_taken');
  }
}

function isUsernameConflict(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505'
    && String((err as { constraint?: string })?.constraint ?? '').includes('username');
}

/**
 * Cria um login de funcionário (usuário+senha) pra unidade do dono. O funcionário
 * NUNCA toca em token: recebe usuário+senha do dono e entra pela tela de login.
 * Um token_hash aleatório é gerado só pra satisfazer o NOT NULL da coluna (a conta
 * é a própria linha) — ele nunca é revelado a ninguém.
 */
export async function createPartnerFuncionario(
  ctx: PartnerContext,
  label: string | null,
  username: string,
  password: string,
): Promise<CreatedFuncionario> {
  const fillerToken = randomBytes(32).toString('hex');
  const cleanLabel = label && label.trim() ? label.trim().slice(0, 120) : null;
  const cleanUsername = username.trim();
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Porta única (0095): o funcionário nasce como PESSOA (username único NA REDE —
    // antes era por unidade; "caio" da loja A bloqueia "caio" na loja B, igual
    // Instagram) + o vínculo com a unidade do dono.
    const person = await client.query<{ id: string }>(
      `INSERT INTO network.partner_people (environment, username, password_hash, password_set_at)
       VALUES ($1, $2, $3, now())
       RETURNING id`,
      [ctx.environment, cleanUsername, passwordHash],
    );
    const res = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO network.partner_access_tokens
         (environment, partner_unit_id, token_hash, label, created_by, role,
          login_username, login_password_hash, login_password_set_at, person_id)
       VALUES ($1, $2, network.hash_partner_token($3), $4, $5, 'funcionario',
               $6, $7, now(), $8)
       RETURNING id, created_at`,
      [ctx.environment, ctx.partnerUnitId, fillerToken, cleanLabel, `owner:${ctx.slug}`, cleanUsername, passwordHash, person.rows[0]!.id],
    );
    await client.query('COMMIT');
    const row = res.rows[0]!;
    return { id: row.id, label: cleanLabel, username: cleanUsername, created_at: row.created_at };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isUsernameConflict(err)) throw new PartnerUsernameConflictError();
    throw err;
  } finally {
    client.release();
  }
}

/** Reseta a senha de um login de funcionário da própria unidade (dono esqueceu = dono reseta). */
export async function resetPartnerFuncionarioPassword(
  ctx: PartnerContext,
  tokenId: string,
  newPassword: string,
): Promise<{ reset: boolean }> {
  const passwordHash = await hashPassword(newPassword);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<{ person_id: string | null }>(
      `UPDATE network.partner_access_tokens
          SET login_password_hash = $4, login_password_set_at = now()
        WHERE id = $1 AND environment = $2 AND partner_unit_id = $3
          AND role = 'funcionario' AND revoked_at IS NULL
        RETURNING person_id`,
      [tokenId, ctx.environment, ctx.partnerUnitId, passwordHash],
    );
    // Porta única (0095): a senha é DA PESSOA — atualiza a conta e espelha em
    // qualquer outro vínculo dela (hoje funcionário tem 1 vínculo; o espelho é
    // defesa pra quando existir multi-loja).
    const personId = res.rows[0]?.person_id ?? null;
    if (personId) {
      await client.query(
        `UPDATE network.partner_people
            SET password_hash = $2, password_set_at = now()
          WHERE id = $1 AND revoked_at IS NULL`,
        [personId, passwordHash],
      );
      await client.query(
        `UPDATE network.partner_access_tokens
            SET login_password_hash = $2, login_password_set_at = now()
          WHERE person_id = $1 AND id <> $3 AND revoked_at IS NULL`,
        [personId, passwordHash, tokenId],
      );
    }
    await client.query('COMMIT');
    return { reset: (res.rowCount ?? 0) > 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Lista os logins de funcionário da unidade do dono (com o usuário; sem hash de senha). */
export async function listPartnerFuncionarios(ctx: PartnerContext): Promise<PartnerTokenRow[]> {
  const res = await pool.query<PartnerTokenRow>(
    `SELECT id, label, login_username AS username, role, created_at, last_used_at, revoked_at
       FROM network.partner_access_tokens
      WHERE environment = $1 AND partner_unit_id = $2 AND role = 'funcionario'
      ORDER BY revoked_at IS NOT NULL, created_at DESC`,
    [ctx.environment, ctx.partnerUnitId],
  );
  return res.rows;
}

/** Revoga (desativa) um login de funcionário da própria unidade. */
export async function revokePartnerFuncionario(
  ctx: PartnerContext,
  tokenId: string,
): Promise<{ revoked: boolean }> {
  const res = await pool.query(
    `UPDATE network.partner_access_tokens
        SET revoked_at = now()
      WHERE id = $1 AND environment = $2 AND partner_unit_id = $3
        AND role = 'funcionario' AND revoked_at IS NULL`,
    [tokenId, ctx.environment, ctx.partnerUnitId],
  );
  // Revogar o token já mata as sessões dele (validate_partner_session exige
  // pat.revoked_at IS NULL), mas marcamos as sessões também por higiene.
  if ((res.rowCount ?? 0) > 0) {
    await pool.query(
      `UPDATE network.partner_sessions
          SET revoked_at = now()
        WHERE token_id = $1 AND environment = $2 AND revoked_at IS NULL`,
      [tokenId, ctx.environment],
    );
    // Porta única (0095): se era o ÚLTIMO vínculo ativo da pessoa, revoga a conta
    // também — libera o username (funcionário demitido não prende o nome pra sempre).
    await pool.query(
      `UPDATE network.partner_people pp
          SET revoked_at = now()
        WHERE pp.id = (SELECT person_id FROM network.partner_access_tokens WHERE id = $1)
          AND pp.revoked_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM network.partner_access_tokens t
             WHERE t.person_id = pp.id AND t.revoked_at IS NULL
          )`,
      [tokenId],
    );
  }
  return { revoked: (res.rowCount ?? 0) > 0 };
}

// ─────────────────────────────────────────────────────────────────────────
// Bloco 2 — Permissão e comissão POR PESSOA (vínculo = token_id), migration 0100.
//
// 🔒 Segurança: tudo que o DONO edita é amarrado a partner_unit_id = ctx.partnerUnitId
// E role='funcionario' (assertUnitFuncionario) — nunca outro dono, nunca outra loja. A
// leitura "Meu desempenho" é amarrada a ctx.tokenId (a pessoa só vê o PRÓPRIO). Tudo no
// pool admin (as tabelas network.* não têm GRANT no pool restrito), por isso o escopo por
// unit/env é EXPLÍCITO no WHERE — não há RLS de rede pra cair de fallback.
//
// 💰 Conciliação (regra do dono): a comissão soma o MESMO recorte de "venda realizada no
// mês" da view 0078 (orders_month): status<>cancelled, deleted_at NULL, entrega só se
// delivered, data por delivered_at (entrega)/created_at (resto). Calculada AO VIVO →
// cancelar uma venda derruba a comissão sozinho (nada de dívida fantasma). Comissão é
// somada POR PEDIDO (round por linha) → o total da equipe == o total do "Meu desempenho"
// == a soma das linhas, no centavo. Base = VALOR CHEIO (total_amount).
// ─────────────────────────────────────────────────────────────────────────

export class FuncionarioNotFoundError extends Error {
  readonly code = 'funcionario_not_found';
  constructor() {
    super('funcionario_not_found');
  }
}

export interface PartnerCommissionTeamRow {
  token_id: string;
  label: string | null;
  username: string | null;
  finalized_sales: number;
  gross_sales: number;
  commission_kind: 'percent' | 'fixed' | null;
  commission_value: number;
  commission_active: boolean;
  commission_amount: number;
}

export interface PartnerMyPerformanceSale {
  order_id: string;
  created_at: string;
  canal: 'balcao' | '2w';
  fulfillment_mode: string;
  status: string;
  amount: number;
  commission_amount: number;
}

export interface PartnerMyPerformance {
  finalized_sales: number;
  gross_sales: number;
  commission_kind: 'percent' | 'fixed' | null;
  commission_value: number;
  commission_active: boolean;
  commission_amount: number;
  sales: PartnerMyPerformanceSale[];
}

/** Confirma que o token é um funcionário ATIVO da unidade do dono. Senão, 404 lógico. */
async function assertUnitFuncionario(ctx: PartnerContext, tokenId: string): Promise<void> {
  const res = await pool.query(
    `SELECT 1 FROM network.partner_access_tokens
      WHERE id = $1 AND environment = $2 AND partner_unit_id = $3
        AND role = 'funcionario' AND revoked_at IS NULL`,
    [tokenId, ctx.environment, ctx.partnerUnitId],
  );
  if ((res.rowCount ?? 0) === 0) throw new FuncionarioNotFoundError();
}

/**
 * Upsert das telas liberadas de UM funcionário (por vínculo = token_id), 0100.
 * Mesma allowlist fixa do servidor (PARTNER_SCREENS) — chave fora (ex.: 'config')
 * é ignorada (Configurações nunca é liberável). Owner-only no endpoint.
 */
export async function upsertPartnerTokenPermissions(
  ctx: PartnerContext,
  tokenId: string,
  input: PartnerPermissionsInput,
): Promise<PartnerPermissions> {
  await assertUnitFuncionario(ctx, tokenId);
  const resolved: PartnerPermissions = {
    vendas: true, estoque: true, pedidos: true, clientes: true,
    entregas: true, retiradas: true, batepapo: true, resumo: false, financeiro: false,
  };
  for (const screen of PARTNER_SCREENS) {
    const v = input[screen];
    if (typeof v === 'boolean') resolved[screen] = v;
  }
  await pool.query(
    `INSERT INTO network.partner_token_permissions
       (token_id, environment, partner_unit_id,
        allow_vendas, allow_estoque, allow_pedidos, allow_clientes,
        allow_entregas, allow_retiradas, allow_batepapo, allow_resumo, allow_financeiro, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (token_id) DO UPDATE SET
        allow_vendas     = EXCLUDED.allow_vendas,
        allow_estoque    = EXCLUDED.allow_estoque,
        allow_pedidos    = EXCLUDED.allow_pedidos,
        allow_clientes   = EXCLUDED.allow_clientes,
        allow_entregas   = EXCLUDED.allow_entregas,
        allow_retiradas  = EXCLUDED.allow_retiradas,
        allow_batepapo   = EXCLUDED.allow_batepapo,
        allow_resumo     = EXCLUDED.allow_resumo,
        allow_financeiro = EXCLUDED.allow_financeiro,
        updated_at       = now(),
        updated_by       = EXCLUDED.updated_by`,
    [
      tokenId, ctx.environment, ctx.partnerUnitId,
      resolved.vendas, resolved.estoque, resolved.pedidos, resolved.clientes,
      resolved.entregas, resolved.retiradas, resolved.batepapo, resolved.resumo, resolved.financeiro,
      `owner:${ctx.slug}`,
    ],
  );
  return resolved;
}

/**
 * Lê as telas EFETIVAS de UM funcionário (pro drawer do dono), mesma cadeia de
 * resolvePartnerPermissions: per-token (0100) → por loja (0087) → defaults. Owner-only.
 */
export async function getPartnerTokenPermissions(ctx: PartnerContext, tokenId: string): Promise<PartnerPermissions> {
  await assertUnitFuncionario(ctx, tokenId);
  const cols = `allow_vendas, allow_estoque, allow_pedidos, allow_clientes,
                allow_entregas, allow_retiradas, allow_batepapo, allow_resumo, allow_financeiro`;
  type Row = {
    allow_vendas: boolean; allow_estoque: boolean; allow_pedidos: boolean;
    allow_clientes: boolean; allow_entregas: boolean; allow_retiradas: boolean;
    allow_batepapo: boolean; allow_resumo: boolean; allow_financeiro: boolean;
  };
  const mapRow = (r: Row): PartnerPermissions => ({
    vendas: r.allow_vendas, estoque: r.allow_estoque, pedidos: r.allow_pedidos,
    clientes: r.allow_clientes, entregas: r.allow_entregas, retiradas: r.allow_retiradas,
    batepapo: r.allow_batepapo, resumo: r.allow_resumo, financeiro: r.allow_financeiro,
  });
  const perToken = await pool.query<Row>(
    `SELECT ${cols} FROM network.partner_token_permissions WHERE token_id = $1 AND environment = $2`,
    [tokenId, ctx.environment],
  );
  if (perToken.rows[0]) return mapRow(perToken.rows[0]);
  const perUnit = await pool.query<Row>(
    `SELECT ${cols} FROM network.partner_unit_permissions WHERE partner_unit_id = $1 AND environment = $2`,
    [ctx.partnerUnitId, ctx.environment],
  );
  if (perUnit.rows[0]) return mapRow(perUnit.rows[0]);
  return {
    vendas: true, estoque: true, pedidos: true, clientes: true,
    entregas: true, retiradas: true, batepapo: true, resumo: false, financeiro: false,
  };
}

/** Lê a comissão configurada de UM funcionário (SEM linha = inativa, 0%). Owner-only. */
export async function getPartnerTokenCommission(ctx: PartnerContext, tokenId: string): Promise<PartnerCommissionConfig> {
  await assertUnitFuncionario(ctx, tokenId);
  const res = await pool.query<{ kind: 'percent' | 'fixed'; value: string; active: boolean }>(
    `SELECT kind, value, active FROM network.partner_token_commission
      WHERE token_id = $1 AND environment = $2`,
    [tokenId, ctx.environment],
  );
  const row = res.rows[0];
  if (!row) return { kind: 'percent', value: 0, active: false };
  return { kind: row.kind, value: Number(row.value), active: row.active };
}

/** Grava a comissão de UM funcionário (% ou fixo). Owner-only. Normaliza no servidor. */
export async function upsertPartnerTokenCommission(
  ctx: PartnerContext,
  tokenId: string,
  input: PartnerCommissionConfig,
): Promise<PartnerCommissionConfig> {
  await assertUnitFuncionario(ctx, tokenId);
  const kind: 'percent' | 'fixed' = input.kind === 'fixed' ? 'fixed' : 'percent';
  // SEC (M1): teto também AQUI (fonte única de escrita) — defesa em profundidade,
  // mesmo se algum caminho futuro pular o schema. % nunca passa de 100.
  const cap = kind === 'percent' ? 100 : 1_000_000;
  const value = Number.isFinite(input.value) && input.value > 0
    ? Math.min(Math.round(input.value * 100) / 100, cap)
    : 0;
  const active = !!input.active;
  await pool.query(
    `INSERT INTO network.partner_token_commission
       (token_id, environment, partner_unit_id, kind, value, active, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (token_id) DO UPDATE SET
        kind = EXCLUDED.kind, value = EXCLUDED.value, active = EXCLUDED.active,
        updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [tokenId, ctx.environment, ctx.partnerUnitId, kind, value, active, `owner:${ctx.slug}`],
  );
  return { kind, value, active };
}

/**
 * Resumo da comissão da EQUIPE no mês (card do dono no Financeiro). Owner-only.
 * Soma por PEDIDO (round por linha) o recorte de venda realizada da 0078.
 * Só funcionários ativos da unidade. Total = soma das linhas (bate com Meu desempenho).
 */
export async function getPartnerCommissionTeam(
  ctx: PartnerContext,
): Promise<{ rows: PartnerCommissionTeamRow[]; total_commission: number }> {
  const res = await pool.query<{
    token_id: string; label: string | null; username: string | null;
    finalized_sales: string; gross_sales: string;
    commission_kind: 'percent' | 'fixed' | null; commission_value: string;
    commission_active: boolean; commission_amount: string;
  }>(
    `WITH mb AS (
       SELECT (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS month_start_at
     ),
     priced AS (
       SELECT po.operator_token_id AS token_id,
              COALESCE(po.total_amount, 0)::numeric AS amount,
              CASE WHEN cc.active IS NOT TRUE THEN 0
                   WHEN cc.kind = 'percent' THEN round(COALESCE(po.total_amount, 0) * cc.value / 100.0, 2)
                   WHEN cc.kind = 'fixed'   THEN cc.value
                   ELSE 0 END AS line_commission
       FROM commerce.partner_orders po
       CROSS JOIN mb
       LEFT JOIN network.partner_token_commission cc ON cc.token_id = po.operator_token_id
       WHERE po.environment = $1
         AND po.unit_id = $2
         AND po.operator_token_id IS NOT NULL
         AND po.status <> 'cancelled'
         AND po.deleted_at IS NULL
         AND NOT (po.fulfillment_mode = 'delivery' AND po.delivery_status <> 'delivered')
         AND (CASE WHEN po.fulfillment_mode = 'delivery' THEN po.delivered_at ELSE po.created_at END) >= mb.month_start_at
     )
     SELECT pat.id AS token_id, pat.label, pat.login_username AS username,
            COALESCE(count(p.token_id), 0)::int   AS finalized_sales,
            COALESCE(sum(p.amount), 0)::numeric    AS gross_sales,
            cfg.kind AS commission_kind,
            COALESCE(cfg.value, 0)::numeric        AS commission_value,
            COALESCE(cfg.active, false)            AS commission_active,
            COALESCE(sum(p.line_commission), 0)::numeric AS commission_amount
       FROM network.partner_access_tokens pat
       LEFT JOIN priced p ON p.token_id = pat.id
       LEFT JOIN network.partner_token_commission cfg ON cfg.token_id = pat.id
      WHERE pat.environment = $1 AND pat.partner_unit_id = $3
        AND pat.role = 'funcionario' AND pat.revoked_at IS NULL
      GROUP BY pat.id, pat.label, pat.login_username, cfg.kind, cfg.value, cfg.active
      ORDER BY commission_amount DESC, username ASC`,
    [ctx.environment, ctx.unitId, ctx.partnerUnitId],
  );
  const rows: PartnerCommissionTeamRow[] = res.rows.map((r) => ({
    token_id: r.token_id,
    label: r.label,
    username: r.username,
    finalized_sales: Number(r.finalized_sales),
    gross_sales: Number(r.gross_sales),
    commission_kind: r.commission_kind,
    commission_value: Number(r.commission_value),
    commission_active: r.commission_active,
    commission_amount: Number(r.commission_amount),
  }));
  const total_commission = Math.round(rows.reduce((s, r) => s + r.commission_amount, 0) * 100) / 100;
  return { rows, total_commission };
}

/**
 * "Meu desempenho" do funcionário logado (pelo chip do topo). Amarrado a ctx.tokenId —
 * a pessoa só vê o PRÓPRIO. Lista as vendas dela no mês com canal/status/valor/comissão;
 * o total bate com a soma das linhas (mesma fonte `lineCommission` da equipe).
 */
export async function getPartnerMyPerformance(ctx: PartnerContext): Promise<PartnerMyPerformance> {
  const cfgRes = await pool.query<{ kind: 'percent' | 'fixed'; value: string; active: boolean }>(
    `SELECT kind, value, active FROM network.partner_token_commission
      WHERE token_id = $1 AND environment = $2`,
    [ctx.tokenId, ctx.environment],
  );
  const cfgRow = cfgRes.rows[0];
  const cfg: PartnerCommissionConfig = cfgRow
    ? { kind: cfgRow.kind, value: Number(cfgRow.value), active: cfgRow.active }
    : { kind: 'percent', value: 0, active: false };

  const salesRes = await pool.query<{
    order_id: string; created_at: string; source_tag: string | null;
    fulfillment_mode: string; status: string; amount: string;
  }>(
    `WITH mb AS (
       SELECT (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS month_start_at
     )
     SELECT po.id AS order_id, po.created_at, po.source_tag,
            po.fulfillment_mode, po.status, COALESCE(po.total_amount, 0)::numeric AS amount
       FROM commerce.partner_orders po
       CROSS JOIN mb
      WHERE po.environment = $1
        AND po.unit_id = $2
        AND po.operator_token_id = $3
        AND po.status <> 'cancelled'
        AND po.deleted_at IS NULL
        AND NOT (po.fulfillment_mode = 'delivery' AND po.delivery_status <> 'delivered')
        AND (CASE WHEN po.fulfillment_mode = 'delivery' THEN po.delivered_at ELSE po.created_at END) >= mb.month_start_at
      ORDER BY po.created_at DESC
      LIMIT 200`,
    [ctx.environment, ctx.unitId, ctx.tokenId],
  );

  const sales: PartnerMyPerformanceSale[] = salesRes.rows.map((r) => {
    const amount = Number(r.amount);
    return {
      order_id: r.order_id,
      created_at: r.created_at,
      canal: r.source_tag === '2w' ? '2w' : 'balcao',
      fulfillment_mode: r.fulfillment_mode,
      status: r.status,
      amount,
      commission_amount: lineCommission(cfg, amount),
    };
  });
  // Soma em centavos (sem fuzz de float) → bate com a soma das linhas exibidas.
  const gross_sales = sales.reduce((s, v) => s + Math.round(v.amount * 100), 0) / 100;
  const commission_amount = sales.reduce((s, v) => s + Math.round(v.commission_amount * 100), 0) / 100;
  return {
    finalized_sales: sales.length,
    gross_sales,
    commission_kind: cfg.active ? cfg.kind : null,
    commission_value: cfg.value,
    commission_active: cfg.active,
    commission_amount,
    sales,
  };
}

/**
 * Nome de exibição do login ATUAL (chip do topo). Só o PRÓPRIO (ctx.tokenId) —
 * não lê de ninguém. Mata o "Caixa 01" chumbado no front.
 */
export async function getPartnerSelfIdentity(
  ctx: PartnerContext,
): Promise<{ display_name: string | null; username: string | null }> {
  const res = await pool.query<{ label: string | null; username: string | null }>(
    `SELECT label, login_username AS username
       FROM network.partner_access_tokens
      WHERE id = $1 AND environment = $2`,
    [ctx.tokenId, ctx.environment],
  );
  const row = res.rows[0];
  return { display_name: row?.label || row?.username || null, username: row?.username || null };
}

// ─────────────────────────────────────────────────────────────────────────
// P1 — Login de verdade (usuário + senha) + sessões
//
// O token de acesso (~48 chars, hash-only) vira CHAVE DE PRIMEIRO ACESSO do dono.
// Login confere a senha e emite um token de SESSÃO (descartável, com validade);
// o navegador usa a sessão no lugar do token cru. Tudo via pool admin — o pool
// restrito do portal não tem GRANT de leitura/escrita em partner_access_tokens
// nem partner_sessions (só EXECUTE em validate_partner_session, no auth.ts).
// ─────────────────────────────────────────────────────────────────────────

const SESSION_TTL_DAYS = 30;

export interface PartnerSessionResult {
  session_token: string; // texto puro — devolvido UMA vez; o banco guarda só o hash
  expires_at: string;
}

/** Emite uma sessão pra um login (token_id). Guarda só o hash; devolve o texto uma vez.
 *  Exportada pra porta única (0095): /api/login global emite sessão do vínculo escolhido. */
export async function mintPartnerSession(environment: string, tokenId: string): Promise<PartnerSessionResult> {
  const { token, hash } = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await pool.query(
    `INSERT INTO network.partner_sessions (environment, token_id, session_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [environment, tokenId, hash, expiresAt],
  );
  return { session_token: token, expires_at: expiresAt };
}

/**
 * Login por usuário+senha. Acha o login ativo da unidade (slug) com aquele usuário,
 * confere a senha (scrypt, tempo constante) e emite uma sessão. Devolve null em
 * usuário inexistente OU senha errada (mesma resposta — não revela qual). Quando o
 * usuário não existe, queima o mesmo tempo de um verify real (anti-enumeração).
 */
export async function authenticatePartnerLogin(
  environment: string,
  slug: string,
  username: string,
  password: string,
): Promise<PartnerSessionResult | null> {
  const res = await pool.query<{ token_id: string; login_password_hash: string | null }>(
    `SELECT pat.id AS token_id, pat.login_password_hash
       FROM network.partner_access_tokens pat
       JOIN network.partner_units pu ON pu.id = pat.partner_unit_id AND pu.environment = pat.environment
       JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
      WHERE pat.environment = $1
        AND pu.slug = $2
        AND lower(pat.login_username) = lower($3)
        AND pat.revoked_at IS NULL
        AND pat.login_password_hash IS NOT NULL
        AND pu.status = 'active' AND p.status = 'active'
        AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
      LIMIT 1`,
    [environment, slug, username.trim()],
  );

  const row = res.rows[0];
  if (!row) {
    await fakeVerify(password); // anti-enumeração por timing
    return null;
  }
  const ok = await verifyPassword(password, row.login_password_hash);
  if (!ok) return null;
  return mintPartnerSession(environment, row.token_id);
}

/**
 * Primeiro acesso do DONO: autenticado pelo TOKEN cru (que ele colou), define
 * usuário+senha do próprio login e já recebe uma sessão (não precisa redigitar).
 *
 * allowOverwrite=true SÓ quando a autenticação veio por token cru (posse do token
 * de ~48 chars = prova de recuperação do dono → pode re(definir) a senha). Por
 * sessão, allowOverwrite=false: só funciona se o login ainda não tem senha.
 */
export async function setOwnPartnerCredentials(
  ctx: PartnerContext,
  username: string,
  password: string,
  allowOverwrite: boolean,
): Promise<PartnerSessionResult> {
  const passwordHash = await hashPassword(password);
  const cleanUsername = username.trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) O vínculo desta unidade (regra de overwrite intacta: só token cru sobrescreve).
    const res = await client.query<{ person_id: string | null }>(
      `UPDATE network.partner_access_tokens
          SET login_username = $4, login_password_hash = $5, login_password_set_at = now()
        WHERE id = $1 AND environment = $2 AND partner_unit_id = $3
          AND revoked_at IS NULL
          AND ($6 OR login_password_hash IS NULL)
        RETURNING person_id`,
      [ctx.tokenId, ctx.environment, ctx.partnerUnitId, cleanUsername, passwordHash, allowOverwrite],
    );
    if ((res.rowCount ?? 0) !== 1) {
      // Login já tinha senha e a chamada veio por sessão (não por token cru).
      await client.query('ROLLBACK');
      throw new PartnerCredentialsAlreadySetError();
    }

    // 2) A PESSOA (porta única, 0095): a conta global carrega o username+senha.
    //    Username já de outra pessoa → 23505 no índice global → username_taken
    //    (fusão de contas NUNCA acontece em runtime; só no backfill auditado).
    let personId = res.rows[0]!.person_id;
    if (personId) {
      await client.query(
        `UPDATE network.partner_people
            SET username = $2, password_hash = $3, password_set_at = now()
          WHERE id = $1 AND revoked_at IS NULL`,
        [personId, cleanUsername, passwordHash],
      );
    } else {
      const created = await client.query<{ id: string }>(
        `INSERT INTO network.partner_people (environment, username, password_hash, password_set_at)
         VALUES ($1, $2, $3, now())
         RETURNING id`,
        [ctx.environment, cleanUsername, passwordHash],
      );
      personId = created.rows[0]!.id;
      await client.query(
        `UPDATE network.partner_access_tokens SET person_id = $2 WHERE id = $1`,
        [ctx.tokenId, personId],
      );
    }

    // 3) Espelha nos OUTROS vínculos da pessoa: UMA senha/usuário em todas as lojas
    //    (o login por slug lê a linha — fica coerente com a porta única).
    await client.query(
      `UPDATE network.partner_access_tokens
          SET login_username = $2, login_password_hash = $3, login_password_set_at = now()
        WHERE person_id = $1 AND id <> $4 AND revoked_at IS NULL`,
      [personId, cleanUsername, passwordHash, ctx.tokenId],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isUsernameConflict(err)) throw new PartnerUsernameConflictError();
    throw err;
  } finally {
    client.release();
  }
  return mintPartnerSession(ctx.environment, ctx.tokenId);
}

/** Tentou definir credenciais por sessão num login que já tem senha — use o reset. */
export class PartnerCredentialsAlreadySetError extends Error {
  readonly code = 'credentials_already_set';
  constructor() {
    super('credentials_already_set');
  }
}

/** Logout: revoga a sessão atual no servidor (além do front limpar o localStorage). */
export async function revokePartnerSession(environment: string, sessionToken: string): Promise<void> {
  await pool.query(
    `UPDATE network.partner_sessions
        SET revoked_at = now()
      WHERE environment = $1 AND session_hash = $2 AND revoked_at IS NULL`,
    [environment, hashSessionToken(sessionToken)],
  );
}

// ─────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÕES DA LOJA (PLANO_CONFIG_LOJA_E_ROTEAMENTO_REDE — Fase 1)
//
// Tudo usa o pool ADMIN (role 'postgres'), NÃO o withPartnerContext/partnerPool:
//   - network.partner_units: o pool restrito só tem GRANT SELECT (não UPDATE).
//   - network.unit_coverage: o pool restrito NÃO tem GRANT nenhum (tabela de
//     roteamento que o bot lê com a role admin).
//   - network.partner_unit_permissions: idem (tabela de autorização).
// Toda query é ESCOPADA por ctx.partnerUnitId (partner_units/permissions) ou
// ctx.unitId (unit_coverage, que é chaveada por core.units.id) + ctx.environment.
// Isolamento entre parceiros = o WHERE escopado (gate §5.4). Os endpoints são
// requireOwner cru (Configurações é cadeado duro), então só o dono chega aqui.
// ─────────────────────────────────────────────────────────────────────────

export type PartnerServiceMode = 'delivery' | 'pickup' | 'both';

export interface PartnerLojaInput {
  display_name: string;
  address_street?: string | null;
  address_number?: string | null;
  address_neighborhood?: string | null;
  address_city?: string | null;
  address_complement?: string | null;
  cep?: string | null;
  opening_hours_text?: string | null;
  maps_url?: string | null;
}

export interface PartnerAreaInput {
  // true = cobre a cidade inteira (1 linha, bairro NULL, kind='city' = hoje).
  // false = cobre só os bairros listados (N linhas kind='neighborhood').
  city_wide: boolean;
  municipio: string;
  // Bairros canônicos (lower(unaccent)) — só usados quando city_wide=false.
  neighborhoods?: string[];
}

export interface PartnerConfiguracoes {
  loja: {
    display_name: string | null;
    address_street: string | null;
    address_number: string | null;
    address_neighborhood: string | null;
    address_city: string | null;
    address_complement: string | null;
    cep: string | null;
    opening_hours_text: string | null;
    maps_url: string | null;
    address_confirmed_at: string | null;
    service_mode: PartnerServiceMode;
    // Derivados do enum pra a UI dos 2 checkboxes (arbitragem B).
    faz_entrega: boolean;
    tem_retirada: boolean;
    // Raio máximo de ENTREGA em km (proximidade-primeiro Fase 2/3). NULL = não
    // preenchido → fora da entrega quando a flag ROUTING_PROXIMITY_FIRST ligar.
    delivery_radius_km: number | null;
  } | null;
  // Cobertura agrupada por município: cidade inteira OU lista de bairros.
  coverage: Array<{
    municipio: string;
    city_wide: boolean;
    neighborhoods: string[];
  }>;
  permissions: PartnerPermissions;
}

const VALID_SERVICE_MODES: ReadonlySet<string> = new Set(['delivery', 'pickup', 'both']);

/** Normaliza bairro pro formato canônico (lower + trim). O unaccent fica a cargo
 *  da busca/resolve_neighborhood; aqui só padronizamos caixa e espaços. */
function canonicalNeighborhood(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * Lê TUDO da tela Configurações: dados da loja + modo + cobertura/área +
 * permissões efetivas. Escopado por ctx.partnerUnitId/ctx.unitId + environment.
 */
export async function getPartnerConfiguracoes(ctx: PartnerContext): Promise<PartnerConfiguracoes> {
  const unitRes = await pool.query<{
    display_name: string | null;
    address_street: string | null;
    address_number: string | null;
    address_neighborhood: string | null;
    address_city: string | null;
    address_complement: string | null;
    cep: string | null;
    opening_hours_text: string | null;
    maps_url: string | null;
    address_confirmed_at: string | null;
    service_mode: string;
    delivery_radius_km: string | null;
  }>(
    `SELECT display_name, address_street, address_number, address_neighborhood,
            address_city, address_complement, cep, opening_hours_text, maps_url,
            address_confirmed_at, service_mode, delivery_radius_km
       FROM network.partner_units
      WHERE id = $1 AND environment = $2`,
    [ctx.partnerUnitId, ctx.environment],
  );

  const u = unitRes.rows[0];
  const serviceMode: PartnerServiceMode = u && VALID_SERVICE_MODES.has(u.service_mode)
    ? (u.service_mode as PartnerServiceMode)
    : 'both';

  const loja = u
    ? {
        display_name: u.display_name,
        address_street: u.address_street,
        address_number: u.address_number,
        address_neighborhood: u.address_neighborhood,
        address_city: u.address_city,
        address_complement: u.address_complement,
        cep: u.cep,
        opening_hours_text: u.opening_hours_text,
        maps_url: u.maps_url,
        address_confirmed_at: u.address_confirmed_at,
        service_mode: serviceMode,
        faz_entrega: serviceMode === 'delivery' || serviceMode === 'both',
        tem_retirada: serviceMode === 'pickup' || serviceMode === 'both',
        // NUMERIC volta como string do pg → coage pra number (ou null).
        delivery_radius_km: u.delivery_radius_km != null ? Number(u.delivery_radius_km) : null,
      }
    : null;

  // Cobertura: chaveada por unit_id (= core.units.id). Agrupa por município.
  const covRes = await pool.query<{
    municipio: string;
    neighborhood_canonical: string | null;
    coverage_kind: string;
  }>(
    `SELECT municipio, neighborhood_canonical, coverage_kind
       FROM network.unit_coverage
      WHERE unit_id = $1 AND environment = $2
      ORDER BY municipio, neighborhood_canonical NULLS FIRST`,
    [ctx.unitId, ctx.environment],
  );

  const byMunicipio = new Map<string, { municipio: string; city_wide: boolean; neighborhoods: string[] }>();
  for (const row of covRes.rows) {
    let entry = byMunicipio.get(row.municipio);
    if (!entry) {
      entry = { municipio: row.municipio, city_wide: false, neighborhoods: [] };
      byMunicipio.set(row.municipio, entry);
    }
    if (row.coverage_kind === 'city' || row.neighborhood_canonical === null) {
      entry.city_wide = true;
    } else {
      entry.neighborhoods.push(row.neighborhood_canonical);
    }
  }

  const permissions = await resolvePartnerPermissions(ctx);

  return {
    loja,
    coverage: Array.from(byMunicipio.values()),
    permissions,
  };
}

/**
 * Atualiza dados da loja: nome de exibição, endereço estruturado, horário (texto).
 * Carimba address_confirmed_at = now() (auditoria leve: o dono revisou o endereço).
 * Escopado por ctx.partnerUnitId + environment. Retorna {updated:false} se a
 * unidade não existe nesse escopo (não deveria acontecer pós-requireOwner).
 */
export async function updatePartnerLoja(
  ctx: PartnerContext,
  input: PartnerLojaInput,
): Promise<{ updated: boolean }> {
  const clean = (v: string | null | undefined): string | null => {
    if (v === null || v === undefined) return null;
    const t = v.trim();
    return t.length ? t : null;
  };
  const res = await pool.query(
    `UPDATE network.partner_units
        SET display_name         = $3,
            address_street        = $4,
            address_number        = $5,
            address_neighborhood  = $6,
            address_city          = $7,
            address_complement    = $8,
            cep                   = $9,
            opening_hours_text    = $10,
            maps_url              = $11,
            address_confirmed_at  = now()
      WHERE id = $1 AND environment = $2`,
    [
      ctx.partnerUnitId,
      ctx.environment,
      input.display_name.trim(),
      clean(input.address_street),
      clean(input.address_number),
      clean(input.address_neighborhood),
      clean(input.address_city),
      clean(input.address_complement),
      clean(input.cep),
      clean(input.opening_hours_text),
      clean(input.maps_url),
    ],
  );
  return { updated: (res.rowCount ?? 0) > 0 };
}

/**
 * Atualiza o MODO de atendimento (enum service_mode) + o raio de ENTREGA. A UI
 * manda 2 checkboxes (faz_entrega / tem_retirada) + o raio em km; o ROUTE mapeia
 * pro enum, valida "pelo menos um" e ZERA o raio quando não faz entrega (raio só
 * existe quando entrega). Aqui recebemos o enum e o raio já resolvidos.
 * Escopado por ctx.partnerUnitId + environment.
 *
 * deliveryRadiusKm: km máximo de entrega (proximidade-primeiro Fase 3). NULL =
 * não preenchido = fora da entrega quando a flag ligar. A retirada nunca usa raio.
 */
export async function updatePartnerAtendimento(
  ctx: PartnerContext,
  serviceMode: PartnerServiceMode,
  deliveryRadiusKm: number | null,
): Promise<{ updated: boolean }> {
  const res = await pool.query(
    `UPDATE network.partner_units
        SET service_mode       = $3,
            delivery_radius_km = $4
      WHERE id = $1 AND environment = $2`,
    [ctx.partnerUnitId, ctx.environment, serviceMode, deliveryRadiusKm],
  );
  return { updated: (res.rowCount ?? 0) > 0 };
}

/**
 * Reescreve a ÁREA de entrega de UM município (PLANO §2.2, Fase 1 = DECLARATIVO).
 *
 *   - city_wide=true  → apaga as linhas de bairro daquele município e garante 1
 *                       linha de cidade inteira (bairro NULL, kind='city' = hoje).
 *   - city_wide=false → apaga a linha de cidade e regrava as N linhas de bairro
 *                       (kind='neighborhood', bairro NOT NULL) — respeitando o
 *                       CHECK casado e o UNIQUE de 4 colunas da 0087.
 *
 * Chaveado por ctx.unitId (= core.units.id, igual createPartnerUnit). Transação:
 * o "limpa + regrava" é atômico. NÃO mexe em coberturas de OUTROS municípios.
 *
 * ⚠️ Fase 1 declarativo: grava/exibe; o bot ainda NÃO filtra por bairro (Fase 2).
 */
export async function updatePartnerArea(
  ctx: PartnerContext,
  input: PartnerAreaInput,
): Promise<{ updated: boolean; municipio: string; city_wide: boolean; neighborhoods: string[] }> {
  const municipio = input.municipio.trim().toLowerCase();
  if (!municipio) throw new Error('municipio_required');

  // Dedup + normaliza bairros (só quando não é cidade inteira).
  const neighborhoods = input.city_wide
    ? []
    : Array.from(new Set((input.neighborhoods ?? []).map(canonicalNeighborhood).filter((n) => n.length > 0)));

  if (!input.city_wide && neighborhoods.length === 0) {
    // "Bairros específicos" sem nenhum bairro não faz sentido — o caller (route)
    // deveria barrar; aqui é a guarda final.
    throw new Error('neighborhoods_required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Apaga TODA a cobertura atual daquele município (cidade + bairros) e regrava
    // do zero — simples e idempotente. Escopo: unit_id + environment + municipio.
    await client.query(
      `DELETE FROM network.unit_coverage
        WHERE unit_id = $1 AND environment = $2 AND municipio = $3`,
      [ctx.unitId, ctx.environment, municipio],
    );

    if (input.city_wide) {
      await client.query(
        `INSERT INTO network.unit_coverage
           (environment, unit_id, municipio, neighborhood_canonical, coverage_kind)
         VALUES ($1, $2, $3, NULL, 'city')`,
        [ctx.environment, ctx.unitId, municipio],
      );
    } else {
      for (const bairro of neighborhoods) {
        await client.query(
          `INSERT INTO network.unit_coverage
             (environment, unit_id, municipio, neighborhood_canonical, coverage_kind)
           VALUES ($1, $2, $3, $4, 'neighborhood')`,
          [ctx.environment, ctx.unitId, municipio, bairro],
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  return { updated: true, municipio, city_wide: input.city_wide, neighborhoods };
}

/**
 * Busca de bairros pra a UI da área de entrega ("copa" → Copacabana). Usa
 * commerce.resolve_neighborhood (PLANO §2.2; assinatura confirmada na 0048 e no
 * banco: (p_environment env_t, p_input text, p_city text, p_min_similarity numeric)).
 *
 * Pool ADMIN: resolve_neighborhood é SECURITY INVOKER e lê commerce.geo_resolutions,
 * onde o pool restrito do portal NÃO tem SELECT — então roda com a role admin.
 * É leitura de dado geográfico público, sem dado de parceiro (sem risco de vazamento
 * entre parceiros). O endpoint que chama é requireOwner.
 */
export async function searchPartnerBairros(
  environment: string,
  municipio: string | null,
  q: string,
): Promise<Array<{ neighborhood_canonical: string; city_name: string; match_type: string }>> {
  const query = (q ?? '').trim();
  if (query.length < 2) return [];
  const res = await pool.query<{
    neighborhood_canonical: string;
    city_name: string;
    match_type: string;
  }>(
    `SELECT neighborhood_canonical, city_name, match_type
       FROM commerce.resolve_neighborhood($1::env_t, $2, $3)`,
    [environment, query, municipio && municipio.trim() ? municipio.trim() : null],
  );
  return res.rows;
}

export interface PartnerPermissionsInput {
  // Chaves livres vindas do cliente — passam pela allowlist antes de gravar.
  [key: string]: unknown;
}

/**
 * Upsert 1:1 das permissões de tela do funcionário (PLANO §2.3, gate §5.2).
 *
 * 🔒 ALLOWLIST FIXA NO SERVIDOR: só as 9 telas de PARTNER_SCREENS são consideradas.
 * Qualquer chave fora da lista (notadamente `config`) é IGNORADA — defesa em
 * profundidade. Configurações NUNCA é liberável por permissão (cadeado duro: a
 * trava real é requireOwner cru nos endpoints de Configurações).
 *
 * Chave ausente no input ⇒ default da Etapa 4 daquela tela (operacional true;
 * Resumo/Financeiro false). Escopado por ctx.partnerUnitId + environment.
 */
export async function upsertPartnerPermissions(
  ctx: PartnerContext,
  input: PartnerPermissionsInput,
): Promise<PartnerPermissions> {
  // Defaults da Etapa 4 — qualquer chave não enviada/ inválida cai aqui.
  const defaults: PartnerPermissions = {
    vendas: true, estoque: true, pedidos: true, clientes: true,
    entregas: true, retiradas: true, batepapo: true, resumo: false, financeiro: false,
  };

  const resolved = { ...defaults };
  for (const screen of PARTNER_SCREENS) {
    const v = input[screen];
    if (typeof v === 'boolean') {
      resolved[screen] = v;
    }
    // Chave fora de PARTNER_SCREENS (ex.: 'config') nunca é lida → ignorada.
  }

  await pool.query(
    `INSERT INTO network.partner_unit_permissions
       (partner_unit_id, environment,
        allow_vendas, allow_estoque, allow_pedidos, allow_clientes,
        allow_entregas, allow_retiradas, allow_batepapo, allow_resumo, allow_financeiro)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (partner_unit_id) DO UPDATE SET
        allow_vendas     = EXCLUDED.allow_vendas,
        allow_estoque    = EXCLUDED.allow_estoque,
        allow_pedidos    = EXCLUDED.allow_pedidos,
        allow_clientes   = EXCLUDED.allow_clientes,
        allow_entregas   = EXCLUDED.allow_entregas,
        allow_retiradas  = EXCLUDED.allow_retiradas,
        allow_batepapo   = EXCLUDED.allow_batepapo,
        allow_resumo     = EXCLUDED.allow_resumo,
        allow_financeiro = EXCLUDED.allow_financeiro,
        updated_at       = now()`,
    [
      ctx.partnerUnitId,
      ctx.environment,
      resolved.vendas,
      resolved.estoque,
      resolved.pedidos,
      resolved.clientes,
      resolved.entregas,
      resolved.retiradas,
      resolved.batepapo,
      resolved.resumo,
      resolved.financeiro,
    ],
  );

  return resolved;
}

// ============================================================
// FOTO SOB DEMANDA (0094) — fila de pedidos de foto + upload.
// Cliente pede foto do pneu usado → bot cria photo_request → card no painel →
// borracheiro fotografa → sistema manda pro cliente (dispatcher, lado bot).
// Tudo via withPartnerContext: RLS isola por unidade; a view partner_photo_queue
// é WHITELIST (sem conversation_id/contact_id — anti-bypass de comissão, E2/E16).
// Plano: docs/PLANO_FOTO_SOB_DEMANDA_2026-06-10.md
// ============================================================

export interface PartnerPhotoQueueItem {
  id: string;
  tire_size: string;
  brand: string | null;
  note: string | null;
  status: string;
  was_late: boolean;
  has_photo: boolean;
  photo_count: number;
  expires_at: string;
  answered_at: string | null;
  created_at: string;
  // Nome do cliente (0107) — SÓ o nome, pro card diferenciar as pessoas. Sem
  // telefone/contato (a view nunca projeta conversation_id/contact_id). Pode ser
  // null (pedido antigo sem rótulo, ou conversa sem nome de contato).
  customer_name: string | null;
}

/**
 * Fila de pedidos de foto da unidade: cards VIVOS (pending/answered) sempre +
 * terminais recentes (últimas 2h) pra UI mostrar "enviada ✅"/"expirou" antes
 * de sumirem. Nunca projeta o blob nem o endereço de volta (a view garante).
 */
export async function getPartnerPhotoQueue(ctx: PartnerContext): Promise<PartnerPhotoQueueItem[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const res = await client.query<PartnerPhotoQueueItem>(
      `SELECT id, tire_size, brand, note, status, was_late, has_photo, photo_count,
              expires_at, answered_at, created_at, customer_name
         FROM commerce.partner_photo_queue
        WHERE status IN ('pending', 'answered')
           OR created_at > now() - interval '2 hours'
        ORDER BY created_at DESC
        LIMIT 50`,
    );
    return res.rows;
  });
}

export interface AttachPartnerPhotoResult {
  status: 'ok' | 'not_found' | 'rejected';
  // Estado do pedido após a chamada (quando ok): answered/sent/cancelled...
  state?: string;
  was_late?: boolean;
  // false = no-op idempotente (duplo-clique/2 aparelhos: já tinha foto).
  attached?: boolean;
}

/**
 * Anexa a foto (já re-encodada pelo route — sempre image/jpeg) ao pedido, via
 * commerce.attach_partner_photo: FOR UPDATE + idempotência no banco. RLS faz
 * pedido de outra unidade parecer inexistente (não vaza existência).
 */
export async function attachPartnerPhoto(
  ctx: PartnerContext,
  photoRequestId: string,
  photo: { bytes: Buffer; mime: string; sizeBytes: number },
): Promise<AttachPartnerPhotoResult> {
  try {
    return await withPartnerContext(ctx.partnerUnitId, async (client) => {
      const res = await client.query<{ out_status: string; out_was_late: boolean; out_attached: boolean }>(
        'SELECT out_status, out_was_late, out_attached FROM commerce.attach_partner_photo($1, $2, $3, $4)',
        [photoRequestId, photo.bytes, photo.mime, photo.sizeBytes],
      );
      const row = res.rows[0];
      if (!row) return { status: 'not_found' };
      return { status: 'ok', state: row.out_status, was_late: row.out_was_late, attached: row.out_attached };
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    // 42501 = "nao encontrado (ou de outra unidade)" — RLS escondeu a linha.
    if (code === '42501') return { status: 'not_found' };
    // 23514 = bytes vazios/MIME fora da allowlist (não deve ocorrer pós re-encode).
    if (code === '23514') return { status: 'rejected' };
    throw err;
  }
}

/**
 * Bytes da foto pro painel exibir (preview no card + lightbox da separação).
 * RLS: só a foto da própria unidade. null = não existe/não é desta unidade.
 */
export async function getPartnerPhotoImage(
  ctx: PartnerContext,
  photoRequestId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    const res = await client.query<{ photo_bytes: Buffer; photo_mime: string }>(
      `SELECT photo_bytes, photo_mime
         FROM commerce.photo_request_blobs
        WHERE photo_request_id = $1
        ORDER BY created_at
        LIMIT 1`,
      [photoRequestId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { bytes: row.photo_bytes, mime: row.photo_mime };
  });
}
