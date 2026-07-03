import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { applyWholesaleStockDecrement, applyWholesaleStockReturn } from './wholesale-stock.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyMatrizGalpaoDecrement, applyMatrizGalpaoReturn, applyMatrizRetailCostSnapshot } from '../../atendente-v2/wholesale-stock-read.js';

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
  environment?: 'prod' | 'test';
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
  const orderId = result.rows[0]!.order_id;

  // Venda MANUAL que cai na MATRIZ (unit vazia → 'main' dentro da função SQL) também congela
  // o custo do galpão nos itens (0117). NÃO baixa estoque aqui (comportamento de hoje: só
  // walk-in e bot baixam) — este é só o retrato do custo pro lucro do varejo sair certo.
  if (env.WHOLESALE_MATRIZ_RETAIL_COST) {
    const m = await dbPool.query<{ id: string }>(
      `SELECT id FROM core.units WHERE environment = $1 AND slug = 'main' LIMIT 1`,
      [environment],
    );
    const matrizId = m.rows[0]?.id ?? null;
    if (matrizId && (!input.unit_id || input.unit_id === matrizId)) {
      await applyMatrizRetailCostSnapshot(
        dbPool as unknown as PoolClient,
        environment,
        orderId,
        input.items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
        true,
      );
    }
  }

  return { order_id: orderId };
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

  // Balcão da MATRIZ vende do GALPÃO → abate o estoque (commerce.wholesale_stock) e CONGELA
  // o custo médio nos itens (0117 — fatia 2: lucro real do varejo). Best-effort FORA da
  // transação SQL (a venda já commitou; a baixa tem clamp em 0 e NUNCA trava; item sem custo
  // fica NULL). SÓ quando a unit é a matriz (slug='main'; null no balcão = matriz). Cada
  // efeito atrás da própria flag (WHOLESALE_MATRIZ_DECREMENT / WHOLESALE_MATRIZ_RETAIL_COST).
  if (env.WHOLESALE_MATRIZ_DECREMENT || env.WHOLESALE_MATRIZ_RETAIL_COST) {
    const m = await dbPool.query<{ id: string }>(
      `SELECT id FROM core.units WHERE environment = $1 AND slug = 'main' LIMIT 1`,
      [environment],
    );
    const matrizId = m.rows[0]?.id ?? null;
    if (matrizId && (!input.unit_id || input.unit_id === matrizId)) {
      const items = input.items.map((i) => ({ productId: i.product_id, quantity: i.quantity }));
      await applyMatrizGalpaoDecrement(
        dbPool as unknown as PoolClient,
        environment,
        items,
        env.WHOLESALE_MATRIZ_DECREMENT,
        orderId,
      );
      await applyMatrizRetailCostSnapshot(
        dbPool as unknown as PoolClient,
        environment,
        orderId,
        items,
        env.WHOLESALE_MATRIZ_RETAIL_COST,
      );
    }
  }

  return { order_id: orderId };
}

export async function cancelManualOrder(
  input: CancelManualOrderInput,
  dbPool: Pool = defaultPool,
): Promise<{ cancelled: true }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  // Cancelamento + devolução do galpão ATÔMICOS: o pedido do VAREJO da matriz que baixou
  // o galpão o recompõe ao cancelar (espelho da baixa, guiado pela trilha). Se a devolução
  // falha, o cancelamento faz rollback junto (mais forte que a baixa, best-effort na venda).
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT commerce.cancel_manual_order($1, $2, $3)', [
      input.order_id,
      input.actor_label,
      input.reason,
    ]);
    await applyMatrizGalpaoReturn(client, environment, input.order_id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

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
  allow_oversell?: boolean; // caixa confirmou vender acima do estoque (avisar+confirmar)
  // FINANCEIRO (0115, flag WHOLESALE_FINANCE): 'pending' = fiado (A RECEBER do
  // borracheiro), com vencimento opcional. Ignorado com a flag off (nasce 'paid').
  payment_status?: 'paid' | 'pending';
  due_date?: string | null;
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

    // 2. Cabeçalho da venda. FINANCEIRO (0115): com a flag on, a venda pode nascer
    //    'pending' (fiado → A RECEBER); flag off = 'paid' sem paid_at, byte a byte
    //    o de antes (mesmo resultado do default da coluna).
    const fiado = env.WHOLESALE_FINANCE && input.payment_status === 'pending';
    const paymentStatus = fiado ? 'pending' : 'paid';
    const paidAt = env.WHOLESALE_FINANCE && !fiado ? new Date().toISOString() : null;
    const dueDate = fiado ? (input.due_date ?? null) : null;
    const ord = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_orders (environment, buyer_id, sold_at, total_amount, created_by, notes, payment_status, due_date, paid_at)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), 0, $4, $5, $6, $7::date, $8::timestamptz) RETURNING id`,
      [environment, buyerId, input.sold_at ?? null, input.created_by, input.notes ?? null, paymentStatus, dueDate, paidAt],
    );
    const orderId = ord.rows[0]!.id;

    // 3. Disponibilidade + custo (com LOCK). Agrega a qtd pedida por medida, lê o estoque
    //    com FOR UPDATE (trava a linha durante a venda — sem corrida de duas vendas no mesmo
    //    pneu) e congela o custo (snapshot Fase 3, buscado à parte pra não dar 42P08 no INSERT).
    const reqByMeasure = new Map<string, number>();
    for (const it of input.items) {
      const m = it.measure.trim();
      if (m) reqByMeasure.set(m, (reqByMeasure.get(m) ?? 0) + it.quantity);
    }
    const stockByMeasure = new Map<string, { onHand: number; cost: number }>();
    for (const m of reqByMeasure.keys()) {
      const s = await client.query<{ quantity_on_hand: string; unit_cost: string | null }>(
        `SELECT quantity_on_hand, unit_cost FROM commerce.wholesale_stock
          WHERE environment = $1 AND measure = $2 LIMIT 1 FOR UPDATE`,
        [environment, m],
      );
      stockByMeasure.set(m, {
        onHand: s.rows[0] ? Number(s.rows[0].quantity_on_hand) : 0,
        cost: s.rows[0]?.unit_cost != null ? Number(s.rows[0].unit_cost) : 0,
      });
    }

    // 3a. TRAVA DE OVERSELL: só quando a baixa está ligada (o estoque é fonte de verdade) e
    //     o caixa NÃO confirmou vender assim mesmo. Aborta com a lista de medidas que estouraram
    //     (a rota devolve 409 pro front avisar). Agregado por medida (2×30 fura um estoque de 40).
    if (env.WHOLESALE_STOCK_DECREMENT && !input.allow_oversell) {
      const short: Array<{ measure: string; available: number; requested: number }> = [];
      for (const [m, req] of reqByMeasure) {
        const onHand = stockByMeasure.get(m)?.onHand ?? 0;
        if (req > onHand) short.push({ measure: m, available: onHand, requested: req });
      }
      if (short.length > 0) throw new Error('oversell:' + JSON.stringify(short));
    }

    // 3b. Itens (preço digitado; line_total/line_profit gerados pelo banco; custo congelado).
    for (const it of input.items) {
      const m = it.measure.trim();
      const unitCost = stockByMeasure.get(m)?.cost ?? 0;
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
 *  lucro = faturamento − custo (line_profit somado; pode ser negativo se vendeu abaixo).
 *  `period` 'mes' = só o mês corrente (fuso America/Sao_Paulo); 'tudo' = desde sempre. */
export async function getWholesaleResumo(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  period: 'mes' | 'tudo' = 'tudo',
): Promise<WholesaleResumoRow> {
  const periodWhere = period === 'mes'
    ? `AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`
    : '';
  const r = await dbPool.query<WholesaleResumoRow>(
    `SELECT
       COALESCE(SUM(oi.line_total), 0)              AS faturamento,
       COALESCE(SUM(oi.unit_cost * oi.quantity), 0) AS custo_total,
       COALESCE(SUM(oi.line_profit), 0)             AS lucro_total,
       COUNT(DISTINCT o.id)                         AS vendas_count
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_order_items oi
         ON oi.order_id = o.id AND oi.environment = o.environment
      WHERE o.environment = $1 AND o.status = 'confirmed' ${periodWhere}`,
    [environment],
  );
  return r.rows[0]!;
}

// ─── VAREJO DA MATRIZ (0117 — fatia 2): resumo com custo CONGELADO + recorte por mês ─
export interface VarejoResumoRow {
  faturamento: string;
  custo_total: string;
  lucro_total: string;
  vendas_count: number;
  itens_sem_custo: number;
}

/** Totais do VAREJO da matriz (pedidos da unit 'main', cancelado fora) com o custo
 *  congelado na venda (order_items.matriz_unit_cost). Honestidade: custo e lucro só
 *  somam linhas COM custo congelado; `itens_sem_custo` conta as que ficaram de fora
 *  (venda antiga, flag off, medida sem custo no galpão) pra UI avisar em vez de chutar.
 *  A régua de "venda do varejo" é a MESMA do card/tabela da aba Vendas (unit slug='main'
 *  e não-cancelado) — o resumo nunca diverge da lista. */
export async function getVarejoResumo(
  period: 'mes' | 'tudo' = 'tudo',
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<VarejoResumoRow> {
  const periodWhere = period === 'mes'
    ? `AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`
    : '';
  const r = await dbPool.query<VarejoResumoRow>(
    `SELECT
       COALESCE(SUM(oi.quantity * oi.unit_price - oi.discount_amount), 0)  AS faturamento,
       COALESCE(SUM(oi.matriz_unit_cost * oi.quantity), 0)                 AS custo_total,
       COALESCE(SUM(CASE WHEN oi.matriz_unit_cost IS NOT NULL
                         THEN (oi.quantity * oi.unit_price - oi.discount_amount)
                              - oi.matriz_unit_cost * oi.quantity END), 0) AS lucro_total,
       COUNT(DISTINCT o.id)::int                                           AS vendas_count,
       COUNT(*) FILTER (WHERE oi.matriz_unit_cost IS NULL)::int            AS itens_sem_custo
       FROM commerce.orders o
       JOIN core.units u
         ON u.id = o.unit_id AND u.environment = o.environment AND u.slug = 'main'
       JOIN commerce.order_items oi
         ON oi.order_id = o.id AND oi.environment = o.environment
      WHERE o.environment = $1 AND o.status <> 'cancelled' ${periodWhere}`,
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

/** Quebra fornecedor × medida: quanto comprei de cada medida de cada fornecedor e o
 *  custo MÉDIO PONDERADO (sum(line_total)/sum(quantity)). Base dos insights "quem vende
 *  a medida X mais barato" (#1) e "especialidade do fornecedor" (#2). Read-only, lê só
 *  das compras confirmadas. Dado SÓ da matriz. Ordena por medida e, dentro dela, do
 *  mais barato pro mais caro (o front marca o 1º como "mais barato"). */
export async function getWholesaleSupplierMeasureBreakdown(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const r = await dbPool.query(
    `SELECT
        s.id                                                       AS supplier_id,
        s.name                                                     AS supplier_name,
        pi.measure                                                 AS measure,
        SUM(pi.quantity)                                           AS qty_total,
        ROUND(SUM(pi.line_total) / NULLIF(SUM(pi.quantity), 0), 2) AS avg_cost,
        MAX(p.purchased_at)                                        AS last_purchased_at
       FROM commerce.wholesale_purchase_items pi
       JOIN commerce.wholesale_purchases p
         ON p.id = pi.purchase_id AND p.environment = pi.environment
       JOIN commerce.wholesale_suppliers s
         ON s.id = p.supplier_id AND s.environment = p.environment
      WHERE pi.environment = $1
        AND p.status = 'confirmed'
        AND s.deleted_at IS NULL
      GROUP BY s.id, s.name, pi.measure
      ORDER BY pi.measure ASC, avg_cost ASC, qty_total DESC`,
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
  // FINANCEIRO (0115, flag WHOLESALE_FINANCE): 'pending' = compra fiada (A PAGAR ao
  // fornecedor — porta que a 0114 deixou aberta). Ignorado com a flag off (nasce 'paid').
  payment_status?: 'paid' | 'pending';
  due_date?: string | null;
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

    // 2. Cabeçalho da compra (total 0 — preenchido no passo 4). FINANCEIRO (0115):
    //    com a flag on, a compra pode nascer 'pending' (fiado → A PAGAR ao fornecedor);
    //    flag off = 'paid' sem paid_at, byte a byte o de antes (default da 0114).
    const fiado = env.WHOLESALE_FINANCE && input.payment_status === 'pending';
    const paymentStatus = fiado ? 'pending' : 'paid';
    const paidAt = env.WHOLESALE_FINANCE && !fiado ? new Date().toISOString() : null;
    const dueDate = fiado ? (input.due_date ?? null) : null;
    const pur = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_purchases (environment, supplier_id, purchased_at, total_amount, created_by, notes, payment_status, due_date, paid_at)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), 0, $4, $5, $6, $7::date, $8::timestamptz) RETURNING id`,
      [environment, supplierId, input.purchased_at ?? null, input.created_by, input.notes ?? null, paymentStatus, dueDate, paidAt],
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

