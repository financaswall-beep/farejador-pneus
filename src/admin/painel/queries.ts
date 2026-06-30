import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { applyWholesaleStockDecrement } from './wholesale-stock.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyMatrizGalpaoDecrement } from '../../atendente-v2/wholesale-stock-read.js';

export type SourceTagChatwoot = 'chatwoot_com_bot' | 'chatwoot_sem_bot';
export type SourceTagWalkin = 'walkin_balcao' | 'walkin_telefone' | 'walkin_outro';

export interface RegisterManualOrderInput {
  environment?: 'prod' | 'test';
  contact_id?: string;
  conversation_id: string;
  draft_id?: string | null;
  unit_id?: string | null;
  items: Array<{
    product_id: string;
    quantity: number;
    unit_price: number;
    discount_amount?: number;
  }>;
  payment_method: string | null;
  fulfillment_mode: 'delivery' | 'pickup';
  delivery_address?: string | null;
  actor_label: string;
  idempotency_key: string;
  source_tag?: SourceTagChatwoot | null;
}

export interface RegisterWalkinOrderInput {
  environment?: 'prod' | 'test';
  customer_name?: string | null;
  customer_phone?: string | null;
  unit_id?: string | null;
  items: Array<{
    product_id: string;
    quantity: number;
    unit_price: number;
    discount_amount?: number;
  }>;
  payment_method: string | null;
  fulfillment_mode: 'delivery' | 'pickup';
  delivery_address?: string | null;
  actor_label: string;
  idempotency_key: string;
  source_tag: SourceTagWalkin;
}

export interface CancelManualOrderInput {
  order_id: string;
  actor_label: string;
  reason: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

export async function getPainelPedidos(limit?: number, dbPool: Pool = defaultPool): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT *
     FROM dashboard.pedidos_recentes
     WHERE environment = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [env.FAREJADOR_ENV, clampLimit(limit)],
  );
  return result.rows;
}

