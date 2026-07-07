// TELA DO BOT (2026-07-06): agregadores SÓ-LEITURA do atendente pro painel da matriz.
// Nenhuma tabela nova — tudo deriva do que os sensores JÁ gravam:
//   • campainha: core.messages × agent.turns (mesma régua da trava anti-requentado,
//     invertida: quem o cliente está ESPERANDO) + fact 'escalou' (pediu humano);
//   • visão: analytics.v_daily_metrics (cards) + facts por município (mapa) +
//     fact 'faltou_estoque' × galpão (radar de reposição).
// SÓ LEITURA, admin-only (dono). Zero grant pro parceiro — nada daqui é servido a ele.
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { PainelRedePeriod } from './queries-pedidos.js';

export interface BotCampainhaPayload {
  /** Conversas com a ÚLTIMA mensagem do cliente SEM resposta entregue do bot
   *  (janela 24h; ≥5 min de espera pra não alarmar conversa em andamento). */
  mudas: Array<{
    conversation_id: string;
    chatwoot_conversation_id: string;
    contact_name: string | null;
    preview: string;
    minutos: number;
  }>;
  /** Conversas em que o bot escalou pra humano nas últimas 48h (fact 'escalou'). */
  escalados: Array<{
    conversation_id: string;
    chatwoot_conversation_id: string;
    contact_name: string | null;
    motivo: string | null;
    quando: string;
  }>;
}

/** Campainha do bot — leve de propósito (roda no load e no refresh de 15s). */
export async function getBotCampainha(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<BotCampainhaPayload> {
  // "Muda" = última msg do CLIENTE mais nova que o gatilho da última resposta
  // ENTREGUE (agent.turns delivered → trigger_message_id), espelho da régua do
  // stale-trigger: lá descarta o já-respondido; aqui acende o NÃO-respondido.
  // sent_at (hora REAL da mensagem, chave da partição/índice) — nunca created_at,
  // que é hora de INGESTÃO (um replay atrasado inventaria "cliente esperando").
  const mudas = await dbPool.query<BotCampainhaPayload['mudas'][number]>(
    `WITH ultima_msg AS (
       SELECT DISTINCT ON (m.conversation_id)
              m.conversation_id, m.sent_at,
              left(coalesce(m.content, '(sem texto — mídia/áudio)'), 140) AS preview
       FROM core.messages m
       WHERE m.environment = $1 AND m.sender_type = 'contact' AND m.is_private = false
         AND m.sent_at > now() - interval '24 hours'
       ORDER BY m.conversation_id, m.sent_at DESC
     ),
     respondida AS (
       SELECT t.conversation_id, max(tm.sent_at) AS trigger_at
       FROM agent.turns t
       JOIN core.messages tm ON tm.id = t.trigger_message_id
       WHERE t.environment = $1 AND t.agent_version = 'v2' AND t.status = 'delivered'
       GROUP BY t.conversation_id
     )
     SELECT u.conversation_id,
            cv.chatwoot_conversation_id::text AS chatwoot_conversation_id,
            ct.name AS contact_name,
            u.preview,
            floor(extract(epoch FROM (now() - u.sent_at)) / 60)::int AS minutos
     FROM ultima_msg u
     JOIN core.conversations cv ON cv.id = u.conversation_id
     LEFT JOIN core.contacts ct ON ct.id = cv.contact_id
     LEFT JOIN respondida r ON r.conversation_id = u.conversation_id
     WHERE u.sent_at <= now() - interval '5 minutes'
       AND (r.trigger_at IS NULL OR u.sent_at > r.trigger_at)
     ORDER BY u.sent_at ASC
     LIMIT 20`,
    [environment],
  );

  const escalados = await dbPool.query<BotCampainhaPayload['escalados'][number]>(
    `SELECT cf.conversation_id,
            cv.chatwoot_conversation_id::text AS chatwoot_conversation_id,
            ct.name AS contact_name,
            replace(max(cf2.fact_value::text), '"', '') AS motivo,
            max(cf.created_at)::text AS quando
     FROM analytics.conversation_facts cf
     JOIN core.conversations cv ON cv.id = cf.conversation_id
     LEFT JOIN core.contacts ct ON ct.id = cv.contact_id
     LEFT JOIN analytics.conversation_facts cf2
       ON cf2.environment = $1 AND cf2.conversation_id = cf.conversation_id
      AND cf2.fact_key = 'motivo_escalacao'
      AND cf2.created_at > now() - interval '48 hours'
     WHERE cf.environment = $1 AND cf.fact_key = 'escalou'
       AND cf.created_at > now() - interval '48 hours'
     GROUP BY cf.conversation_id, cv.chatwoot_conversation_id, ct.name
     ORDER BY quando DESC
     LIMIT 10`,
    [environment],
  );

  return { mudas: mudas.rows, escalados: escalados.rows };
}

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
}

/** Visão do bot (mapa + radar + cards) — carrega ao entrar na aba; janela por período. */
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

  let cards: Record<string, unknown> | null = null;
  let mapa: BotVisaoMapaRow[] = [];
  let semRegiao = 0;
  let radar: BotVisaoRadarRow[] = [];

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
         COALESCE(sum(conv_madrugada), 0)::int AS conv_madrugada,
         COALESCE(sum(conv_manha), 0)::int AS conv_manha,
         COALESCE(sum(conv_tarde), 0)::int AS conv_tarde,
         COALESCE(sum(conv_noite), 0)::int AS conv_noite
       FROM analytics.v_daily_metrics
       WHERE dia >= ${sinceSql}`,
    );
    cards = r.rows[0] ?? null;
  } catch { /* view ausente → cards null, tela avisa */ }

  try {
    // Município do sensor vem CANÔNICO do dicionário ("Maricá", "Duque de Caxias") —
    // mesmo nome do IBGE usado no desenho do mapa; o front casa por nome normalizado.
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
    mapa = r.rows;
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
    semRegiao = r.rows[0]?.sem_regiao ?? 0;
  } catch { /* 0 */ }

  try {
    // Radar: o que pediram e a Rede NÃO tinha, por medida — cruzado com o galpão
    // (galpao_qty null = medida nem existe no estoque da matriz). Melhor esforço no
    // casamento de medida (o galpão guarda a medida canônica; o fact, a consultada).
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
    radar = r.rows;
  } catch { /* bloco vazio */ }

  return { cards, mapa, sem_regiao: semRegiao, radar };
}