// ─── ATACADO — FINANCEIRO (0115): o FIADO dos dois lados do galpão ────────────
// A RECEBER = venda de atacado 'pending' (borracheiro levou e acerta depois).
// A PAGAR = compra de fornecedor 'pending' (porta aberta na 0114). Vencido =
// pending com due_date < hoje. Dado SÓ da matriz (regra de ouro — zero grant
// pro parceiro); atrás da flag WHOLESALE_FINANCE (a rota devolve enabled:false).

export interface WholesaleFinanceOpenRow {
  id: string;
  counterparty: string;      // borracheiro (a receber) ou fornecedor (a pagar)
  phone: string | null;      // deep-link "Cobrar no WhatsApp" da tela Financeiro
  total_amount: string;
  registered_at: string;     // sold_at / purchased_at
  due_date: string | null;
  overdue: boolean;
}

export interface WholesaleFinanceResumo {
  a_receber_total: string;
  a_receber_count: number;
  a_receber_vencidos: number;
  a_pagar_total: string;
  a_pagar_count: number;
  a_pagar_vencidos: number;
  receivables: WholesaleFinanceOpenRow[];
  payables: WholesaleFinanceOpenRow[];
}

/** Resumo do fiado do galpão: totais + as listas em aberto (vencidos primeiro). */
export async function getWholesaleFinance(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleFinanceResumo> {
  const rec = await dbPool.query<WholesaleFinanceOpenRow>(
    `SELECT o.id, c.name AS counterparty, c.phone, o.total_amount, o.sold_at AS registered_at,
            o.due_date, (o.due_date IS NOT NULL AND o.due_date < current_date) AS overdue
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_customers c ON c.id = o.buyer_id AND c.environment = o.environment
      WHERE o.environment = $1 AND o.status = 'confirmed' AND o.payment_status = 'pending'
      ORDER BY (o.due_date IS NULL), o.due_date, o.sold_at`,
    [environment],
  );
  const pay = await dbPool.query<WholesaleFinanceOpenRow>(
    `SELECT p.id, s.name AS counterparty, s.phone, p.total_amount, p.purchased_at AS registered_at,
            p.due_date, (p.due_date IS NOT NULL AND p.due_date < current_date) AS overdue
       FROM commerce.wholesale_purchases p
       JOIN commerce.wholesale_suppliers s ON s.id = p.supplier_id AND s.environment = p.environment
      WHERE p.environment = $1 AND p.status = 'confirmed' AND p.payment_status = 'pending'
      ORDER BY (p.due_date IS NULL), p.due_date, p.purchased_at`,
    [environment],
  );
  const sum = (rows: WholesaleFinanceOpenRow[]) =>
    rows.reduce((acc, r) => acc + Number(r.total_amount), 0).toFixed(2);
  return {
    a_receber_total: sum(rec.rows),
    a_receber_count: rec.rows.length,
    a_receber_vencidos: rec.rows.filter((r) => r.overdue).length,
    a_pagar_total: sum(pay.rows),
    a_pagar_count: pay.rows.length,
    a_pagar_vencidos: pay.rows.filter((r) => r.overdue).length,
    receivables: rec.rows,
    payables: pay.rows,
  };
}

/** QUITA um fiado de venda (A RECEBER): pending → paid + paid_at. Idempotente-avesso:
 *  só quita quem está pending (quitar 2x → receivable_not_found, sem sobrescrever). */
export async function settleWholesaleOrderPayment(
  orderId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ id: string; paid_at: string }> {
  const r = await dbPool.query<{ id: string; paid_at: string }>(
    `UPDATE commerce.wholesale_orders
        SET payment_status = 'paid', paid_at = now()
      WHERE id = $1 AND environment = $2 AND status = 'confirmed' AND payment_status = 'pending'
      RETURNING id, paid_at`,
    [orderId, environment],
  );
  if (!r.rows[0]) throw new Error('receivable_not_found');
  return r.rows[0];
}

/** QUITA um fiado de compra (A PAGAR ao fornecedor): pending → paid + paid_at. */
export async function settleWholesalePurchasePayment(
  purchaseId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ id: string; paid_at: string }> {
  const r = await dbPool.query<{ id: string; paid_at: string }>(
    `UPDATE commerce.wholesale_purchases
        SET payment_status = 'paid', paid_at = now()
      WHERE id = $1 AND environment = $2 AND status = 'confirmed' AND payment_status = 'pending'
      RETURNING id, paid_at`,
    [purchaseId, environment],
  );
  if (!r.rows[0]) throw new Error('payable_not_found');
  return r.rows[0];
}

// ─── MATRIZ — DESPESAS GERAIS (0120, flag MATRIZ_EXPENSES): Fase A do livro-caixa ─────
// A única SAÍDA modelada da matriz era a compra de fornecedor (0114/0115); aluguel,
// funcionário, combustível e frete pago não existiam → o "saldo" mentia por omissão.
// Mesmo vocabulário do fiado 0115 (pending = a pagar; paid+paid_at = saiu do caixa) DE
// PROPÓSITO: o sweep do livro-razão (Fase B, 0121) lê despesa/venda/compra com a MESMA
// régua. Dado SÓ da matriz (zero grant — provado na 0120). Soft delete = trilha.

export const MATRIZ_EXPENSE_CATEGORIES = [
  'aluguel', 'funcionario', 'combustivel', 'frete', 'manutencao', 'outros',
] as const;
export type MatrizExpenseCategory = (typeof MATRIZ_EXPENSE_CATEGORIES)[number];

export interface MatrizExpenseRow {
  id: string;
  category: string;
  description: string | null;
  amount: string;
  occurred_at: string;
  payment_status: 'paid' | 'pending';
  due_date: string | null;
  paid_at: string | null;
  overdue: boolean;
}

export interface MatrizExpensesResumo {
  a_pagar_total: string;
  a_pagar_count: number;
  a_pagar_vencidos: number;
  pago_mes_total: string; // pagas no mês corrente (fuso São Paulo, mesmo recorte do varejo 0117)
  entries: MatrizExpenseRow[];
}

/** Resumo das despesas da matriz: a pagar (vencidos primeiro) + pago no mês + últimas. */
export async function getMatrizExpenses(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  limit = 50,
): Promise<MatrizExpensesResumo> {
  const rows = await dbPool.query<MatrizExpenseRow>(
    `SELECT id, category, description, amount, occurred_at, payment_status, due_date, paid_at,
            (payment_status = 'pending' AND due_date IS NOT NULL AND due_date < current_date) AS overdue
       FROM commerce.matriz_expenses
      WHERE environment = $1 AND deleted_at IS NULL
      ORDER BY (payment_status = 'pending') DESC, (due_date IS NULL), due_date, occurred_at DESC
      LIMIT $2`,
    [environment, limit],
  );
  const tot = await dbPool.query<{ a_pagar_total: string; a_pagar_count: number; a_pagar_vencidos: number; pago_mes_total: string }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE payment_status = 'pending'), 0) AS a_pagar_total,
            COUNT(*) FILTER (WHERE payment_status = 'pending')::int AS a_pagar_count,
            COUNT(*) FILTER (WHERE payment_status = 'pending' AND due_date IS NOT NULL AND due_date < current_date)::int AS a_pagar_vencidos,
            COALESCE(SUM(amount) FILTER (WHERE payment_status = 'paid'
              AND (COALESCE(paid_at, occurred_at) AT TIME ZONE 'America/Sao_Paulo')
                    >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')), 0) AS pago_mes_total
       FROM commerce.matriz_expenses
      WHERE environment = $1 AND deleted_at IS NULL`,
    [environment],
  );
  return { ...tot.rows[0]!, entries: rows.rows };
}

export interface CreateMatrizExpenseInput {
  category: MatrizExpenseCategory;
  description?: string | null;
  amount: number;
  payment_status?: 'paid' | 'pending'; // omitido = 'paid' (pago na hora)
  due_date?: string | null;            // só faz sentido no pending
  created_by?: string | null;
  environment?: 'prod' | 'test';
}

/** Lança uma despesa da matriz. À vista nasce paid+paid_at; a pagar nasce pending. */
export async function createMatrizExpense(
  input: CreateMatrizExpenseInput,
  dbPool: Pool = defaultPool,
): Promise<MatrizExpenseRow> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const paymentStatus = input.payment_status ?? 'paid';
  const r = await dbPool.query<MatrizExpenseRow>(
    `INSERT INTO commerce.matriz_expenses
       (environment, category, description, amount, payment_status, due_date, paid_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'paid' THEN now() ELSE NULL END, $7)
     RETURNING id, category, description, amount, occurred_at, payment_status, due_date, paid_at,
               (payment_status = 'pending' AND due_date IS NOT NULL AND due_date < current_date) AS overdue`,
    [environment, input.category, input.description ?? null, input.amount,
     paymentStatus, paymentStatus === 'pending' ? (input.due_date ?? null) : null,
     input.created_by ?? null],
  );
  return r.rows[0]!;
}

/** QUITA uma despesa a pagar: pending → paid + paid_at (espelho do settle 0115).
 *  Quitar 2x → expense_not_found (não sobrescreve o paid_at original). */
export async function settleMatrizExpense(
  expenseId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ id: string; paid_at: string }> {
  const r = await dbPool.query<{ id: string; paid_at: string }>(
    `UPDATE commerce.matriz_expenses
        SET payment_status = 'paid', paid_at = now()
      WHERE id = $1 AND environment = $2 AND payment_status = 'pending' AND deleted_at IS NULL
      RETURNING id, paid_at`,
    [expenseId, environment],
  );
  if (!r.rows[0]) throw new Error('expense_not_found');
  return r.rows[0];
}

/** REMOVE uma despesa lançada errada (soft delete — trilha preservada, nunca DELETE). */
export async function removeMatrizExpense(
  expenseId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ id: string }> {
  const r = await dbPool.query<{ id: string }>(
    `UPDATE commerce.matriz_expenses
        SET deleted_at = now()
      WHERE id = $1 AND environment = $2 AND deleted_at IS NULL
      RETURNING id`,
    [expenseId, environment],
  );
  if (!r.rows[0]) throw new Error('expense_not_found');
  return r.rows[0];
}

// ─── ATACADO — CANCELAR VENDA (0116) + listagem das últimas vendas ────────────
// O balcão não tinha como desfazer registro errado (o varejo tem; o atacado não).
// Cancelar corrige SOZINHO ranking/resumo/fiado (tudo filtra status='confirmed');
// o estoque é DEVOLVIDO por código (espelho da baixa, flag WHOLESALE_STOCK_DECREMENT).

export interface WholesaleSaleRow {
  id: string;
  buyer_name: string;
  sold_at: string;
  total_amount: string;
  payment_status: string;
  due_date: string | null;
  status: string;
  items_count: number;
}

/** Últimas vendas de atacado (vivas E canceladas — a trilha fica visível), mais
 *  recente primeiro. É a lista de onde o dono cancela um registro errado. */
export async function listWholesaleSales(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
  limit = 15,
): Promise<WholesaleSaleRow[]> {
  const r = await dbPool.query<WholesaleSaleRow>(
    `SELECT o.id, c.name AS buyer_name, o.sold_at, o.total_amount,
            o.payment_status, o.due_date, o.status,
            (SELECT count(*) FROM commerce.wholesale_order_items i WHERE i.order_id = o.id)::int AS items_count
       FROM commerce.wholesale_orders o
       JOIN commerce.wholesale_customers c ON c.id = o.buyer_id AND c.environment = o.environment
      WHERE o.environment = $1
      ORDER BY o.sold_at DESC
      LIMIT $2`,
    [environment, limit],
  );
  return r.rows;
}

export interface CancelWholesaleSaleInput {
  order_id: string;
  cancelled_by: string;
  reason?: string | null;
  environment?: 'prod' | 'test';
}

/** CANCELA uma venda de atacado (confirmed → cancelled, sem apagar). Transacional:
 *  trava a venda (FOR UPDATE), grava a trilha (0116) e DEVOLVE o estoque ao galpão
 *  (espelho da baixa; só com WHOLESALE_STOCK_DECREMENT on — o mesmo interruptor que
 *  baixou). Cancelar 2x → sale_already_cancelled (a trilha original não é sobrescrita). */
export async function cancelWholesaleSale(
  input: CancelWholesaleSaleInput,
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; cancelled_at: string; payment_status: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client: PoolClient = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query<{ status: string; payment_status: string }>(
      `SELECT status, payment_status FROM commerce.wholesale_orders
        WHERE id = $1 AND environment = $2 LIMIT 1 FOR UPDATE`,
      [input.order_id, environment],
    );
    if (!cur.rows[0]) throw new Error('sale_not_found');
    if (cur.rows[0].status !== 'confirmed') throw new Error('sale_already_cancelled');

    const upd = await client.query<{ cancelled_at: string }>(
      `UPDATE commerce.wholesale_orders
          SET status = 'cancelled', cancelled_at = now(), cancelled_by = $3, cancel_reason = $4
        WHERE id = $1 AND environment = $2
        RETURNING cancelled_at`,
      [input.order_id, environment, input.cancelled_by, input.reason?.slice(0, 300) ?? null],
    );

    // Devolve os pneus ao galpão (espelho da baixa; mesma transação = atômico).
    const items = await client.query<{ measure: string; quantity: number }>(
      `SELECT measure, quantity FROM commerce.wholesale_order_items
        WHERE environment = $1 AND order_id = $2`,
      [environment, input.order_id],
    );
    await applyWholesaleStockReturn(client, environment, items.rows, env.WHOLESALE_STOCK_DECREMENT);

    await client.query('COMMIT');
    return {
      order_id: input.order_id,
      cancelled_at: upd.rows[0]!.cancelled_at,
      payment_status: cur.rows[0].payment_status,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── REDE — COMISSÃO COMO LANÇAMENTO (0118, flag NETWORK_COMMISSION_LEDGER) ──────────
// Regras do dono (2026-07-02): nasce quando a venda REALIZA (MESMA régua 0077/0090 do
// getPainelRede — mudou lá, mude aqui); venda cancelada → estorna sozinho; % da FICHA
// congelado no lançamento; base = SÓ venda 2W (source_tag='2w') e SÓ os PNEUS — o FRETE
// fica FORA da base (decisão do dono 07-02: frete é serviço de entrega do parceiro;
// order_total no lançamento = a BASE, já sem frete). Preenchido por VARREDURA idempotente
// (sweep no GET da tela — sem gancho no fluxo do parceiro/bot; auto-corrige o que ficou
// pra trás). Dado SÓ da matriz: zero grant pro parceiro (0118).

export interface CommissionSweepResult {
  created: number;
  reversed: number;
}

/** VARRE e corrige o livro de comissões (idempotente):
 *  1) cria lançamento pra venda 2W REALIZADA sem lançamento (UNIQUE por venda segura retry);
 *  2) estorna lançamento vivo cuja venda foi cancelada/apagada — se já estava PAGO, vira
 *     'reversed' com settled_at preservado (trilha do "acerto por fora"). */
export async function sweepCommissionEntries(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<CommissionSweepResult> {
  const ins = await dbPool.query(
    `INSERT INTO network.commission_entries
       (environment, partner_id, partner_unit_id, unit_id, partner_order_id,
        order_total, commission_percent, commission_amount, realized_at)
     SELECT po.environment, pu.partner_id, pu.id, po.unit_id, po.id,
            GREATEST(po.total_amount - COALESCE(po.freight_amount, 0), 0), p.commission_percent,
            round(GREATEST(po.total_amount - COALESCE(po.freight_amount, 0), 0) * p.commission_percent / 100.0, 2),
            (CASE WHEN po.fulfillment_mode = 'delivery'
                  THEN COALESCE(po.delivered_at, po.created_at)
                  ELSE COALESCE(po.retrieved_at, po.created_at) END)
       FROM commerce.partner_orders po
       JOIN network.partner_units pu
         ON pu.unit_id = po.unit_id AND pu.environment = po.environment AND pu.deleted_at IS NULL
       JOIN network.partners p
         ON p.id = pu.partner_id AND p.environment = po.environment AND p.deleted_at IS NULL
      WHERE po.environment = $1
        AND po.source_tag = '2w'
        AND po.status <> 'cancelled' AND po.deleted_at IS NULL
        AND NOT (po.fulfillment_mode = 'delivery' AND po.delivery_status <> 'delivered')
        AND NOT po.awaiting_pickup
        AND p.commercial_model IN ('commission', 'hybrid')
        AND COALESCE(p.commission_percent, 0) > 0
     ON CONFLICT (environment, partner_order_id) DO NOTHING`,
    [environment],
  );

  const rev = await dbPool.query(
    `UPDATE network.commission_entries ce
        SET status = 'reversed', reversed_at = now(),
            reversed_reason = 'venda cancelada/desfeita'
      WHERE ce.environment = $1
        AND ce.status IN ('open', 'settled')
        AND (
          NOT EXISTS (SELECT 1 FROM commerce.partner_orders po
                       WHERE po.id = ce.partner_order_id AND po.environment = ce.environment)
          OR EXISTS (SELECT 1 FROM commerce.partner_orders po
                      WHERE po.id = ce.partner_order_id AND po.environment = ce.environment
                        AND (po.status = 'cancelled' OR po.deleted_at IS NOT NULL))
        )`,
    [environment],
  );

  return { created: ins.rowCount ?? 0, reversed: rev.rowCount ?? 0 };
}

export interface CommissionLedger {
  total_aberto: string;
  abertos_count: number;
  partners: Array<{
    partner_id: string;
    partner_name: string;
    whatsapp_phone: string | null;
    open_count: number;
    open_total: string;
  }>;
  entries: Array<{
    id: string;
    partner_name: string;
    order_total: string;
    commission_percent: string;
    commission_amount: string;
    status: 'open' | 'settled' | 'reversed';
    realized_at: string;
    settled_at: string | null;
    reversed_at: string | null;
  }>;
}

/** Livro de comissões pro painel: total em aberto, agregado por parceiro (de quem cobrar)
 *  e os últimos 25 lançamentos (vivos, recebidos e estornados — trilha visível). */
export async function getCommissionLedger(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<CommissionLedger> {
  const totals = await dbPool.query<{ total_aberto: string; abertos_count: number }>(
    `SELECT COALESCE(SUM(commission_amount), 0) AS total_aberto, COUNT(*)::int AS abertos_count
       FROM network.commission_entries WHERE environment = $1 AND status = 'open'`,
    [environment],
  );
  const partners = await dbPool.query(
    `SELECT ce.partner_id, COALESCE(p.trade_name, p.legal_name, 'Parceiro') AS partner_name,
            p.whatsapp_phone,
            COUNT(*)::int AS open_count, COALESCE(SUM(ce.commission_amount), 0) AS open_total
       FROM network.commission_entries ce
       JOIN network.partners p ON p.id = ce.partner_id AND p.environment = ce.environment
      WHERE ce.environment = $1 AND ce.status = 'open'
      GROUP BY ce.partner_id, p.trade_name, p.legal_name, p.whatsapp_phone
      ORDER BY open_total DESC`,
    [environment],
  );
  const entries = await dbPool.query(
    `SELECT ce.id, COALESCE(p.trade_name, p.legal_name, 'Parceiro') AS partner_name,
            ce.order_total, ce.commission_percent, ce.commission_amount,
            ce.status, ce.realized_at, ce.settled_at, ce.reversed_at
       FROM network.commission_entries ce
       JOIN network.partners p ON p.id = ce.partner_id AND p.environment = ce.environment
      WHERE ce.environment = $1
      ORDER BY ce.realized_at DESC
      LIMIT 25`,
    [environment],
  );
  return {
    total_aberto: totals.rows[0]!.total_aberto,
    abertos_count: totals.rows[0]!.abertos_count,
    partners: partners.rows as CommissionLedger['partners'],
    entries: entries.rows as CommissionLedger['entries'],
  };
}

/** "Recebi": quita TODOS os lançamentos em aberto de um parceiro (open → settled).
 *  Nada em aberto → nothing_open (não inventa quitação). */
export async function settleCommissionEntries(
  input: { partner_id: string; settled_by: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<{ settled_count: number; settled_total: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query<{ commission_amount: string }>(
    `UPDATE network.commission_entries
        SET status = 'settled', settled_at = now(), settled_by = $3
      WHERE environment = $1 AND partner_id = $2 AND status = 'open'
      RETURNING commission_amount`,
    [environment, input.partner_id, input.settled_by],
  );
  if ((r.rowCount ?? 0) === 0) throw new Error('nothing_open');
  const total = r.rows.reduce((sum, row) => sum + Number(row.commission_amount), 0);
  return { settled_count: r.rowCount ?? 0, settled_total: total.toFixed(2) };
}

/** Editor do MODELO COMERCIAL do parceiro (pendência de 06-01): grava modelo + % +
 *  mensalidade na FICHA (network.partners) com trilha em audit.events. Vale pra
 *  lançamentos NOVOS — o que já foi lançado fica com o % da época (congelado, regra
 *  do dono). SEM flag: é edição de cadastro, aditiva. */
export async function updatePartnerCommercialTerms(
  input: {
    partner_id: string;
    commercial_model: 'commission' | 'monthly' | 'hybrid';
    commission_percent: number | null;
    monthly_fee: number | null;
    actor_label: string;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ updated: true }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  if (input.commission_percent !== null && (input.commission_percent < 0 || input.commission_percent > 100)) {
    throw new Error('invalid_percent');
  }
  if (input.monthly_fee !== null && input.monthly_fee < 0) throw new Error('invalid_fee');

  const before = await dbPool.query(
    `SELECT commercial_model, commission_percent, monthly_fee FROM network.partners
      WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
    [input.partner_id, environment],
  );
  if (!before.rows[0]) throw new Error('partner_not_found');

  await dbPool.query(
    `UPDATE network.partners
        SET commercial_model = $3, commission_percent = $4, monthly_fee = $5, updated_at = now()
      WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
    [input.partner_id, environment, input.commercial_model, input.commission_percent, input.monthly_fee],
  );
  await dbPool.query(
    `INSERT INTO audit.events (environment, domain, entity_table, entity_id, event_type, actor_label, idempotency_key, payload_after)
     VALUES ($1, 'network', 'network.partners', $2, 'partner_terms_updated', $3, $4, $5::jsonb)`,
    [environment, input.partner_id, input.actor_label, `terms-${input.partner_id}-${Date.now()}`,
     JSON.stringify({
       before: before.rows[0],
       after: {
         commercial_model: input.commercial_model,
         commission_percent: input.commission_percent,
         monthly_fee: input.monthly_fee,
       },
     })],
  );
  return { updated: true };
}

// ─── FINANCEIRO DA MATRIZ — VISÃO CONSOLIDADA (Onda 1: SÓ LEITURA) ────────────
// A tela Financeiro num payload só: consolidado do MÊS das 3 pernas (atacado +
// varejo 0117 + comissão 0118) menos as despesas (0120), A RECEBER e A PAGAR
// juntos (fiado 0115 + comissão + despesa pendente, agenda por vencimento) e os
// indicadores de dono (capital parado no galpão, giro, fiado em aberto, ponto de
// equilíbrio). ZERO escrita e ZERO migration: cada fatia respeita a flag da sua
// fonte — flag off → aquela fatia vem null/fora e a UI esconde. A varredura da
// comissão NÃO roda aqui de propósito (já roda no boot do painel e no GET da
// Rede; e o sweep ESTORNA lançamento órfão — visão tem que ser leitura barata
// e sem efeito colateral).

export interface FinanceiroReceivableItem {
  tipo: 'fiado' | 'comissao';
  id: string;                 // order id (fiado) ou partner_id (comissao)
  nome: string;
  valor: string;
  due_date: string | null;    // comissão acumulada não tem vencimento
  overdue: boolean;
  phone: string | null;       // deep-link wa.me "Cobrar"
  count?: number;             // comissão: nº de lançamentos em aberto
}

export interface FinanceiroPayableItem {
  tipo: 'fornecedor' | 'despesa';
  id: string;
  nome: string;
  categoria?: string;         // despesa: categoria (pro rótulo da agenda)
  valor: string;
  due_date: string | null;
  overdue: boolean;
}

export interface FinanceiroVisao {
  fontes: { fiado: boolean; comissao: boolean; despesas: boolean };
  mes: {
    faturamento: string;      // 3 pernas somadas (recorte mês São Paulo, régua 0117)
    custo: string;            // custo do pneu vendido (atacado + varejo congelado)
    despesas: string | null;  // ocorridas no mês (competência); null = flag off
    lucro: string;            // faturamento − custo − despesas(0 se off)
    margem_pct: number | null;
    itens_sem_custo: number;  // varejo sem custo congelado → aviso de honestidade
    pernas: {
      atacado: { faturamento: string; lucro: string };
      varejo: { faturamento: string; lucro: string };
      comissao: { realizado: string } | null;
    };
    despesas_categoria: Array<{ category: string; total: string }> | null;
  };
  a_receber: { total: string; vencidos_count: number; itens: FinanceiroReceivableItem[] };
  a_pagar: { total: string; vencidos_count: number; itens: FinanceiroPayableItem[] };
  indicadores: {
    capital_parado: string;   // Σ qty × custo médio do galpão
    pneus_galpao: number;
    giro_dias: number | null;         // capital / (custo vendido em 30d móveis / 30)
    fiado_aberto_pct: number | null;  // % do faturamento do atacado do mês ainda pendente (clamp 100)
    ponto_equilibrio: number | null;  // despesas do mês / margem bruta do mês
  };
}

/** Visão consolidada do Financeiro da matriz (Onda 1). Leitura pura das fontes
 *  existentes; derivados calculados AQUI (não na UI) pra prova de integração cravar. */
export async function getMatrizFinanceiroVisao(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<FinanceiroVisao> {
  const mesWhere = `>= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`;
  const [atacado, varejo, fiado, despesas, ledger, comissaoMes, fiadoAbertoMes, capital, despCat, custo30d] =
    await Promise.all([
      getWholesaleResumo(environment, dbPool, 'mes'),
      getVarejoResumo('mes', environment, dbPool),
      env.WHOLESALE_FINANCE ? getWholesaleFinance(environment, dbPool) : Promise.resolve(null),
      env.MATRIZ_EXPENSES ? getMatrizExpenses(environment, dbPool) : Promise.resolve(null),
      env.NETWORK_COMMISSION_LEDGER ? getCommissionLedger(environment, dbPool) : Promise.resolve(null),
      env.NETWORK_COMMISSION_LEDGER
        ? dbPool.query<{ realizado: string }>(
            `SELECT COALESCE(SUM(commission_amount), 0) AS realizado
               FROM network.commission_entries
              WHERE environment = $1 AND status <> 'reversed'
                AND (realized_at AT TIME ZONE 'America/Sao_Paulo') ${mesWhere}`,
            [environment],
          ).then((r) => r.rows[0]!.realizado)
        : Promise.resolve(null),
      // Fiado do mês em aberto: soma dos ITENS (line_total) das vendas confirmed pending —
      // a MESMA base do denominador (faturamento do atacado = SUM(oi.line_total) do getWholesaleResumo).
      // Antes somava o header (total_amount) contra itens no denominador → venda sem item
      // estourava o % (500%). Agora numerador e denominador batem; clamp em 100 no cálculo.
      env.WHOLESALE_FINANCE
        ? dbPool.query<{ aberto: string }>(
            `SELECT COALESCE(SUM(oi.line_total), 0) AS aberto
               FROM commerce.wholesale_orders o
               JOIN commerce.wholesale_order_items oi
                 ON oi.order_id = o.id AND oi.environment = o.environment
              WHERE o.environment = $1 AND o.status = 'confirmed' AND o.payment_status = 'pending'
                AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') ${mesWhere}`,
            [environment],
          ).then((r) => r.rows[0]!.aberto)
        : Promise.resolve(null),
      dbPool.query<{ capital: string; pneus: number }>(
        `SELECT COALESCE(SUM(quantity_on_hand * unit_cost), 0) AS capital,
                COALESCE(SUM(quantity_on_hand), 0)::int AS pneus
           FROM commerce.wholesale_stock WHERE environment = $1`,
        [environment],
      ).then((r) => r.rows[0]!),
      env.MATRIZ_EXPENSES
        ? dbPool.query<{ category: string; total: string }>(
            `SELECT category, SUM(amount) AS total
               FROM commerce.matriz_expenses
              WHERE environment = $1 AND deleted_at IS NULL
                AND (occurred_at AT TIME ZONE 'America/Sao_Paulo') ${mesWhere}
              GROUP BY category ORDER BY SUM(amount) DESC`,
            [environment],
          ).then((r) => r.rows)
        : Promise.resolve(null),
      // Custo do pneu vendido nos ÚLTIMOS 30 DIAS (janela móvel) — base do GIRO. Mês-calendário
      // encolhe o denominador no dia 2 e o giro estoura; a janela de 30d corridos é estável e
      // é o padrão de mercado. Atacado (unit_cost congelado) + varejo da main (matriz_unit_cost).
      dbPool.query<{ custo: string }>(
        `SELECT
           (SELECT COALESCE(SUM(oi.unit_cost * oi.quantity), 0)
              FROM commerce.wholesale_orders o
              JOIN commerce.wholesale_order_items oi
                ON oi.order_id = o.id AND oi.environment = o.environment
             WHERE o.environment = $1 AND o.status = 'confirmed'
               AND o.created_at >= now() - interval '30 days')
         + (SELECT COALESCE(SUM(oi.matriz_unit_cost * oi.quantity), 0)
              FROM commerce.orders o
              JOIN core.units u ON u.id = o.unit_id AND u.environment = o.environment AND u.slug = 'main'
              JOIN commerce.order_items oi ON oi.order_id = o.id AND oi.environment = o.environment
             WHERE o.environment = $1 AND o.status <> 'cancelled'
               AND o.created_at >= now() - interval '30 days')
           AS custo`,
        [environment],
      ).then((r) => r.rows[0]!.custo),
    ]);

  // Consolidado do mês (competência): faturou − custo do pneu − despesa ocorrida.
  const comissaoRealizada = comissaoMes ? Number(comissaoMes) : 0;
  const faturamento = Number(atacado.faturamento) + Number(varejo.faturamento) + comissaoRealizada;
  const custo = Number(atacado.custo_total) + Number(varejo.custo_total);
  const despesasMes = despCat ? despCat.reduce((s, c) => s + Number(c.total), 0) : null;
  const lucroBruto = Number(atacado.lucro_total) + Number(varejo.lucro_total) + comissaoRealizada;
  const lucro = lucroBruto - (despesasMes ?? 0);
  const margemPct = faturamento > 0 ? Math.round((lucro / faturamento) * 1000) / 10 : null;

  // A RECEBER: fiado do atacado (linha a linha) + comissão acumulada por parceiro.
  const recebiveis: FinanceiroReceivableItem[] = [];
  if (fiado) {
    for (const r of fiado.receivables) {
      recebiveis.push({ tipo: 'fiado', id: r.id, nome: r.counterparty, valor: r.total_amount,
        due_date: r.due_date, overdue: r.overdue, phone: r.phone });
    }
  }
  if (ledger) {
    for (const p of ledger.partners) {
      recebiveis.push({ tipo: 'comissao', id: p.partner_id, nome: p.partner_name,
        valor: p.open_total, due_date: null, overdue: false, phone: p.whatsapp_phone,
        count: p.open_count });
    }
  }
  recebiveis.sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.valor) - Number(a.valor));

  // A PAGAR (agenda): vencido primeiro, depois vencimento mais perto, sem data no fim.
  const pagaveis: FinanceiroPayableItem[] = [];
  if (fiado) {
    for (const p of fiado.payables) {
      pagaveis.push({ tipo: 'fornecedor', id: p.id, nome: p.counterparty, valor: p.total_amount,
        due_date: p.due_date, overdue: p.overdue });
    }
  }
  if (despesas) {
    for (const d of despesas.entries) {
      if (d.payment_status !== 'pending') continue;
      pagaveis.push({ tipo: 'despesa', id: d.id, nome: d.description || d.category,
        categoria: d.category, valor: d.amount, due_date: d.due_date, overdue: d.overdue });
    }
  }
  pagaveis.sort((a, b) => {
    if (a.overdue !== b.overdue) return Number(b.overdue) - Number(a.overdue);
    if (!a.due_date && !b.due_date) return Number(b.valor) - Number(a.valor);
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0;
  });

  // Indicadores de dono. Guardas honestas: sem base → null (a UI mostra "—", não chuta).
  const capitalParado = Number(capital.capital);
  // Giro na janela móvel de 30 dias (não mês-calendário) → estável no começo do mês.
  const custoJanela = Number(custo30d);
  const giroDias = custoJanela > 0 ? Math.round(capitalParado / (custoJanela / 30)) : null;
  const fatAtacado = Number(atacado.faturamento);
  // Mesma base (line_total) nos dois lados + clamp em 100 (nunca > 100% do faturamento).
  const fiadoAbertoPct = fiadoAbertoMes !== null && fatAtacado > 0
    ? Math.min(100, Math.round((Number(fiadoAbertoMes) / fatAtacado) * 100)) : null;
  const margemBrutaFrac = faturamento > 0 ? lucroBruto / faturamento : 0;
  const pontoEquilibrio = despesasMes !== null && despesasMes > 0 && margemBrutaFrac > 0
    ? Math.round(despesasMes / margemBrutaFrac) : null;

  return {
    fontes: {
      fiado: Boolean(env.WHOLESALE_FINANCE),
      comissao: Boolean(env.NETWORK_COMMISSION_LEDGER),
      despesas: Boolean(env.MATRIZ_EXPENSES),
    },
    mes: {
      faturamento: faturamento.toFixed(2),
      custo: custo.toFixed(2),
      despesas: despesasMes !== null ? despesasMes.toFixed(2) : null,
      lucro: lucro.toFixed(2),
      margem_pct: margemPct,
      itens_sem_custo: varejo.itens_sem_custo,
      pernas: {
        atacado: { faturamento: atacado.faturamento, lucro: atacado.lucro_total },
        varejo: { faturamento: varejo.faturamento, lucro: varejo.lucro_total },
        comissao: comissaoMes !== null ? { realizado: Number(comissaoMes).toFixed(2) } : null,
      },
      despesas_categoria: despCat,
    },
    a_receber: {
      total: ((fiado ? Number(fiado.a_receber_total) : 0) + (ledger ? Number(ledger.total_aberto) : 0)).toFixed(2),
      vencidos_count: fiado ? fiado.a_receber_vencidos : 0,
      itens: recebiveis,
    },
    a_pagar: {
      total: ((fiado ? Number(fiado.a_pagar_total) : 0) + (despesas ? Number(despesas.a_pagar_total) : 0)).toFixed(2),
      vencidos_count: (fiado ? fiado.a_pagar_vencidos : 0) + (despesas ? despesas.a_pagar_vencidos : 0),
      itens: pagaveis,
    },
    indicadores: {
      capital_parado: capitalParado.toFixed(2),
      pneus_galpao: capital.pneus,
      giro_dias: giroDias,
      fiado_aberto_pct: fiadoAbertoPct,
      ponto_equilibrio: pontoEquilibrio,
    },
  };
}