export async function getPainelProdutos(limit?: number, dbPool: Pool = defaultPool): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT product_id, product_code, product_name, product_type, brand,
            tire_size, tire_position, price_amount, currency,
            total_stock_available
     FROM commerce.product_full
     WHERE environment = $1
     ORDER BY total_stock_available DESC, price_amount NULLS LAST, product_name ASC
     LIMIT $2`,
    [env.FAREJADOR_ENV, clampLimit(limit)],
  );
  return result.rows;
}

export type PainelRedePeriod = 'today' | '7d' | '30d' | 'month';

/**
 * Timezone usado para janelas operacionais "Hoje/7d/30d/Mês" da matriz.
 * Hard-coded em America/Sao_Paulo porque a rede 2W opera no Brasil.
 * Quando precisar suportar parceiros em outros fusos, vira parametro por unidade.
 */
const PAINEL_TZ = 'America/Sao_Paulo';

/**
 * Calcula o inicio da janela do periodo NO BANCO usando AT TIME ZONE.
 *
 * Bug pre-correcao (S1 da auditoria 2026-05-21):
 *   resolveRedePeriodStart usava `new Date(now.getFullYear()...)` que pega
 *   o local time do processo Node. Em servidor UTC (Coolify default),
 *   o "hoje" cortava 3h antes do "hoje" do Brasil (BRT/UTC-3): apos 21h
 *   em SP, o filtro `today` ja virava o dia seguinte e mostrava 0.
 *
 * Correcao: gera expressao SQL que computa o inicio no fuso do Brasil,
 * passada como parametro $2 (timestamptz). Postgres faz a aritmetica.
 */
function resolveRedePeriodStartSql(period: PainelRedePeriod): string {
  // Expressao entre parenteses pra evitar conflito de precedencia com
  // casts (::date, ::timestamptz) na interpolacao downstream.
  if (period === 'today') {
    return `(date_trunc('day', now() AT TIME ZONE '${PAINEL_TZ}') AT TIME ZONE '${PAINEL_TZ}')`;
  }
  if (period === '7d') {
    return `((date_trunc('day', now() AT TIME ZONE '${PAINEL_TZ}') - INTERVAL '6 days') AT TIME ZONE '${PAINEL_TZ}')`;
  }
  if (period === '30d') {
    return `((date_trunc('day', now() AT TIME ZONE '${PAINEL_TZ}') - INTERVAL '29 days') AT TIME ZONE '${PAINEL_TZ}')`;
  }
  return `(date_trunc('month', now() AT TIME ZONE '${PAINEL_TZ}') AT TIME ZONE '${PAINEL_TZ}')`;
}

export async function getPainelRede(
  period: PainelRedePeriod = 'month',
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  // Computa janela do periodo direto no banco com AT TIME ZONE PAINEL_TZ.
  // Expressao e constante hard-coded (sem input de usuario) -> sem risco
  // de injection apesar de interpolada como string.
  const periodStartSql = resolveRedePeriodStartSql(period);
  const todayStartSql = `(date_trunc('day', now() AT TIME ZONE '${PAINEL_TZ}') AT TIME ZONE '${PAINEL_TZ}')`;
  // 0077: venda do parceiro SÓ "realiza" na entrega (delivery → delivered_at) ou no fechamento
  // no balcão (pickup → created_at). Pedido de entrega aberto/em separação NÃO é venda realizada
  // (mesma regra da view network.partner_unit_summary). Fragmentos reusados nos laterais de venda.
  // 0090: retirada reservada do bot (awaiting_pickup) ainda NÃO é venda; vira venda na retirada
  // (retrieved_at). Balcão segue por created_at. Mesma régua da view network.partner_unit_summary.
  const realizedWhere = `po.status <> 'cancelled' AND po.deleted_at IS NULL AND NOT (po.fulfillment_mode = 'delivery' AND po.delivery_status <> 'delivered') AND NOT po.awaiting_pickup`;
  const realizedDate = `(CASE WHEN po.fulfillment_mode = 'delivery' THEN po.delivered_at ELSE COALESCE(po.retrieved_at, po.created_at) END)`;
  // Pedido de ENTREGA ainda não entregue (ou retirada aguardando) NÃO é venda — no feed aparece com o status atual.
  const isRealizedExpr = `NOT (po.fulfillment_mode = 'delivery' AND po.delivery_status <> 'delivered') AND NOT po.awaiting_pickup`;
  // Data do evento no feed: venda realizada usa a data de realização; pedido em curso usa a criação.
  const eventDateExpr = `(CASE WHEN ${isRealizedExpr} THEN ${realizedDate} ELSE po.created_at END)`;
  const result = await dbPool.query(
    `SELECT
       s.environment,
       s.partner_unit_id,
       s.partner_id,
       s.unit_id,
       s.slug,
       s.display_name,
       s.partner_name,
       s.partner_status,
       s.unit_status,
       COALESCE(period_sales.sales_total, 0) AS sales_month,
       COALESCE(period_sales.orders_total, 0) AS orders_month,
       COALESCE(period_purchases.purchases_total, 0) AS purchases_month,
       COALESCE(employee_expenses.employee_total, 0) + COALESCE(other_expenses.other_total, 0) AS expenses_month,
       s.stock_items,
       s.low_stock_items,
       COALESCE(period_sales.sales_total, 0)
         - COALESCE(period_purchases.purchases_total, 0)
         - COALESCE(employee_expenses.employee_total, 0)
         - COALESCE(other_expenses.other_total, 0) AS estimated_result_month,
       p.document_number,
       p.responsible_name,
       p.whatsapp_phone,
       p.address,
       pu.service_mode,
       pu.delivery_radius_km,
       p.commercial_model,
       p.commission_percent,
       p.monthly_fee,
       COALESCE(employee_expenses.employee_total, 0) AS employee_total,
       COALESCE(other_expenses.other_total, 0) AS other_expenses_total,
       COALESCE(today_sales.sales_today, 0) AS sales_today,
       COALESCE(today_sales.orders_today, 0) AS orders_today,
       COALESCE(source_stats.orders_2w, 0) AS orders_2w,
       COALESCE(source_stats.sales_2w, 0) AS sales_2w,
       COALESCE(source_stats.orders_porta, 0) AS orders_porta,
       COALESCE(source_stats.sales_porta, 0) AS sales_porta,
       COALESCE(stock.stock_rows, '[]'::jsonb) AS stock_rows,
       COALESCE(recent_events.events, '[]'::jsonb) AS recent_events,
       COALESCE(top_items.items, '[]'::jsonb) AS top_items,
       COALESCE(sales_series.series, '[0,0,0,0,0,0,0]'::jsonb) AS sales_series,
       COALESCE(order_series.series, '[0,0,0,0,0,0,0]'::jsonb) AS order_series
     FROM network.partner_unit_summary s
     JOIN network.partners p
       ON p.id = s.partner_id AND p.environment = s.environment
     LEFT JOIN network.partner_units pu
       ON pu.id = s.partner_unit_id AND pu.environment = s.environment
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(amount), 0) AS employee_total
       FROM finance.partner_expenses pe
       WHERE pe.environment = s.environment
         AND pe.unit_id = s.unit_id
         AND pe.category = 'employee_payment'
          AND pe.expense_date >= ${periodStartSql}::date
         AND pe.deleted_at IS NULL
     ) employee_expenses ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(amount), 0) AS other_total
       FROM finance.partner_expenses pe
       WHERE pe.environment = s.environment
         AND pe.unit_id = s.unit_id
         AND pe.category <> 'employee_payment'
         AND pe.expense_date >= ${periodStartSql}::date
         AND pe.deleted_at IS NULL
     ) other_expenses ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(total_amount), 0) AS sales_total,
              count(*)::int AS orders_total
       FROM commerce.partner_orders po
       WHERE po.environment = s.environment
         AND po.unit_id = s.unit_id
         AND ${realizedWhere}
         AND ${realizedDate} >= ${periodStartSql}::timestamptz
     ) period_sales ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(total_amount), 0) AS purchases_total
       FROM commerce.partner_purchases pp
       WHERE pp.environment = s.environment
         AND pp.unit_id = s.unit_id
         AND pp.deleted_at IS NULL
         AND pp.purchased_at >= ${periodStartSql}::timestamptz
     ) period_purchases ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(total_amount), 0) AS sales_today,
              count(*)::int AS orders_today
       FROM commerce.partner_orders po
       WHERE po.environment = s.environment
         AND po.unit_id = s.unit_id
         AND ${realizedWhere}
         AND ${realizedDate} >= ${todayStartSql}
     ) today_sales ON true
     LEFT JOIN LATERAL (
       SELECT
         count(*) FILTER (WHERE po.source_tag = '2w')::int AS orders_2w,
         COALESCE(sum(po.total_amount) FILTER (WHERE po.source_tag = '2w'), 0) AS sales_2w,
         count(*) FILTER (
           WHERE COALESCE(po.source_tag, 'porta') IN ('porta', 'walkin_balcao', 'walkin_telefone', 'walkin_outro', 'outro')
         )::int AS orders_porta,
         COALESCE(sum(po.total_amount) FILTER (
           WHERE COALESCE(po.source_tag, 'porta') IN ('porta', 'walkin_balcao', 'walkin_telefone', 'walkin_outro', 'outro')
         ), 0) AS sales_porta
       FROM commerce.partner_orders po
       WHERE po.environment = s.environment
         AND po.unit_id = s.unit_id
         AND ${realizedWhere}
         AND ${realizedDate} >= ${periodStartSql}::timestamptz
     ) source_stats ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'id', ps.id,
         'item_name', ps.item_name,
         'quantity_on_hand', ps.quantity_on_hand,
         'minimum_quantity', ps.minimum_quantity,
         'supplier_name', ps.supplier_name,
         'average_cost', ps.average_cost,
         'sale_price', ps.sale_price,
         'stock_status', ps.stock_status,
         'is_tracked', ps.is_tracked,
         'tire_size', ps.tire_size,
         'brand', ps.brand,
         'updated_at', ps.updated_at
       ) ORDER BY ps.item_name) AS stock_rows
       FROM commerce.partner_stock_levels ps
       WHERE ps.environment = s.environment
         AND ps.unit_id = s.unit_id
         AND ps.deleted_at IS NULL
     ) stock ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(event ORDER BY event_at DESC) AS events
       FROM (
         SELECT ${eventDateExpr} AS event_at,
                jsonb_build_object(
                  'type', CASE
                    WHEN ${isRealizedExpr} THEN 'Venda'
                    WHEN po.delivery_status = 'pending' THEN 'Pedido · Em separação'
                    WHEN po.delivery_status = 'dispatched' THEN 'Pedido · Saiu pra entrega'
                    WHEN po.delivery_status = 'failed' THEN 'Pedido · Entrega falhou'
                    ELSE 'Pedido'
                  END,
                  'event_at', ${eventDateExpr},
                  'description', COALESCE(po.customer_name, 'Cliente') || ' - pedido',
                  'amount', po.total_amount
                ) AS event
         FROM commerce.partner_orders po
         WHERE po.environment = s.environment
            AND po.unit_id = s.unit_id
            AND po.status <> 'cancelled'
            AND po.deleted_at IS NULL
            AND po.created_at >= ${periodStartSql}::timestamptz
          UNION ALL
         SELECT pp.purchased_at AS event_at,
                jsonb_build_object(
                  'type', 'Compra pneus',
                  'event_at', pp.purchased_at,
                  'description', COALESCE(pp.supplier_name, 'Compra de pneus'),
                  'amount', -pp.total_amount
                ) AS event
         FROM commerce.partner_purchases pp
          WHERE pp.environment = s.environment
            AND pp.unit_id = s.unit_id
            AND pp.deleted_at IS NULL
            AND pp.purchased_at >= ${periodStartSql}::timestamptz
          UNION ALL
         SELECT pe.created_at AS event_at,
                jsonb_build_object(
                  'type', CASE WHEN pe.category = 'employee_payment' THEN 'Pagamento funcionario' ELSE 'Despesa extra' END,
                  'event_at', pe.created_at,
                  'description', pe.description,
                  'amount', -pe.amount
                ) AS event
         FROM finance.partner_expenses pe
          WHERE pe.environment = s.environment
            AND pe.unit_id = s.unit_id
            AND pe.deleted_at IS NULL
            AND pe.created_at >= ${periodStartSql}::timestamptz
         ORDER BY event_at DESC
         LIMIT 30
       ) unioned
     ) recent_events ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('label', label, 'quantity', qty) ORDER BY qty DESC) AS items
       FROM (
         SELECT COALESCE(ps.tire_size, ps.item_name, poi.partner_stock_id::text) AS label,
                sum(poi.quantity)::int AS qty
         FROM commerce.partner_order_items poi
         JOIN commerce.partner_orders po
           ON po.id = poi.order_id AND po.environment = poi.environment
         LEFT JOIN commerce.partner_stock_levels ps
           ON ps.id = poi.partner_stock_id AND ps.environment = poi.environment
         WHERE po.environment = s.environment
            AND po.unit_id = s.unit_id
            AND ${realizedWhere}
            AND ${realizedDate} >= ${periodStartSql}::timestamptz
         GROUP BY COALESCE(ps.tire_size, ps.item_name, poi.partner_stock_id::text)
         ORDER BY qty DESC
         LIMIT 5
       ) top_query
     ) top_items ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(COALESCE(day_sales.total, 0) ORDER BY day_ref.day)::jsonb AS series
       FROM generate_series(
         date_trunc('day', ${periodStartSql}::timestamptz),
         date_trunc('day', now()),
         interval '1 day'
       ) AS day_ref(day)
       LEFT JOIN LATERAL (
         SELECT sum(po.total_amount)::numeric AS total
         FROM commerce.partner_orders po
         WHERE po.environment = s.environment
           AND po.unit_id = s.unit_id
           AND ${realizedWhere}
           AND ${realizedDate} >= day_ref.day
           AND ${realizedDate} < day_ref.day + interval '1 day'
       ) day_sales ON true
     ) sales_series ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(COALESCE(day_orders.total, 0) ORDER BY day_ref.day)::jsonb AS series
       FROM generate_series(
         date_trunc('day', ${periodStartSql}::timestamptz),
         date_trunc('day', now()),
         interval '1 day'
       ) AS day_ref(day)
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS total
         FROM commerce.partner_orders po
         WHERE po.environment = s.environment
           AND po.unit_id = s.unit_id
           AND ${realizedWhere}
           AND ${realizedDate} >= day_ref.day
           AND ${realizedDate} < day_ref.day + interval '1 day'
       ) day_orders ON true
     ) order_series ON true
     WHERE s.environment = $1
     ORDER BY sales_month DESC, s.display_name ASC`,
    [env.FAREJADOR_ENV],
  );
  return result.rows;
}

export interface RedeFunnelRow {
  municipio: string;
  unit_id: string | null;
  tentou: number;
  pediu: number;
  efetivou: number;
}

/**
 * Funil de conversão da REDE por município (Analytics da Rede v1) — desempenho do BOT
 * na área de cada parceiro:
 *   - tentou:   conversas em que o bot OFERTOU entrega na região (fact `municipio_entrega`);
 *   - pediu:    dessas, quantas viraram pedido DO PARCEIRO (espelho com `partner_order_id`);
 *   - efetivou: desses, quantos foram ENTREGUES (`delivery_status='delivered'`).
 * `unit_id` = unidade parceira que atende o município (v1: 1 parceiro/município, derivado
 * dos pedidos existentes; vira `network.unit_coverage` quando houver vários). Só leitura.
 */
export async function getRedeFunnel(dbPool: Pool = defaultPool): Promise<RedeFunnelRow[]> {
  const result = await dbPool.query(
    `WITH conv AS (
       SELECT cf.conversation_id,
              replace(max(cf.fact_value::text) FILTER (WHERE cf.fact_key = 'municipio_entrega'), '"', '') AS municipio
       FROM analytics.conversation_facts cf
       WHERE cf.environment = $1
       GROUP BY cf.conversation_id
     )
     SELECT c.municipio,
            max(po.unit_id::text) AS unit_id,
            count(DISTINCT c.conversation_id)::int AS tentou,
            count(DISTINCT c.conversation_id) FILTER (WHERE o.partner_order_id IS NOT NULL)::int AS pediu,
            count(DISTINCT c.conversation_id) FILTER (WHERE po.delivery_status = 'delivered')::int AS efetivou
     FROM conv c
     LEFT JOIN commerce.orders o
       ON o.source_conversation_id = c.conversation_id
      AND o.environment = $1
      AND o.partner_order_id IS NOT NULL
     LEFT JOIN commerce.partner_orders po ON po.id = o.partner_order_id
     WHERE c.municipio IS NOT NULL
     GROUP BY c.municipio
     ORDER BY tentou DESC`,
    [env.FAREJADOR_ENV],
  );
  return result.rows as RedeFunnelRow[];
}

export interface MatrizResumo {
  metrics: Record<string, unknown> | null;
  series: unknown[];
  leads: unknown[];
}

/**
 * Resumo do dono (cockpit da matriz): performance do BOT/tráfego + leads a recuperar.
 * LÊ (read-only) das views derivadas do V2 — nunca escreve em analytics/agent/core.
 * Distinto da aba Rede (que é operação dos parceiros). Janela: today/7d/30d/month.
 *
 * Defensivo por bloco: se uma view faltar/quebrar, devolve o bloco vazio em vez
 * de derrubar o endpoint inteiro.
 */
export async function getMatrizResumo(
  period: PainelRedePeriod = '7d',
  dbPool: Pool = defaultPool,
): Promise<MatrizResumo> {
  // Janela por `dia` (date). Expressao constante (sem input) -> sem injection.
  const sinceSql =
    period === 'today' ? `current_date`
    : period === '7d' ? `(current_date - 6)`
    : period === '30d' ? `(current_date - 29)`
    : `date_trunc('month', current_date)::date`;

  let metrics: Record<string, unknown> | null = null;
  let series: unknown[] = [];
  let leads: unknown[] = [];

  try {
    const r = await dbPool.query(
      `SELECT
         COALESCE(sum(conversas_total), 0)::int AS conversas,
         COALESCE(sum(fecharam), 0)::int AS fecharam,
         COALESCE(sum(escalaram), 0)::int AS escalaram,
         COALESCE(sum(abandonaram), 0)::int AS abandonaram,
         COALESCE(sum(faturamento), 0)::numeric AS faturamento,
         COALESCE(sum(custo_bot_brl), 0)::numeric AS custo_bot,
         CASE WHEN sum(conversas_total) > 0
              THEN round(100.0 * sum(fecharam) / sum(conversas_total), 1)
              ELSE 0 END AS taxa_conversao,
         CASE WHEN sum(fecharam) > 0
              THEN round(sum(faturamento) / sum(fecharam), 2)
              ELSE 0 END AS ticket_medio
       FROM analytics.v_daily_metrics
       WHERE dia >= ${sinceSql}`,
    );
    metrics = r.rows[0] ?? null;
  } catch { /* bloco vazio se a view faltar */ }

  try {
    const r = await dbPool.query(
      `SELECT dia,
              conversas_total::int AS conversas,
              fecharam::int AS fecharam,
              faturamento::numeric AS faturamento,
              custo_bot_brl::numeric AS custo_bot
       FROM analytics.v_daily_metrics
       WHERE dia >= ${sinceSql}
       ORDER BY dia`,
    );
    series = r.rows;
  } catch { /* bloco vazio */ }

  try {
    const r = await dbPool.query(
      `SELECT cliente_nome, cliente_telefone, moto, bairro, ultimo_preco_cotado,
              etapa_atingida, provavel_motivo, horas_sem_resposta::numeric AS horas,
              reclamou_preco, mencionou_concorrente
       FROM analytics.v_clientes_pra_recuperar
       ORDER BY started_at DESC NULLS LAST
       LIMIT 12`,
    );
    leads = r.rows;
  } catch { /* bloco vazio */ }

  return { metrics, series, leads };
}

async function resolveContactId(
  dbPool: Pool,
  environment: 'prod' | 'test',
  conversationId: string,
  contactId?: string,
): Promise<string> {
  if (contactId) return contactId;

  const result = await dbPool.query<{ contact_id: string | null }>(
    `SELECT contact_id
     FROM core.conversations
     WHERE environment = $1 AND id = $2`,
    [environment, conversationId],
  );

  const resolved = result.rows[0]?.contact_id;
  if (!resolved) {
    throw new Error('conversation_contact_not_found');
  }

  return resolved;
}

/**
 * Define o raio de ENTREGA (km) de um parceiro pela MATRIZ (proximidade-primeiro
 * Fase 2 — Wallace preenche o raio dos parceiros de uma vez). Grava
 * network.partner_units.delivery_radius_km.
 *
 * Respeita a autonomia do parceiro: a matriz só PREENCHE o raio de quem JÁ faz
 * entrega (service_mode delivery/both) — não força entrega em quem escolheu só
 * retirada. LIMPAR (null) é sempre permitido. NUMERIC(6,2) → o route valida ≤9999,99.
 */
export async function setPartnerUnitDeliveryRadius(
  environment: 'prod' | 'test',
  partnerUnitId: string,
  deliveryRadiusKm: number | null,
  dbPool: Pool = defaultPool,
): Promise<{ updated: boolean; reason?: 'not_found' | 'pickup_only' }> {
  const unit = await dbPool.query<{ service_mode: string }>(
    `SELECT service_mode FROM network.partner_units
      WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
    [partnerUnitId, environment],
  );
  if (unit.rowCount !== 1) return { updated: false, reason: 'not_found' };
  const mode = unit.rows[0]!.service_mode;
  if (deliveryRadiusKm !== null && mode !== 'delivery' && mode !== 'both') {
    return { updated: false, reason: 'pickup_only' };
  }
  const res = await dbPool.query(
    `UPDATE network.partner_units
        SET delivery_radius_km = $3
      WHERE id = $1 AND environment = $2`,
    [partnerUnitId, environment, deliveryRadiusKm],
  );
  return { updated: (res.rowCount ?? 0) > 0 };
}

