// TELA DO BOT — CAMPAINHA (2026-07-06): quem o cliente está ESPERANDO agora.
// core.messages × agent.turns (mesma régua da trava anti-requentado, invertida:
// lá descarta o já-respondido, aqui acende o não-respondido) + fact 'escalou'.
// A VISÃO da aba (cards/funil/mapa/boca/radar) mora em queries-bot-visao.ts
// (fatia 2, corte por assunto). SÓ LEITURA, admin-only. Zero grant pro parceiro.
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

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