// ─── LOGÍSTICA DA MATRIZ (0121) — entregas da 'main' + diário de rota ─────────
// Espelho do parceiro (0068/0069) no pedido da MATRIZ: em separação → saiu →
// entregue / não entregue. Decisões do dono 07-03: diário por SAÍDA (rota com
// km inicial/final + gasolina + comprovantes; as entregas penduram na rota).
// Termômetro NÃO mexe na régua de faturamento (0117 conta não-cancelado);
// "não entregue" CANCELA no caminho atômico (galpão volta pela trilha fdd9148).
// Guard em toda escrita: só pedido de ENTREGA da unit 'main' (parceiro intocado).

const MAIN_DELIVERY_GUARD = `
  o.fulfillment_mode = 'delivery'
  AND EXISTS (SELECT 1 FROM core.units u
               WHERE u.id = o.unit_id AND u.environment = o.environment AND u.slug = 'main')`;

export interface MatrizDeliveryRow {
  order_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  total_amount: string;
  status: string;
  delivery_status: 'pending' | 'dispatched' | 'delivered' | 'failed';
  delivery_courier: string | null;
  trip_id: string | null;
  created_at: string;
  dispatched_at: string | null;
  delivered_at: string | null;
  items: Array<{ quantity: number; label: string }>;
}

