import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';

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
  const realizedWhere = `po.status <> 'cancelled' AND po.deleted_at IS NULL AND NOT (po.fulfillment_mode = 'delivery' AND po.delivery_status <> 'delivered')`;
  const realizedDate = `(CASE WHEN po.fulfillment_mode = 'delivery' THEN po.delivered_at ELSE po.created_at END)`;
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
         SELECT po.created_at AS event_at,
                jsonb_build_object(
                  'type', 'Venda',
                  'event_at', po.created_at,
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
            AND po.status <> 'cancelled'
            AND po.deleted_at IS NULL
            AND po.created_at >= ${periodStartSql}::timestamptz
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

  return { order_id: result.rows[0]!.order_id };
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
