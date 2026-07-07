// TELA DO BOT — VISÃO (fatia 2, 2026-07-06): agregadores SÓ-LEITURA da aba Bot.
// Fatiado de queries-bot.ts por ASSUNTO (lá fica a campainha; aqui, o que carrega
// ao entrar na aba). Nenhuma tabela nova — deriva das 3 camadas que o gerador de
// analytics JÁ grava (trigger em agent.turns, baseline 0102 + 0103/0104):
//   • facts (tool calls): município, pedido_criado, faltou_estoque, medida_consultada;
//   • classifications: stage_reached (funil) + loss_reason (perda por motivo);
//   • linguistic_hints: objeção de preço, concorrente, parcelamento… (regex ≈ termômetro).
// SÓ LEITURA, admin-only (dono). Zero grant pro parceiro.
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { PainelRedePeriod } from './queries-pedidos.js';

export interface BotVisaoMapaRow {
  municipio: string;
  chamou: number;
  pediu: number;
  efetivou: number;
  faltou: number;
}

export interface BotVisaoRadarRow {
  medida: string;
  pedidos: number;
  fora_catalogo: number;
  sem_estoque_perto: number;
  galpao_qty: number | null;
}

export interface BotVisaoPayload {
  cards: Record<string, unknown> | null;
  mapa: BotVisaoMapaRow[];
  sem_regiao: number;
  radar: BotVisaoRadarRow[];
  /** Distribuição de stage_reached (onde a conversa PAROU); o front acumula o funil. */
  funil: Array<{ etapa: string; n: number }>;
  /** loss_reason das que não fecharam — a perda POR MOTIVO. */
  perdas: Array<{ motivo: string; n: number }>;
  /** Sinais de linguagem (conversas distintas) — termômetro por palavra-chave. */
  boca: Array<{ tipo: string; convs: number }>;
  /** Medidas mais CONSULTADAS (mesmo quando tinha) × galpão — reposição preventiva. */
  medidas_top: Array<{ medida: string; consultas: number; galpao_qty: number | null }>;
}