export interface MatrizTripRow {
  id: string;
  courier_name: string;
  status: 'open' | 'closed';
  km_start: string | null;
  km_end: string | null;
  fuel_spent: string | null;
  fuel_expense_id: string | null;
  notes: string | null;
  started_at: string;
  ended_at: string | null;
  deliveries_count: number;
  /** "A rota se pagou?" — SÓ das entregas DELIVERED da rota (failed/cancelada fora).
   *  Régua do lucro = a MESMA do varejo 0117 (custo congelado; item sem custo fica
   *  fora do lucro e é CONTADO pra UI avisar — nunca chuta). Frete = total_amount −
   *  itens (o bot embute o frete no total; walk-in sem frete → 0, nunca negativo). */
  resumo: {
    entregues: number;
    frete_total: number;
    faturamento_pneus: number;
    lucro_pneus: number;
    itens_sem_custo: number;
  };
  /** Σ despesas vivas amarradas à rota (fechamento ∪ comprovantes lidos — o IN
   *  dedup cobre o linked_existing; deleted_at IS NULL = dono apagou, rota reflete). */
  despesas_total: string;
  receipts: Array<{
    id: string;
    ai_status: 'pending' | 'parsed' | 'unreadable' | 'skipped';
    ai_summary: string | null;
    ai_expense_id: string | null;
    created_at: string;
  }>;
}

