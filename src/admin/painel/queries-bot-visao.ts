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

export interface BotVisaoHorarioRow {
  hora: number;
  conversas: number;
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
  /** Conversas iniciadas por hora local; sempre 24 pontos quando a consulta está disponível. */
  horarios: BotVisaoHorarioRow[];
}

/** Visão do bot (cards + funil/perdas + mapa + boca + radar) — carrega ao entrar na aba. */
export async function getBotVisao(
  period: PainelRedePeriod = '30d',
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<BotVisaoPayload> {
  // Janela constante por id (sem input do usuário na string) — mesma régua do getMatrizResumo.
  const todaySql = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
  const sinceSql =
    period === 'today' ? todaySql
    : period === '7d' ? `(${todaySql} - 6)`
    : period === '30d' ? `(${todaySql} - 29)`
    : `date_trunc('month', ${todaySql})::date`;

  const out: BotVisaoPayload = {
    cards: null, mapa: [], sem_regiao: 0, radar: [],
    funil: [], perdas: [], boca: [], medidas_top: [], horarios: [],
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
       WHERE environment = $1 AND dia >= ${sinceSql}`,
      [environment],
    );
    out.cards = r.rows[0] ?? null;
    if (out.cards) {
      // Card "Resumo das últimas 48h" (aba Conversas): régua FIXA de 48h — NÃO
      // acompanha o seletor de período. Conversas distintas com resposta do bot
      // ENTREGUE (mesma régua delivered da campainha/stale-trigger).
      const r48 = await dbPool.query<{ respondidas_bot_48h: number }>(
        `SELECT count(DISTINCT t.conversation_id)::int AS respondidas_bot_48h
         FROM agent.turns t
         WHERE t.environment = $1 AND t.agent_version = 'v2' AND t.status IN ('delivered', 'sent_api_ack')
           AND t.created_at > now() - interval '48 hours'`,
        [environment],
      );
      out.cards.respondidas_bot_48h = r48.rows[0]?.respondidas_bot_48h ?? 0;
    }
  } catch { /* view ausente → cards null, tela avisa */ }

  try {
    // Série horária da mesma população-base dos cards: uma conversa conta uma vez,
    // pela hora em que começou. O limite usa timestamptz para aproveitar o BRIN de
    // started_at; a extração usa o horário civil de São Paulo para os rótulos 00h–23h.
    const r = await dbPool.query<BotVisaoHorarioRow>(
      `WITH horas AS (
         SELECT generate_series(0, 23)::int AS hora
       ), contagem AS (
         SELECT extract(hour FROM c.started_at AT TIME ZONE 'America/Sao_Paulo')::int AS hora,
                count(*)::int AS conversas
         FROM core.conversations c
         WHERE c.environment = $1 AND c.deleted_at IS NULL
           AND c.started_at >= (${sinceSql}::timestamp AT TIME ZONE 'America/Sao_Paulo')
         GROUP BY 1
       )
       SELECT h.hora, COALESCE(c.conversas, 0)::int AS conversas
       FROM horas h
       LEFT JOIN contagem c USING (hora)
       ORDER BY h.hora`,
      [environment],
    );
    out.horarios = r.rows;
  } catch { /* bloco vazio */ }

  try {
    // Funil: stage_reached é a etapa MÁXIMA por conversa. A janela vem dos turnos
    // realmente enviados pelo Bot V2, não do horário em que um backfill foi executado.
    const r = await dbPool.query<{ etapa: string; n: number }>(
      `SELECT cc.value AS etapa, count(DISTINCT cc.conversation_id)::int AS n
       FROM analytics.conversation_classifications cc
       WHERE cc.environment = $1 AND cc.dimension = 'stage_reached'
         AND EXISTS (
           SELECT 1 FROM agent.turns t
           WHERE t.environment = $1 AND t.conversation_id = cc.conversation_id
             AND t.agent_version = 'v2' AND t.status IN ('sent_api_ack', 'delivered')
             AND t.created_at >= ${sinceSql}
         )
       GROUP BY 1`,
      [environment],
    );
    out.funil = r.rows;
  } catch { /* bloco vazio */ }

  try {
    const r = await dbPool.query<{ motivo: string; n: number }>(
      `SELECT cc.value AS motivo, count(DISTINCT cc.conversation_id)::int AS n
       FROM analytics.conversation_classifications cc
       WHERE cc.environment = $1 AND cc.dimension = 'loss_reason'
         AND EXISTS (
           SELECT 1 FROM agent.turns t
           WHERE t.environment = $1 AND t.conversation_id = cc.conversation_id
             AND t.agent_version = 'v2' AND t.status IN ('sent_api_ack', 'delivered')
             AND t.created_at >= ${sinceSql}
         )
       GROUP BY 1 ORDER BY n DESC`,
      [environment],
    );
    out.perdas = r.rows;
  } catch { /* bloco vazio */ }

  try {
    // Boca do cliente: conversas DISTINTAS (não matches crus — 3 "tá caro" na mesma
    // conversa é UMA conversa reclamando). Tipos de dinheiro só; tom (gíria etc.) fora.
    const r = await dbPool.query<{ tipo: string; convs: number }>(
      `SELECT h.hint_type AS tipo, count(DISTINCT h.conversation_id)::int AS convs
       FROM analytics.linguistic_hints h
       WHERE h.environment = $1
         AND EXISTS (
           SELECT 1 FROM core.messages m
           WHERE m.environment = $1 AND m.id = h.message_id
             AND m.deleted_at IS NULL AND m.sent_at >= ${sinceSql}
         )
         AND h.hint_type IN ('objecao_preco','mencao_concorrente','pergunta_parcelamento',
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
         WHERE cf.environment = $1
           AND COALESCE(cf.observed_at, cf.created_at) >= ${sinceSql}
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
      `WITH handled AS (
         SELECT DISTINCT t.conversation_id
         FROM agent.turns t
         WHERE t.environment = $1 AND t.agent_version = 'v2'
           AND t.status IN ('sent_api_ack', 'delivered')
           AND t.created_at >= ${sinceSql}
       )
       SELECT count(*)::int AS sem_regiao
       FROM handled h
       WHERE NOT EXISTS (
         SELECT 1 FROM analytics.conversation_facts cf
         WHERE cf.environment = $1 AND cf.conversation_id = h.conversation_id
           AND cf.fact_key = 'municipio_entrega'
       )`,
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
       LEFT JOIN LATERAL (
         SELECT sum(ws.quantity_on_hand)::int AS quantity_on_hand
           FROM commerce.wholesale_stock ws
          WHERE ws.environment=$1
            AND lower(ws.measure)=lower(cf.fact_value->>'medida')
       ) s ON true
       WHERE cf.environment = $1 AND cf.fact_key = 'faltou_estoque'
         AND COALESCE(cf.observed_at, cf.created_at) >= ${sinceSql}
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
       LEFT JOIN LATERAL (
         SELECT sum(ws.quantity_on_hand)::int AS quantity_on_hand
           FROM commerce.wholesale_stock ws
          WHERE ws.environment=$1
            AND lower(ws.measure)=lower(replace(cf.fact_value::text, '"', ''))
       ) s ON true
       WHERE cf.environment = $1 AND cf.fact_key = 'medida_consultada'
         AND COALESCE(cf.observed_at, cf.created_at) >= ${sinceSql}
       GROUP BY 1
       ORDER BY consultas DESC
       LIMIT 10`,
      [environment],
    );
    out.medidas_top = r.rows;
  } catch { /* bloco vazio */ }

  return out;
}