export async function registerManualOrder(
  input: RegisterManualOrderInput,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const contactId = await resolveContactId(dbPool, environment, input.conversation_id, input.contact_id);

  const result = await dbPool.query<{ order_id: string }>(
    `SELECT commerce.register_manual_order(
       $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12
     ) AS order_id`,
    [
      environment,
      contactId,
      input.conversation_id,
      input.draft_id ?? null,
      input.unit_id ?? null,
      JSON.stringify(input.items),
      input.payment_method,
      input.fulfillment_mode,
      input.delivery_address ?? null,
      input.actor_label,
      input.idempotency_key,
      input.source_tag ?? null,
    ],
  );

  return { order_id: result.rows[0]!.order_id };
}

export async function registerWalkinOrder(
  input: RegisterWalkinOrderInput,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;

  // S4 da auditoria 2026-05-21: normaliza telefone pra E.164 antes de gravar.
  const normalizedPhone = normalizeBrazilianPhone(input.customer_phone);
  const result = await dbPool.query<{ order_id: string }>(
    `SELECT commerce.register_walkin_order(
       $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11
     ) AS order_id`,
    [
      environment,
      input.customer_name ?? null,
      normalizedPhone,
      input.unit_id ?? null,
      JSON.stringify(input.items),
      input.payment_method,
      input.fulfillment_mode,
      input.delivery_address ?? null,
      input.actor_label,
      input.idempotency_key,
      input.source_tag,
    ],
  );
  const orderId = result.rows[0]!.order_id;

  // Balcão da MATRIZ vende do GALPÃO → abate o estoque (commerce.wholesale_stock). Best-effort
  // FORA da transação SQL (a venda já commitou; a baixa tem clamp em 0 e NUNCA trava). SÓ quando
  // a unit é a matriz (slug='main'; null no balcão = matriz). Atrás da flag WHOLESALE_MATRIZ_DECREMENT.
  if (env.WHOLESALE_MATRIZ_DECREMENT) {
    const m = await dbPool.query<{ id: string }>(
      `SELECT id FROM core.units WHERE environment = $1 AND slug = 'main' LIMIT 1`,
      [environment],
    );
    const matrizId = m.rows[0]?.id ?? null;
    if (matrizId && (!input.unit_id || input.unit_id === matrizId)) {
      await applyMatrizGalpaoDecrement(
        dbPool as unknown as PoolClient,
        environment,
        input.items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
        true,
      );
    }
  }

  return { order_id: orderId };
}