export interface MatrizLogistica {
  abertas: MatrizDeliveryRow[];
  finalizadas: MatrizDeliveryRow[];
  rotas_abertas: MatrizTripRow[];
  rotas_recentes: MatrizTripRow[];
}

/** A tela Logística num GET: entregas da main (abertas + últimas finalizadas) + rotas. */
export async function getMatrizLogistica(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<MatrizLogistica> {
  const deliverySelect = `
    SELECT o.id AS order_id, c.name AS customer_name, c.phone_e164 AS customer_phone,
           o.delivery_address, o.total_amount::text, o.status, o.delivery_status,
           o.delivery_courier, o.trip_id, o.created_at, o.dispatched_at, o.delivered_at,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'quantity', oi.quantity,
                       'label', COALESCE(pr.product_name, 'item')) ORDER BY oi.created_at)
                       FROM commerce.order_items oi
                       LEFT JOIN commerce.products pr ON pr.id = oi.product_id
                      WHERE oi.order_id = o.id AND oi.environment = o.environment), '[]'::jsonb) AS items
      FROM commerce.orders o
      LEFT JOIN core.contacts c ON c.id = o.contact_id
     WHERE o.environment = $1 AND ${MAIN_DELIVERY_GUARD}`;

  const tripSelect = `
    SELECT t.id, t.courier_name, t.status, t.km_start::text, t.km_end::text,
           t.fuel_spent::text, t.fuel_expense_id, t.notes, t.started_at, t.ended_at,
           (SELECT COUNT(*)::int FROM commerce.orders o
             WHERE o.trip_id = t.id AND o.environment = t.environment) AS deliveries_count,
           (SELECT jsonb_build_object(
                     'entregues', COUNT(*),
                     'frete_total', COALESCE(ROUND(SUM(GREATEST(x.total_amount - x.itens_valor, 0)), 2), 0),
                     'faturamento_pneus', COALESCE(ROUND(SUM(x.itens_valor), 2), 0),
                     'lucro_pneus', COALESCE(ROUND(SUM(x.lucro_valor), 2), 0),
                     'itens_sem_custo', COALESCE(SUM(x.itens_sem_custo), 0))
              FROM (SELECT o2.id, o2.total_amount,
                           COALESCE(SUM(oi.quantity * oi.unit_price - oi.discount_amount), 0) AS itens_valor,
                           COALESCE(SUM(CASE WHEN oi.matriz_unit_cost IS NOT NULL
                                             THEN (oi.quantity * oi.unit_price - oi.discount_amount)
                                                  - oi.matriz_unit_cost * oi.quantity END), 0) AS lucro_valor,
                           COUNT(*) FILTER (WHERE oi.matriz_unit_cost IS NULL)::int AS itens_sem_custo
                      FROM commerce.orders o2
                      JOIN commerce.order_items oi
                        ON oi.order_id = o2.id AND oi.environment = o2.environment
                     WHERE o2.trip_id = t.id AND o2.environment = t.environment
                       AND o2.delivery_status = 'delivered' AND o2.status <> 'cancelled'
                     GROUP BY o2.id, o2.total_amount) x) AS resumo,
           (SELECT COALESCE(SUM(e.amount), 0)::text
              FROM commerce.matriz_expenses e
             WHERE e.environment = t.environment AND e.deleted_at IS NULL
               AND (e.id = t.fuel_expense_id
                    OR e.id IN (SELECT r2.ai_expense_id FROM commerce.matriz_trip_receipts r2
                                 WHERE r2.trip_id = t.id AND r2.ai_expense_id IS NOT NULL))) AS despesas_total,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'id', r.id, 'ai_status', r.ai_status, 'ai_summary', r.ai_summary,
                       'ai_expense_id', r.ai_expense_id, 'created_at', r.created_at)
                       ORDER BY r.created_at DESC)
                       FROM commerce.matriz_trip_receipts r
                      WHERE r.trip_id = t.id), '[]'::jsonb) AS receipts
      FROM commerce.matriz_delivery_trips t
     WHERE t.environment = $1 AND t.deleted_at IS NULL`;

  const [abertas, finalizadas, rotasAbertas, rotasRecentes] = await Promise.all([
    dbPool.query<MatrizDeliveryRow>(
      `${deliverySelect} AND o.status <> 'cancelled' AND o.delivery_status IN ('pending','dispatched')
       ORDER BY o.created_at ASC`, [environment]),
    dbPool.query<MatrizDeliveryRow>(
      `${deliverySelect} AND (o.delivery_status IN ('delivered','failed') OR o.status = 'cancelled')
       ORDER BY COALESCE(o.delivered_at, o.updated_at) DESC LIMIT 30`, [environment]),
    dbPool.query<MatrizTripRow>(
      `${tripSelect} AND t.status = 'open' ORDER BY t.started_at DESC`, [environment]),
    dbPool.query<MatrizTripRow>(
      `${tripSelect} AND t.status = 'closed' ORDER BY t.started_at DESC LIMIT 10`, [environment]),
  ]);
  return {
    abertas: abertas.rows,
    finalizadas: finalizadas.rows,
    rotas_abertas: rotasAbertas.rows,
    rotas_recentes: rotasRecentes.rows,
  };
}

/** Saiu pra entrega / entregue. "Não entregue" NÃO passa aqui — é failMatrizDelivery. */
export async function setMatrizDeliveryStatus(
  input: {
    order_id: string;
    status: 'dispatched' | 'delivered';
    courier?: string | null;
    payment_method?: string | null;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; delivery_status: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  // Entregue também fecha o PEDIDO (status delivered — verdade comercial do 0013);
  // a régua de faturamento (0117) não muda: já contava o pedido não-cancelado.
  const r = await dbPool.query<{ order_id: string; delivery_status: string }>(
    `UPDATE commerce.orders o
        SET delivery_status = $3,
            delivery_courier = COALESCE(NULLIF($4, ''), o.delivery_courier),
            dispatched_at = CASE WHEN $3 = 'dispatched' THEN COALESCE(o.dispatched_at, now()) ELSE o.dispatched_at END,
            delivered_at  = CASE WHEN $3 = 'delivered'  THEN now() ELSE o.delivered_at END,
            status        = CASE WHEN $3 = 'delivered'  THEN 'delivered' ELSE o.status END,
            payment_method = CASE WHEN $3 = 'delivered' THEN COALESCE(NULLIF($5, ''), o.payment_method) ELSE o.payment_method END,
            closed_at     = CASE WHEN $3 = 'delivered'  THEN COALESCE(o.closed_at, now()) ELSE o.closed_at END,
            closed_by     = CASE WHEN $3 = 'delivered'  THEN COALESCE(o.closed_by, 'logistica-matriz') ELSE o.closed_by END,
            updated_at    = now()
      WHERE o.id = $2 AND o.environment = $1
        AND o.status <> 'cancelled' AND o.delivery_status <> 'delivered'
        AND ${MAIN_DELIVERY_GUARD}
      RETURNING o.id AS order_id, o.delivery_status`,
    [environment, input.order_id, input.status, input.courier ?? null, input.payment_method ?? null],
  );
  if (!r.rows[0]) throw new Error('delivery_not_found');
  return r.rows[0];
}

/** NÃO ENTREGUE: marca failed E CANCELA o pedido no MESMO caminho atômico do
 *  cancelamento (fdd9148) — galpão volta guiado pela trilha; falhou a devolução,
 *  volta tudo. O motivo fica na trilha do cancel_manual_order. */
export async function failMatrizDelivery(
  input: { order_id: string; reason?: string | null; actor_label?: string | null; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; delivery_status: 'failed' }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const marked = await client.query(
      `UPDATE commerce.orders o
          SET delivery_status = 'failed', updated_at = now()
        WHERE o.id = $2 AND o.environment = $1
          AND o.status <> 'cancelled' AND o.delivery_status <> 'delivered'
          AND ${MAIN_DELIVERY_GUARD}
        RETURNING o.id`,
      [environment, input.order_id],
    );
    if (!marked.rows[0]) throw new Error('delivery_not_found');
    await client.query('SELECT commerce.cancel_manual_order($1, $2, $3)', [
      input.order_id,
      input.actor_label ?? 'logistica-matriz',
      input.reason ?? 'entrega falhou',
    ]);
    await applyMatrizGalpaoReturn(client, environment, input.order_id);
    await client.query('COMMIT');
    return { order_id: input.order_id, delivery_status: 'failed' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** ABRE a rota do dia: cria o diário e pendura as entregas escolhidas (elas saem
 *  pra entrega juntas — dispatched + entregador da rota). */
export async function openMatrizTrip(
  input: {
    courier_name: string;
    km_start?: number | null;
    order_ids?: string[];
    created_by?: string | null;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ trip_id: string; deliveries_count: number }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const courier = input.courier_name.trim();
  if (!courier) throw new Error('courier_required');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const trip = await client.query<{ id: string }>(
      `INSERT INTO commerce.matriz_delivery_trips (environment, courier_name, km_start, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [environment, courier, input.km_start ?? null, input.created_by ?? 'matriz-painel'],
    );
    const tripId = trip.rows[0]!.id;
    let count = 0;
    if (input.order_ids && input.order_ids.length > 0) {
      const upd = await client.query(
        `UPDATE commerce.orders o
            SET trip_id = $3, delivery_status = 'dispatched',
                dispatched_at = COALESCE(o.dispatched_at, now()),
                delivery_courier = $4, updated_at = now()
          WHERE o.id = ANY($2::uuid[]) AND o.environment = $1
            AND o.status <> 'cancelled' AND o.delivery_status IN ('pending','dispatched')
            AND o.trip_id IS NULL
            AND ${MAIN_DELIVERY_GUARD}
          RETURNING o.id`,
        [environment, input.order_ids, tripId, courier],
      );
      count = upd.rowCount ?? 0;
      // Pedido que não entrou (cancelado no meio, já em outra rota, de parceiro):
      // a rota abre com os que valem; a tela mostra quantos entraram.
    }
    // Decisão do dono 07-03c: rota NÃO abre vazia. Sem entrega que de fato entrou
    // (order_ids vazio, ou todos inválidos/de parceiro/já em rota → count 0), o
    // ROLLBACK do catch desfaz o INSERT da trip (nada nasce). O resto se pendura
    // depois com attachOrderToMatrizTrip.
    if (count === 0) throw new Error('trip_needs_delivery');
    await client.query('COMMIT');
    return { trip_id: tripId, deliveries_count: count };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** PENDURA uma entrega numa rota JÁ ABERTA (o "pendurar depois" — decisão do dono
 *  07-03c). Mesmo efeito do vínculo na abertura: amarra trip_id, marca 'dispatched'
 *  e herda o entregador da rota (só se o pedido ainda não tinha um). Só pega entrega
 *  da MAIN, em aberto e FORA de rota (guard + trip_id IS NULL), e só entra em rota
 *  ABERTA. Atômico: o EXISTS da rota aberta é avaliado no próprio UPDATE, então rota
 *  que fecha no meio do caminho não recebe pedido órfão. */
export async function attachOrderToMatrizTrip(
  input: { order_id: string; trip_id: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<{ order_id: string; trip_id: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query<{ order_id: string }>(
    `UPDATE commerce.orders o
        SET trip_id = $3, delivery_status = 'dispatched',
            dispatched_at = COALESCE(o.dispatched_at, now()),
            delivery_courier = COALESCE(o.delivery_courier,
              (SELECT courier_name FROM commerce.matriz_delivery_trips WHERE id = $3 AND environment = $1)),
            updated_at = now()
      WHERE o.id = $2 AND o.environment = $1
        AND o.status <> 'cancelled' AND o.delivery_status IN ('pending','dispatched')
        AND o.trip_id IS NULL
        AND ${MAIN_DELIVERY_GUARD}
        AND EXISTS (SELECT 1 FROM commerce.matriz_delivery_trips t
                     WHERE t.id = $3 AND t.environment = $1 AND t.status = 'open')
      RETURNING o.id AS order_id`,
    [environment, input.order_id, input.trip_id],
  );
  if (r.rows[0]) return { order_id: r.rows[0].order_id, trip_id: input.trip_id };
  // 0 linhas: diagnostica pra dar mensagem útil (pós-fato, não afeta a atomicidade
  // do UPDATE acima). Rota fechada/inexistente → trip_not_open; senão o pedido já
  // saiu do páreo (cancelado, entregue, já em outra rota, ou de parceiro).
  const trip = await dbPool.query<{ status: string }>(
    `SELECT status FROM commerce.matriz_delivery_trips WHERE id = $1 AND environment = $2`,
    [input.trip_id, environment],
  );
  if (!trip.rows[0] || trip.rows[0].status !== 'open') throw new Error('trip_not_open');
  throw new Error('delivery_not_found');
}

/** FECHA a rota: km final + gasolina + observação. Se informou gasolina E nenhum
 *  comprovante desta rota já virou despesa (IA), lança a despesa 'combustivel'
 *  (0120) na MESMA transação — anti-dupla-contagem por desenho. Respeita a flag
 *  MATRIZ_EXPENSES (off = diário grava, lançamento não nasce). */
export async function closeMatrizTrip(
  input: {
    trip_id: string;
    km_end?: number | null;
    fuel_spent?: number | null;
    notes?: string | null;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ trip_id: string; fuel_expense_id: string | null }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const trip = await client.query<{ id: string; courier_name: string; km_start: string | null; started_at: string }>(
      `SELECT id, courier_name, km_start::text, started_at
         FROM commerce.matriz_delivery_trips
        WHERE id = $2 AND environment = $1 AND status = 'open' AND deleted_at IS NULL
        FOR UPDATE`,
      [environment, input.trip_id],
    );
    if (!trip.rows[0]) throw new Error('trip_not_found');
    const t = trip.rows[0];

    const fuel = input.fuel_spent != null && Number(input.fuel_spent) > 0 ? Number(input.fuel_spent) : null;
    let fuelExpenseId: string | null = null;
    if (fuel !== null && env.MATRIZ_EXPENSES) {
      const parsed = await client.query(
        `SELECT 1 FROM commerce.matriz_trip_receipts
          WHERE trip_id = $1 AND ai_expense_id IS NOT NULL LIMIT 1`,
        [input.trip_id],
      );
      if (!parsed.rows[0]) {
        const kmLabel = input.km_end != null && t.km_start != null
          ? ` (km ${Number(t.km_start)}–${Number(input.km_end)})` : '';
        const exp = await client.query<{ id: string }>(
          `INSERT INTO commerce.matriz_expenses
             (environment, category, description, amount, payment_status, paid_at, created_by)
           VALUES ($1, 'combustivel', $2, $3, 'paid', now(), 'logistica-fechamento')
           RETURNING id`,
          [environment,
           `Rota ${new Date(t.started_at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} — ${t.courier_name}${kmLabel}`,
           fuel],
        );
        fuelExpenseId = exp.rows[0]!.id;
      }
    }

    await client.query(
      `UPDATE commerce.matriz_delivery_trips
          SET status = 'closed', ended_at = now(),
              km_end = COALESCE($3, km_end),
              fuel_spent = COALESCE($4, fuel_spent),
              notes = COALESCE(NULLIF($5, ''), notes),
              fuel_expense_id = COALESCE($6, fuel_expense_id)
        WHERE id = $2 AND environment = $1`,
      [environment, input.trip_id, input.km_end ?? null, fuel, input.notes ?? null, fuelExpenseId],
    );
    await client.query('COMMIT');
    return { trip_id: input.trip_id, fuel_expense_id: fuelExpenseId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Anexa um comprovante (bytes JÁ re-encodados pelo funil blindado) à rota. */
export async function addMatrizTripReceipt(
  input: {
    trip_id: string;
    bytes: Buffer;
    mime: string;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ receipt_id: string; ai_status: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const aiStatus = env.MATRIZ_RECEIPT_AI ? 'pending' : 'skipped';
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const trip = await client.query(
      `SELECT 1 FROM commerce.matriz_delivery_trips
        WHERE id = $2 AND environment = $1 AND deleted_at IS NULL`,
      [environment, input.trip_id],
    );
    if (!trip.rows[0]) throw new Error('trip_not_found');
    // Teto de comprovantes por rota (banca 07-03, anti-abuso de storage — blob é BYTEA).
    const count = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM commerce.matriz_trip_receipts WHERE trip_id = $1`,
      [input.trip_id],
    );
    if (Number(count.rows[0]!.n) >= 50) throw new Error('receipt_limit');
    const receipt = await client.query<{ id: string }>(
      `INSERT INTO commerce.matriz_trip_receipts (environment, trip_id, mime, size_bytes, ai_status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [environment, input.trip_id, input.mime, input.bytes.length, aiStatus],
    );
    const receiptId = receipt.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.matriz_trip_receipt_blobs (receipt_id, environment, bytes)
       VALUES ($1, $2, $3)`,
      [receiptId, environment, input.bytes],
    );
    await client.query('COMMIT');
    return { receipt_id: receiptId, ai_status: aiStatus };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Bytes do comprovante pro GET de imagem do painel. */
export async function getMatrizTripReceiptImage(
  receiptId: string,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const r = await dbPool.query<{ bytes: Buffer; mime: string }>(
    `SELECT b.bytes, m.mime
       FROM commerce.matriz_trip_receipt_blobs b
       JOIN commerce.matriz_trip_receipts m ON m.id = b.receipt_id
      WHERE b.receipt_id = $1 AND b.environment = $2`,
    [receiptId, environment],
  );
  return r.rows[0] ?? null;
}

/** Grava o veredito da IA sobre um comprovante. parsed → LANÇA a despesa (0120)
 *  na mesma transação, amarrada ao comprovante (idempotente: comprovante que já
 *  virou despesa não lança de novo). unreadable → só marca (lançar na mão).
 *  ANTI-DUPLA nas DUAS ordens (banca 07-03): se a rota JÁ lançou a despesa no
 *  FECHAMENTO (fuel_expense_id), o comprovante COLA nela como lastro — não cria
 *  segunda despesa da mesma gasolina. O FOR UPDATE na trip serializa com
 *  closeMatrizTrip (fecha a race leitura×fechamento nas duas direções). */
export async function recordReceiptAiResult(
  input: {
    receipt_id: string;
    result:
      | { kind: 'parsed'; category: MatrizExpenseCategory; amount: number; summary: string }
      | { kind: 'unreadable'; summary: string };
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ receipt_id: string; ai_status: string; ai_expense_id: string | null; linked_existing?: boolean }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const receipt = await client.query<{ id: string; trip_id: string; ai_expense_id: string | null }>(
      `SELECT r.id, r.trip_id, r.ai_expense_id
         FROM commerce.matriz_trip_receipts r
        WHERE r.id = $2 AND r.environment = $1
        FOR UPDATE`,
      [environment, input.receipt_id],
    );
    if (!receipt.rows[0]) throw new Error('receipt_not_found');
    if (receipt.rows[0].ai_expense_id) {
      // Já lançado (retry/dupla chamada) — não duplica despesa.
      await client.query('COMMIT');
      return { receipt_id: input.receipt_id, ai_status: 'parsed', ai_expense_id: receipt.rows[0].ai_expense_id };
    }

    if (input.result.kind === 'unreadable') {
      await client.query(
        `UPDATE commerce.matriz_trip_receipts
            SET ai_status = 'unreadable', ai_summary = $3
          WHERE id = $2 AND environment = $1`,
        [environment, input.receipt_id, input.result.summary],
      );
      await client.query('COMMIT');
      return { receipt_id: input.receipt_id, ai_status: 'unreadable', ai_expense_id: null };
    }

    // FOR UPDATE: serializa com closeMatrizTrip (que também trava a trip) —
    // e é aqui que a ordem "fechou lançando manual → leu o comprovante DEPOIS"
    // deixa de duplicar (achado P1 da banca 07-03).
    const trip = await client.query<{ courier_name: string; started_at: string; fuel_expense_id: string | null }>(
      `SELECT courier_name, started_at, fuel_expense_id
         FROM commerce.matriz_delivery_trips WHERE id = $1
         FOR UPDATE`,
      [receipt.rows[0].trip_id],
    );
    const existingFuelExpense = trip.rows[0]?.fuel_expense_id ?? null;
    if (existingFuelExpense) {
      await client.query(
        `UPDATE commerce.matriz_trip_receipts
            SET ai_status = 'parsed', ai_summary = $3, ai_expense_id = $4
          WHERE id = $2 AND environment = $1`,
        [environment, input.receipt_id, `${input.result.summary} · lastro da despesa do fechamento`, existingFuelExpense],
      );
      await client.query('COMMIT');
      return { receipt_id: input.receipt_id, ai_status: 'parsed', ai_expense_id: existingFuelExpense, linked_existing: true };
    }

    const rotaLabel = trip.rows[0]
      ? `Rota ${new Date(trip.rows[0].started_at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} — ${trip.rows[0].courier_name}`
      : 'Rota';
    const exp = await client.query<{ id: string }>(
      `INSERT INTO commerce.matriz_expenses
         (environment, category, description, amount, payment_status, paid_at, created_by)
       VALUES ($1, $2, $3, $4, 'paid', now(), 'ia-comprovante')
       RETURNING id`,
      [environment, input.result.category, `${rotaLabel} · ${input.result.summary}`, input.result.amount],
    );
    await client.query(
      `UPDATE commerce.matriz_trip_receipts
          SET ai_status = 'parsed', ai_summary = $3, ai_expense_id = $4
        WHERE id = $2 AND environment = $1`,
      [environment, input.receipt_id, input.result.summary, exp.rows[0]!.id],
    );
    await client.query('COMMIT');
    return { receipt_id: input.receipt_id, ai_status: 'parsed', ai_expense_id: exp.rows[0]!.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