/** Visão do bot (cards + funil/perdas + mapa + boca + radar) — carrega ao entrar na aba. */
export async function getBotVisao(
  period: PainelRedePeriod = '30d',
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<BotVisaoPayload> {
  // Janela constante por id (sem input do usuário na string) — mesma régua do getMatrizResumo.
  const sinceSql =
    period === 'today' ? `current_date`
    : period === '7d' ? `(current_date - 6)`
    : period === '30d' ? `(current_date - 29)`
    : `date_trunc('month', current_date)::date`;

  const out: BotVisaoPayload = {
    cards: null, mapa: [], sem_regiao: 0, radar: [],
    funil: [], perdas: [], boca: [], medidas_top: [],
  };

  // Defensivo por bloco (padrão getMatrizResumo): um bloco quebrado não derruba a tela.
  try {
    const r = await dbPool.query(
      `SELECT
         COALESCE(sum(conversas_total), 0)::int AS conversas,
         COALESCE(sum(fecharam), 0)::int AS fecharam,
         COALESCE(sum(escalaram), 0)::int AS escalaram,
         COALESCE(sum(abandonaram), 0)::int AS abandonaram,
         COALESCE(sum(custo_bot_brl), 0)::numeric AS custo_bot,
         CASE WHEN sum(conversas_total) > 0
              THEN round(100.0 * sum(fecharam) / sum(conversas_total), 1) ELSE 0 END AS taxa_conversao,
         COALESCE(sum(faturamento), 0)::numeric AS faturamento,
         CASE WHEN sum(fecharam) > 0
              THEN round(sum(faturamento) / sum(fecharam), 2) ELSE NULL END AS ticket_medio,
         round(avg(resposta_media_seg) FILTER (WHERE resposta_media_seg IS NOT NULL))::int AS resposta_seg,
         COALESCE(sum(conv_madrugada), 0)::int AS conv_madrugada,
         COALESCE(sum(conv_manha), 0)::int AS conv_manha,
         COALESCE(sum(conv_tarde), 0)::int AS conv_tarde,
         COALESCE(sum(conv_noite), 0)::int AS conv_noite
       FROM analytics.v_daily_metrics
       WHERE dia >= ${sinceSql}`,
    );
    out.cards = r.rows[0] ?? null;
  } catch { /* view ausente → cards null, tela avisa */ }

  try {
    // Funil: stage_reached é a etapa MÁXIMA por conversa (o gerador reclassifica a
    // cada turno — created_at acompanha a última atividade, mesma janela dos facts).
    const r = await dbPool.query<{ etapa: string; n: number }>(
      `SELECT value AS etapa, count(DISTINCT conversation_id)::int AS n
       FROM analytics.conversation_classifications
       WHERE environment = $1 AND dimension = 'stage_reached' AND created_at >= ${sinceSql}
       GROUP BY 1`,
      [environment],
    );
    out.funil = r.rows;
  } catch { /* bloco vazio */ }

  try {
    const r = await dbPool.query<{ motivo: string; n: number }>(
      `SELECT value AS motivo, count(DISTINCT conversation_id)::int AS n
       FROM analytics.conversation_classifications
       WHERE environment = $1 AND dimension = 'loss_reason' AND created_at >= ${sinceSql}
       GROUP BY 1 ORDER BY n DESC`,
      [environment],
    );
    out.perdas = r.rows;
  } catch { /* bloco vazio */ }

  try {
    // Boca do cliente: conversas DISTINTAS (não matches crus — 3 "tá caro" na mesma
    // conversa é UMA conversa reclamando). Tipos de dinheiro só; tom (gíria etc.) fora.
    const r = await dbPool.query<{ tipo: string; convs: number }>(
      `SELECT hint_type AS tipo, count(DISTINCT conversation_id)::int AS convs
       FROM analytics.linguistic_hints
       WHERE environment = $1 AND created_at >= ${sinceSql}
         AND hint_type IN ('objecao_preco','mencao_concorrente','pergunta_parcelamento',
                           'pergunta_garantia','pediu_instalacao','urgencia')
       GROUP BY 1`,
      [environment],
    );
    out.boca = r.rows;
  } catch { /* bloco vazio */ }

  try {
    // Município do sensor vem CANÔNICO do dicionário — mesmo nome do IBGE do desenho.
    const r = await dbPool.query<BotVisaoMapaRow>(
      `WITH conv AS (
         SELECT cf.conversation_id,
                replace(max(cf.fact_value::text) FILTER (WHERE cf.fact_key = 'municipio_entrega'), '"', '') AS municipio,
                bool_or(cf.fact_key = 'faltou_estoque') AS faltou,
                bool_or(cf.fact_key = 'pedido_criado') AS pediu_fact
         FROM analytics.conversation_facts cf
         WHERE cf.environment = $1 AND cf.created_at >= ${sinceSql}
         GROUP BY cf.conversation_id
       )
       SELECT c.municipio,
              count(DISTINCT c.conversation_id)::int AS chamou,
              count(DISTINCT c.conversation_id)
                FILTER (WHERE c.pediu_fact OR o.id IS NOT NULL)::int AS pediu,
              count(DISTINCT c.conversation_id)
                FILTER (WHERE po.delivery_status = 'delivered' OR o.delivery_status = 'delivered')::int AS efetivou,
              count(DISTINCT c.conversation_id) FILTER (WHERE c.faltou)::int AS faltou
       FROM conv c
       LEFT JOIN commerce.orders o
         ON o.source_conversation_id = c.conversation_id
        AND o.environment = $1 AND o.status <> 'cancelled'
       LEFT JOIN commerce.partner_orders po ON po.id = o.partner_order_id
       WHERE c.municipio IS NOT NULL
       GROUP BY c.municipio
       ORDER BY chamou DESC`,
      [environment],
    );
    out.mapa = r.rows;
  } catch { /* bloco vazio */ }

  try {
    const r = await dbPool.query<{ sem_regiao: number }>(
      `SELECT count(*)::int AS sem_regiao FROM (
         SELECT cf.conversation_id
         FROM analytics.conversation_facts cf
         WHERE cf.environment = $1 AND cf.created_at >= ${sinceSql}
         GROUP BY cf.conversation_id
         HAVING max(cf.fact_value::text) FILTER (WHERE cf.fact_key = 'municipio_entrega') IS NULL
       ) s`,
      [environment],
    );
    out.sem_regiao = r.rows[0]?.sem_regiao ?? 0;
  } catch { /* 0 */ }

  try {
    // Radar: o que pediram e a Rede NÃO tinha, por medida — cruzado com o galpão.
    const r = await dbPool.query<BotVisaoRadarRow>(
      `SELECT (cf.fact_value->>'medida') AS medida,
              count(*)::int AS pedidos,
              count(*) FILTER (WHERE cf.fact_value->>'motivo' = 'fora_de_catalogo')::int AS fora_catalogo,
              count(*) FILTER (WHERE cf.fact_value->>'motivo' = 'sem_estoque_perto')::int AS sem_estoque_perto,
              max(s.quantity_on_hand)::int AS galpao_qty
       FROM analytics.conversation_facts cf
       LEFT JOIN commerce.wholesale_stock s
         ON s.environment = $1 AND lower(s.measure) = lower(cf.fact_value->>'medida')
       WHERE cf.environment = $1 AND cf.fact_key = 'faltou_estoque'
         AND cf.created_at >= ${sinceSql}
         AND (cf.fact_value->>'medida') IS NOT NULL
       GROUP BY 1
       ORDER BY pedidos DESC
       LIMIT 15`,
      [environment],
    );
    out.radar = r.rows;
  } catch { /* bloco vazio */ }

  try {
    // Reposição PREVENTIVA: tudo que consultaram (achando ou não) × estoque do galpão.
    const r = await dbPool.query<{ medida: string; consultas: number; galpao_qty: number | null }>(
      `SELECT replace(cf.fact_value::text, '"', '') AS medida,
              count(*)::int AS consultas,
              max(s.quantity_on_hand)::int AS galpao_qty
       FROM analytics.conversation_facts cf
       LEFT JOIN commerce.wholesale_stock s
         ON s.environment = $1 AND lower(s.measure) = lower(replace(cf.fact_value::text, '"', ''))
       WHERE cf.environment = $1 AND cf.fact_key = 'medida_consultada'
         AND cf.created_at >= ${sinceSql}
       GROUP BY 1
       ORDER BY consultas DESC
       LIMIT 10`,
      [environment],
    );
    out.medidas_top = r.rows;
  } catch { /* bloco vazio */ }

  return out;
}