export async function cancelManualOrder(
  input: CancelManualOrderInput,
  dbPool: Pool = defaultPool,
): Promise<{ cancelled: true }> {
  await dbPool.query('SELECT commerce.cancel_manual_order($1, $2, $3)', [
    input.order_id,
    input.actor_label,
    input.reason,
  ]);

  return { cancelled: true };
}

// ─── Onboarding de parceiro (Etapa 1) ────────────────────────────────────────
export interface CreatePartnerInput {
  environment?: 'prod' | 'test';
  trade_name: string;                 // nome fantasia (obrigatório)
  legal_name?: string | null;
  document_number?: string | null;
  responsible_name?: string | null;
  whatsapp_phone?: string | null;
  email?: string | null;
  address?: string | null;
  commercial_model?: string | null;   // termos comerciais: definidos pela matriz na criação/aprovação
  commission_percent?: number | null;
  monthly_fee?: number | null;
  municipios: string[];               // cobertura — cidades que o parceiro atende
  slug?: string | null;               // opcional; se vazio, gerado do trade_name
  actor_label: string;
}

export interface CreatePartnerResult {
  already_exists: boolean;
  partner_id?: string;
  unit_id?: string;
  partner_unit_id?: string;
  slug?: string;
  token?: string;                     // texto puro, UMA vez (só quando criado de fato)
}

function slugify(s: string): string {
  return (s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeMunicipio(s: string): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

/**
 * Cria um parceiro completo (Etapa 1 do onboarding) numa transação: unidade (core.units)
 * + parceiro (network.partners) + vínculo (network.partner_units) + LOGIN (token, role=owner)
 * + cobertura (network.unit_coverage). Em TS com a conexão privilegiada do backend —
 * sem SECURITY DEFINER (evita o footgun; a função vive atrás do endpoint admin).
 *
 * Ajustes de revisão (Codex 2026-06-04):
 *  - token NÃO é recuperável: só o hash fica no banco. Slug explícito que já existe →
 *    `already_exists: true` (não duplica, não finge devolver token). Reemitir token = ação à parte.
 *  - slug auto-gerado resolve colisão com sufixo numérico.
 */
export async function createPartnerUnit(
  input: CreatePartnerInput,
  dbPool: Pool = defaultPool,
): Promise<CreatePartnerResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const baseSlug = slugify(input.slug || input.trade_name);
  if (!baseSlug) throw new Error('trade_name_or_slug_required');
  const explicitSlug = !!input.slug;

  const client: PoolClient = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const slugExists = async (s: string): Promise<boolean> => {
      const r = await client.query(
        `SELECT 1 FROM network.partner_units WHERE environment = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
        [environment, s],
      );
      return (r.rowCount ?? 0) > 0;
    };

    let slug = baseSlug;
    if (await slugExists(slug)) {
      if (explicitSlug) {
        await client.query('ROLLBACK');
        return { already_exists: true, slug };
      }
      let n = 2;
      while (await slugExists(`${baseSlug}-${n}`)) n += 1;
      slug = `${baseSlug}-${n}`;
    }

    const unitRes = await client.query<{ id: string }>(
      `INSERT INTO core.units (environment, slug, name, address, phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [environment, slug, input.trade_name, input.address ?? null, input.whatsapp_phone ?? null],
    );
    const unitId = unitRes.rows[0]!.id;

    const partnerRes = await client.query<{ id: string }>(
      `INSERT INTO network.partners
         (environment, legal_name, trade_name, document_number, responsible_name,
          whatsapp_phone, email, address, status, commercial_model, commission_percent, monthly_fee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11) RETURNING id`,
      [
        environment, input.legal_name ?? input.trade_name, input.trade_name,
        input.document_number ?? null, input.responsible_name ?? null,
        input.whatsapp_phone ?? null, input.email ?? null, input.address ?? null,
        input.commercial_model ?? 'commission', input.commission_percent ?? null, input.monthly_fee ?? null,
      ],
    );
    const partnerId = partnerRes.rows[0]!.id;

    const puRes = await client.query<{ id: string }>(
      `INSERT INTO network.partner_units
         (environment, partner_id, unit_id, slug, display_name, address, phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING id`,
      [environment, partnerId, unitId, slug, input.trade_name, input.address ?? null, input.whatsapp_phone ?? null],
    );
    const partnerUnitId = puRes.rows[0]!.id;

    // Login do dono: token em texto só agora; banco guarda só o hash. role='owner'.
    const token = randomBytes(32).toString('hex');
    await client.query(
      `INSERT INTO network.partner_access_tokens
         (environment, partner_unit_id, token_hash, label, created_by, role)
       VALUES ($1, $2, network.hash_partner_token($3), $4, $5, 'owner')`,
      [environment, partnerUnitId, token, `cadastro_${new Date().toISOString().slice(0, 10)}`, input.actor_label],
    );

    for (const m of input.municipios) {
      const mn = normalizeMunicipio(m);
      if (!mn) continue;
      await client.query(
        // ON CONFLICT casa com o índice funcional de 4 colunas da 0087
        // (environment, unit_id, municipio, coalesce(neighborhood_canonical,'')).
        // Cadastro insere cobertura de cidade inteira (bairro NULL → coalesce '').
        `INSERT INTO network.unit_coverage (environment, unit_id, municipio)
         VALUES ($1, $2, $3)
         ON CONFLICT (environment, unit_id, municipio, coalesce(neighborhood_canonical, '')) DO NOTHING`,
        [environment, unitId, mn],
      );
    }

    await client.query('COMMIT');
    return {
      already_exists: false,
      partner_id: partnerId,
      unit_id: unitId,
      partner_unit_id: partnerUnitId,
      slug,
      token,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Candidaturas de parceiro (Etapa 3 — funil de recrutamento) ───────────────
export interface PartnerApplicationInput {
  environment?: 'prod' | 'test';
  trade_name: string;
  responsible_name?: string | null;
  whatsapp_phone?: string | null;
  email?: string | null;
  address?: string | null;
  municipios?: string | null;
  message?: string | null;
}

/** Insere uma candidatura pública (status=pending). Sem auth — vem do formulário público. */
export async function createPartnerApplication(
  input: PartnerApplicationInput,
  dbPool: Pool = defaultPool,
): Promise<{ id: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query<{ id: string }>(
    `INSERT INTO network.partner_applications
       (environment, trade_name, responsible_name, whatsapp_phone, email, address, municipios, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      environment, input.trade_name.trim(),
      input.responsible_name?.trim() || null, input.whatsapp_phone?.trim() || null,
      input.email?.trim() || null, input.address?.trim() || null,
      input.municipios?.trim() || null, input.message?.trim() || null,
    ],
  );
  return { id: r.rows[0]!.id };
}

/** Lista candidaturas pra fila da matriz (default: só pendentes). */
export async function listPartnerApplications(
  status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending',
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const r = await dbPool.query(
    `SELECT id, trade_name, responsible_name, whatsapp_phone, email, address, municipios, message,
            status, created_at, reviewed_by, reviewed_at, review_notes, created_partner_unit_id
     FROM network.partner_applications
     WHERE environment = $1 AND ($2 = 'all' OR status = $2)
     ORDER BY created_at DESC LIMIT 100`,
    [env.FAREJADOR_ENV, status],
  );
  return r.rows;
}

export interface ApproveApplicationInput {
  application_id: string;
  actor_label: string;
  municipios: string[];                 // cobertura REAL definida pelo dono na aprovação
  commission_percent?: number | null;   // termos comerciais: definidos pelo dono aqui
  monthly_fee?: number | null;
  commercial_model?: string | null;
  slug?: string | null;
}

/** Aprova: cria o parceiro (reusa createPartnerUnit) e marca a candidatura como approved. */
export async function approvePartnerApplication(
  input: ApproveApplicationInput,
  dbPool: Pool = defaultPool,
): Promise<CreatePartnerResult & { application_id: string }> {
  const appRes = await dbPool.query<{
    environment: 'prod' | 'test'; trade_name: string; responsible_name: string | null;
    whatsapp_phone: string | null; email: string | null; address: string | null; status: string;
  }>(
    `SELECT environment, trade_name, responsible_name, whatsapp_phone, email, address, status
     FROM network.partner_applications WHERE id = $1 AND environment = $2`,
    [input.application_id, env.FAREJADOR_ENV],
  );
  const app = appRes.rows[0];
  if (!app) throw new Error('application_not_found');
  if (app.status !== 'pending') throw new Error('application_not_pending');

  const created = await createPartnerUnit({
    environment: app.environment,
    trade_name: app.trade_name,
    responsible_name: app.responsible_name,
    whatsapp_phone: app.whatsapp_phone,
    email: app.email,
    address: app.address,
    commission_percent: input.commission_percent ?? null,
    monthly_fee: input.monthly_fee ?? null,
    commercial_model: input.commercial_model ?? null,
    municipios: input.municipios,
    slug: input.slug ?? null,
    actor_label: input.actor_label,
  }, dbPool);

  if (!created.already_exists) {
    await dbPool.query(
      `UPDATE network.partner_applications
       SET status='approved', reviewed_by=$1, reviewed_at=now(), created_partner_unit_id=$2
       WHERE id=$3`,
      [input.actor_label, created.partner_unit_id ?? null, input.application_id],
    );
  }
  return { ...created, application_id: input.application_id };
}

/** Recusa uma candidatura pendente. */
export async function rejectPartnerApplication(
  applicationId: string,
  actorLabel: string,
  notes: string | null,
  dbPool: Pool = defaultPool,
): Promise<{ rejected: boolean }> {
  const r = await dbPool.query(
    `UPDATE network.partner_applications
     SET status='rejected', reviewed_by=$1, reviewed_at=now(), review_notes=$2
     WHERE id=$3 AND environment=$4 AND status='pending'`,
    [actorLabel, notes, applicationId, env.FAREJADOR_ENV],
  );
  return { rejected: (r.rowCount ?? 0) > 0 };
}

// ─── ATACADO (Fase 1): venda de atacado da Matriz + ranking de recompra ───────
// Dado SÓ da matriz (migration 0110): a matriz conecta como owner (defaultPool),
// sem grant pro parceiro. Comprador = parceiro da rede (partner_id) OU só-atacado
// (cadastro leve nome+telefone). Preço DIGITADO por venda. NÃO mexe em estoque/financeiro.

export interface WholesaleBuyerRow {
  customer_id: string | null; // ficha já existente (null = parceiro ainda sem ficha)
  partner_id: string | null;  // se é parceiro da rede
  name: string;
  phone: string | null;
  is_partner: boolean;
}

/** Compradores selecionáveis no formulário "Nova venda de atacado": fichas já
 *  criadas + parceiros ativos que ainda não têm ficha (aparecem automático — sacada
 *  do dono: cadastrou parceiro → já dá pra vender pra ele no atacado). */
export async function listWholesaleBuyers(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleBuyerRow[]> {
  const r = await dbPool.query<WholesaleBuyerRow>(
    `SELECT id AS customer_id, partner_id, name, phone, (partner_id IS NOT NULL) AS is_partner
       FROM commerce.wholesale_customers
      WHERE environment = $1 AND deleted_at IS NULL
     UNION ALL
     SELECT NULL::uuid AS customer_id, p.id AS partner_id, p.trade_name AS name,
            p.whatsapp_phone AS phone, true AS is_partner
       FROM network.partners p
      WHERE p.environment = $1 AND p.deleted_at IS NULL AND p.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM commerce.wholesale_customers wc
           WHERE wc.environment = p.environment AND wc.partner_id = p.id AND wc.deleted_at IS NULL)
     ORDER BY name`,
    [environment],
  );
  return r.rows;
}

/** Ranking de recompra: quem compra mais, quanto, última compra, dias parado.
 *  Inclui parceiros que NUNCA compraram (zerados) pra o dono ver quem está na rede
 *  mas não recompra. O alerta "sumiu"/"nunca comprou" é renderizado no app. */
export async function getWholesaleRanking(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const r = await dbPool.query(
    `SELECT buyer_id, partner_id, name, phone, is_partner,
            orders_count, total_bought, last_purchase_at, days_since_last
       FROM commerce.wholesale_buyer_summary
      WHERE environment = $1
     UNION ALL
     SELECT NULL::uuid, p.id, p.trade_name, p.whatsapp_phone, true,
            0, 0::numeric, NULL::timestamptz, NULL::int
       FROM network.partners p
      WHERE p.environment = $1 AND p.deleted_at IS NULL AND p.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM commerce.wholesale_customers wc
           WHERE wc.environment = p.environment AND wc.partner_id = p.id AND wc.deleted_at IS NULL)
     ORDER BY total_bought DESC, last_purchase_at DESC NULLS LAST, name`,
    [environment],
  );
  return r.rows;
}

export interface RegisterWholesaleSaleInput {
  environment?: 'prod' | 'test';
  customer_id?: string | null;     // ficha existente
  partner_id?: string | null;      // parceiro da rede (acha/cria a ficha)
  new_customer?: { name: string; phone?: string | null } | null; // só-atacado novo
  items: Array<{ measure: string; brand?: string | null; quantity: number; unit_price: number }>;
  sold_at?: string | null;
  notes?: string | null;
  created_by: string;
}

export interface RegisterWholesaleSaleResult {
  order_id: string;
  buyer_id: string;
  buyer_name: string;
  total_amount: string;
  items_count: number;
}

/** Registra uma venda de atacado (comprador + pneus + preço digitado). Transacional:
 *  resolve/cria a ficha do comprador → cria a venda → itens → grava o total (passo
 *  SEPARADO, não CTE — pra o UPDATE enxergar os itens recém-inseridos). */
export async function registerWholesaleSale(
  input: RegisterWholesaleSaleInput,
  dbPool: Pool = defaultPool,
): Promise<RegisterWholesaleSaleResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  if (!input.items || input.items.length === 0) throw new Error('items_required');

  const client: PoolClient = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Resolve o comprador (buyer_id) + nome pra devolver.
    let buyerId: string;
    let buyerName: string;
    if (input.customer_id) {
      const r = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM commerce.wholesale_customers
          WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
        [input.customer_id, environment],
      );
      if (!r.rows[0]) throw new Error('buyer_not_found');
      buyerId = r.rows[0].id;
      buyerName = r.rows[0].name;
    } else if (input.partner_id) {
      // Parceiro: acha a ficha; se não tem, cria (espelha trade_name/whatsapp).
      const found = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM commerce.wholesale_customers
          WHERE environment = $1 AND partner_id = $2 AND deleted_at IS NULL`,
        [environment, input.partner_id],
      );
      if (found.rows[0]) {
        buyerId = found.rows[0].id;
        buyerName = found.rows[0].name;
      } else {
        const p = await client.query<{ trade_name: string; whatsapp_phone: string | null }>(
          `SELECT trade_name, whatsapp_phone FROM network.partners
            WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
          [input.partner_id, environment],
        );
        if (!p.rows[0]) throw new Error('partner_not_found');
        const ins = await client.query<{ id: string; name: string }>(
          `INSERT INTO commerce.wholesale_customers (environment, partner_id, name, phone)
           VALUES ($1, $2, $3, $4) RETURNING id, name`,
          [environment, input.partner_id, p.rows[0].trade_name, p.rows[0].whatsapp_phone],
        );
        buyerId = ins.rows[0]!.id;
        buyerName = ins.rows[0]!.name;
      }
    } else if (input.new_customer && input.new_customer.name.trim()) {
      const ins = await client.query<{ id: string; name: string }>(
        `INSERT INTO commerce.wholesale_customers (environment, name, phone)
         VALUES ($1, $2, $3) RETURNING id, name`,
        [
          environment,
          input.new_customer.name.trim(),
          input.new_customer.phone ? normalizeBrazilianPhone(input.new_customer.phone) : null,
        ],
      );
      buyerId = ins.rows[0]!.id;
      buyerName = ins.rows[0]!.name;
    } else {
      throw new Error('buyer_required');
    }

    // 2. Cabeçalho da venda.
    const ord = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_orders (environment, buyer_id, sold_at, total_amount, created_by, notes)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), 0, $4, $5) RETURNING id`,
      [environment, buyerId, input.sold_at ?? null, input.created_by, input.notes ?? null],
    );
    const orderId = ord.rows[0]!.id;

    // 3. Itens (preço digitado; line_total e line_profit gerados pelo banco). O CUSTO é
    //    CONGELADO: snapshot do unit_cost do estoque da medida no momento da venda (Fase 3).
    //    Buscado à PARTE (não como subquery no INSERT — reutilizar $1 env_t lá dava 42P08).
    for (const it of input.items) {
      const m = it.measure.trim();
      const costRow = await client.query<{ unit_cost: string }>(
        `SELECT unit_cost FROM commerce.wholesale_stock
          WHERE environment = $1 AND measure = $2 LIMIT 1`,
        [environment, m],
      );
      const unitCost = costRow.rows[0]?.unit_cost ?? 0;
      await client.query(
        `INSERT INTO commerce.wholesale_order_items (environment, order_id, measure, brand, quantity, unit_price, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [environment, orderId, m, it.brand ?? null, it.quantity, it.unit_price, unitCost],
      );
    }

    // 3b. BAIXA no estoque do galpão por medida (Fase 2b) — atrás de flag, mesma transação.
    await applyWholesaleStockDecrement(client, environment, input.items, env.WHOLESALE_STOCK_DECREMENT);

    // 4. Grava o total (passo SEPARADO — enxerga os itens recém-inseridos).
    const tot = await client.query<{ total_amount: string }>(
      `UPDATE commerce.wholesale_orders
          SET total_amount = COALESCE(
            (SELECT sum(line_total) FROM commerce.wholesale_order_items WHERE order_id = $1), 0)
        WHERE id = $1 RETURNING total_amount`,
      [orderId],
    );

    await client.query('COMMIT');
    return {
      order_id: orderId,
      buyer_id: buyerId,
      buyer_name: buyerName,
      total_amount: tot.rows[0]!.total_amount,
      items_count: input.items.length,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── ATACADO (Fase 2): estoque do galpão por MEDIDA (pneu usado) ──────────────
// O dono controla o galpão por medida simples (ex.: '90/90-18' = 15 un.), SEPARADO
// do estoque do varejo (commerce.stock_levels). Tabela commerce.wholesale_stock (0111),
// dado SÓ da matriz (sem grant pro parceiro). Leitura/escrita aqui; a BAIXA na venda
// é plugada em registerWholesaleSale atrás de flag (Fase 2b).

export interface WholesaleStockRow {
  measure: string;
  quantity_on_hand: number;
  unit_cost: number;
  notes: string | null;
  updated_at: string;
  tire_width_mm: number | null;
  tire_aspect_ratio: number | null;
  tire_rim_diameter: number | null;
}

/** Lista o estoque do galpão (uma linha por medida), ordenado pela medida. */
export async function listWholesaleStock(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleStockRow[]> {
  const r = await dbPool.query<WholesaleStockRow>(
    `SELECT measure, quantity_on_hand, unit_cost, notes, updated_at,
            tire_width_mm, tire_aspect_ratio, tire_rim_diameter
       FROM commerce.wholesale_stock
      WHERE environment = $1
      ORDER BY measure`,
    [environment],
  );
  return r.rows;
}

/** Define quantidade + custo unitário de uma medida (upsert por medida). qty/custo >= 0. */
export async function setWholesaleStock(
  input: { measure: string; quantity_on_hand: number; unit_cost?: number; notes?: string | null; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<WholesaleStockRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const raw = input.measure.trim();
  if (!raw) throw new Error('measure_required');
  if (!Number.isInteger(input.quantity_on_hand) || input.quantity_on_hand < 0) {
    throw new Error('quantity_invalid');
  }
  const unitCost = input.unit_cost ?? 0;
  if (!(unitCost >= 0)) throw new Error('cost_invalid');
  // Fase 4: casa com o catálogo → grava o formato OFICIAL + os números; recusa fantasma.
  const cat = await resolveMeasureInCatalog(dbPool, environment, raw);
  if (!cat) throw new Error('measure_not_in_catalog');
  const r = await dbPool.query<WholesaleStockRow>(
    `INSERT INTO commerce.wholesale_stock
            (environment, measure, quantity_on_hand, unit_cost, notes,
             tire_width_mm, tire_aspect_ratio, tire_rim_diameter)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (environment, measure)
     DO UPDATE SET quantity_on_hand  = EXCLUDED.quantity_on_hand,
                   unit_cost         = EXCLUDED.unit_cost,
                   notes             = EXCLUDED.notes,
                   tire_width_mm     = EXCLUDED.tire_width_mm,
                   tire_aspect_ratio = EXCLUDED.tire_aspect_ratio,
                   tire_rim_diameter = EXCLUDED.tire_rim_diameter
       RETURNING measure, quantity_on_hand, unit_cost, notes, updated_at,
                 tire_width_mm, tire_aspect_ratio, tire_rim_diameter`,
    [environment, cat.measure, input.quantity_on_hand, unitCost, input.notes?.trim() || null,
     cat.width, cat.aspect, cat.rim],
  );
  return r.rows[0]!;
}

/** ENTRADA de compra (custo médio): soma quantity_in ao estoque da medida e recalcula o
 *  CUSTO MÉDIO PONDERADO — novo = (qty_atual*custo_atual + qty_in*custo_in)/(qty_atual+qty_in).
 *  É como "a contabilidade bate" comprando a precos diferentes. Atômico no ON CONFLICT
 *  (usa os valores ANTIGOS da linha no DO UPDATE). Primeira entrada = grava o custo direto. */
export async function addWholesaleStockEntry(
  input: { measure: string; quantity_in: number; unit_cost: number; environment?: 'prod' | 'test' },
  dbPool: Pool | PoolClient = defaultPool,
): Promise<WholesaleStockRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const raw = input.measure.trim();
  if (!raw) throw new Error('measure_required');
  if (!Number.isInteger(input.quantity_in) || input.quantity_in <= 0) throw new Error('quantity_invalid');
  if (!(input.unit_cost >= 0)) throw new Error('cost_invalid');
  // Fase 4: casa com o catálogo → formato OFICIAL + números; recusa fantasma.
  const cat = await resolveMeasureInCatalog(dbPool, environment, raw);
  if (!cat) throw new Error('measure_not_in_catalog');
  const r = await dbPool.query<WholesaleStockRow>(
    `INSERT INTO commerce.wholesale_stock
            (environment, measure, quantity_on_hand, unit_cost,
             tire_width_mm, tire_aspect_ratio, tire_rim_diameter)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (environment, measure) DO UPDATE SET
       unit_cost = round(
         (commerce.wholesale_stock.quantity_on_hand * commerce.wholesale_stock.unit_cost
            + EXCLUDED.quantity_on_hand * EXCLUDED.unit_cost)
         / NULLIF(commerce.wholesale_stock.quantity_on_hand + EXCLUDED.quantity_on_hand, 0), 2),
       quantity_on_hand  = commerce.wholesale_stock.quantity_on_hand + EXCLUDED.quantity_on_hand,
       tire_width_mm     = EXCLUDED.tire_width_mm,
       tire_aspect_ratio = EXCLUDED.tire_aspect_ratio,
       tire_rim_diameter = EXCLUDED.tire_rim_diameter
       RETURNING measure, quantity_on_hand, unit_cost, notes, updated_at,
                 tire_width_mm, tire_aspect_ratio, tire_rim_diameter`,
    [environment, cat.measure, input.quantity_in, input.unit_cost, cat.width, cat.aspect, cat.rim],
  );
  return r.rows[0]!;
}

/** Remove uma medida do estoque do galpão (ex.: cadastrou errado). */
export async function deleteWholesaleStock(
  measure: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<void> {
  await dbPool.query(
    `DELETE FROM commerce.wholesale_stock WHERE environment = $1 AND measure = $2`,
    [environment, measure.trim()],
  );
}

export interface WholesaleMeasureRow {
  measure: string;
  quantity_on_hand: number | null; // null = conhecida no catálogo, sem estoque cadastrado
  unit_cost: number | null;        // custo unitário cadastrado (null = sem estoque)
}

/** Medidas pro autocomplete da venda: catálogo (tire_specs) ∪ estoque do galpão, com a
 *  quantidade em mãos e o custo (null quando a medida só existe no catálogo). */
export async function listWholesaleMeasures(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleMeasureRow[]> {
  const r = await dbPool.query<WholesaleMeasureRow>(
    `SELECT m.measure, ws.quantity_on_hand, ws.unit_cost
       FROM (
              SELECT DISTINCT tire_size AS measure
                FROM commerce.tire_specs
               WHERE environment = $1 AND tire_size IS NOT NULL
              UNION
              SELECT measure FROM commerce.wholesale_stock WHERE environment = $1
            ) m
       LEFT JOIN commerce.wholesale_stock ws
              ON ws.environment = $1 AND ws.measure = m.measure
      ORDER BY m.measure`,
    [environment],
  );
  return r.rows;
}

// ─── ATACADO (Fase 3): resumo de custo + lucro ───────────────────────────────
export interface WholesaleResumoRow {
  faturamento: string;
  custo_total: string;
  lucro_total: string;
  vendas_count: number;
}

/** Totais do atacado (vendas confirmadas): faturamento, custo e lucro.
 *  lucro = faturamento − custo (line_profit somado; pode ser negativo se vendeu abaixo). */
export async function getWholesaleResumo(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleResumoRow> {
  const r = await dbPool.query<WholesaleResumoRow>(
    `SELECT
       COALESCE(SUM(oi.line_total), 0)              AS faturamento,
       COALESCE(SUM(oi.unit_cost * oi.quantity), 0) AS custo_total,
       COALESCE(SUM(oi.line_profit), 0)             AS lucro_total,
       COUNT(DISTINCT o.id)                         AS vendas_count
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_order_items oi
         ON oi.order_id = o.id AND oi.environment = o.environment
      WHERE o.environment = $1 AND o.status = 'confirmed'`,
    [environment],
  );
  return r.rows[0]!;
}

// ─── ATACADO — FORNECEDORES (0114): o lado de ENTRADA do galpão ───────────────
// De quem o dono COMPRA o pneu usado. Cada COMPRA registra a origem E alimenta o
// custo médio do galpão (addWholesaleStockEntry, mesma transação). Dado SÓ da matriz
// (sem grant pro parceiro). Paga à vista hoje (payment_status default 'paid').

export interface WholesaleSupplierRow {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
}

/** Lista fornecedores ativos (formulário de compra + gestão), por nome. */
export async function listWholesaleSuppliers(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleSupplierRow[]> {
  const r = await dbPool.query<WholesaleSupplierRow>(
    `SELECT id, name, phone, notes
       FROM commerce.wholesale_suppliers
      WHERE environment = $1 AND deleted_at IS NULL
      ORDER BY name`,
    [environment],
  );
  return r.rows;
}

/** Cria a ficha de um fornecedor (nome obrigatório; telefone normalizado se vier). */
export async function registerWholesaleSupplier(
  input: { name: string; phone?: string | null; notes?: string | null; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<WholesaleSupplierRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const name = input.name.trim();
  if (!name) throw new Error('name_required');
  const r = await dbPool.query<WholesaleSupplierRow>(
    `INSERT INTO commerce.wholesale_suppliers (environment, name, phone, notes)
     VALUES ($1, $2, $3, $4) RETURNING id, name, phone, notes`,
    [environment, name, input.phone ? normalizeBrazilianPhone(input.phone) : null, input.notes?.trim() || null],
  );
  return r.rows[0]!;
}

/** Ranking de fornecedor (quanto comprei de cada, última compra, dias parado).
 *  Inclui quem está cadastrado mas nunca comprou (days_since_last NULL). */
export async function getWholesaleSupplierRanking(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const r = await dbPool.query(
    `SELECT supplier_id, name, phone, purchases_count, total_spent, last_purchase_at, days_since_last
       FROM commerce.wholesale_supplier_summary
      WHERE environment = $1
      ORDER BY total_spent DESC, last_purchase_at DESC NULLS LAST, name`,
    [environment],
  );
  return r.rows;
}

export interface RegisterWholesalePurchaseInput {
  environment?: 'prod' | 'test';
  supplier_id?: string | null;                                  // ficha existente
  new_supplier?: { name: string; phone?: string | null } | null; // fornecedor novo
  items: Array<{ measure: string; brand?: string | null; quantity: number; unit_cost: number }>;
  purchased_at?: string | null;
  notes?: string | null;
  created_by: string;
}

export interface RegisterWholesalePurchaseResult {
  purchase_id: string;
  supplier_id: string;
  supplier_name: string;
  total_amount: string;
  items_count: number;
}

/** Registra uma COMPRA (entrada de pneu no galpão). Transacional: resolve/cria o
 *  fornecedor → cabeçalho → pra cada item ALIMENTA o custo médio do galpão
 *  (addWholesaleStockEntry, mesma transação — atômico) e grava o item com a medida
 *  CANÔNICA (a que o galpão guardou) → grava o total. Custo médio do galpão (0111/0112)
 *  fica intocado na lógica; só recebe a entrada. Medida fora do catálogo → rollback. */
export async function registerWholesalePurchase(
  input: RegisterWholesalePurchaseInput,
  dbPool: Pool = defaultPool,
): Promise<RegisterWholesalePurchaseResult> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  if (!input.items || input.items.length === 0) throw new Error('items_required');

  const client: PoolClient = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // 1. Resolve o fornecedor (ficha existente OU cadastro novo).
    let supplierId: string;
    let supplierName: string;
    if (input.supplier_id) {
      const r = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM commerce.wholesale_suppliers
          WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
        [input.supplier_id, environment],
      );
      if (!r.rows[0]) throw new Error('supplier_not_found');
      supplierId = r.rows[0].id;
      supplierName = r.rows[0].name;
    } else if (input.new_supplier && input.new_supplier.name.trim()) {
      const ins = await client.query<{ id: string; name: string }>(
        `INSERT INTO commerce.wholesale_suppliers (environment, name, phone)
         VALUES ($1, $2, $3) RETURNING id, name`,
        [environment, input.new_supplier.name.trim(),
         input.new_supplier.phone ? normalizeBrazilianPhone(input.new_supplier.phone) : null],
      );
      supplierId = ins.rows[0]!.id;
      supplierName = ins.rows[0]!.name;
    } else {
      throw new Error('supplier_required');
    }

    // 2. Cabeçalho da compra (total 0 — preenchido no passo 4).
    const pur = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_purchases (environment, supplier_id, purchased_at, total_amount, created_by, notes)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), 0, $4, $5) RETURNING id`,
      [environment, supplierId, input.purchased_at ?? null, input.created_by, input.notes ?? null],
    );
    const purchaseId = pur.rows[0]!.id;

    // 3. Itens: cada um ALIMENTA o custo médio do galpão (mesma transação) e é gravado
    //    com a medida CANÔNICA que o galpão guardou (item e estoque nunca divergem).
    for (const it of input.items) {
      const stockRow = await addWholesaleStockEntry(
        { measure: it.measure, quantity_in: it.quantity, unit_cost: it.unit_cost, environment },
        client,
      );
      await client.query(
        `INSERT INTO commerce.wholesale_purchase_items (environment, purchase_id, measure, brand, quantity, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [environment, purchaseId, stockRow.measure, it.brand ?? null, it.quantity, it.unit_cost],
      );
    }

    // 4. Grava o total (passo SEPARADO — enxerga os itens recém-inseridos).
    const tot = await client.query<{ total_amount: string }>(
      `UPDATE commerce.wholesale_purchases
          SET total_amount = COALESCE(
            (SELECT sum(line_total) FROM commerce.wholesale_purchase_items WHERE purchase_id = $1), 0)
        WHERE id = $1 RETURNING total_amount`,
      [purchaseId],
    );

    await client.query('COMMIT');
    return {
      purchase_id: purchaseId,
      supplier_id: supplierId,
      supplier_name: supplierName,
      total_amount: tot.rows[0]!.total_amount,
      items_count: input.items.length,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface WholesalePurchaseRow {
  id: string;
  supplier_name: string;
  purchased_at: string;
  total_amount: string;
  items_count: number;
}

/** Histórico de compras (cabeçalhos), mais recente primeiro, com nome do fornecedor. */
export async function listWholesalePurchases(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  limit = 50,
): Promise<WholesalePurchaseRow[]> {
  const r = await dbPool.query<WholesalePurchaseRow>(
    `SELECT p.id, s.name AS supplier_name, p.purchased_at, p.total_amount,
            (SELECT count(*) FROM commerce.wholesale_purchase_items i WHERE i.purchase_id = p.id)::int AS items_count
       FROM commerce.wholesale_purchases p
       JOIN commerce.wholesale_suppliers s ON s.id = p.supplier_id AND s.environment = p.environment
      WHERE p.environment = $1 AND p.status = 'confirmed'
      ORDER BY p.purchased_at DESC
      LIMIT $2`,
    [environment, limit],
  );
  return r.rows;
}
