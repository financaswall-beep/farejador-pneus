// TELA DO BOT — CAMPAINHA (2026-07-06): quem o cliente está ESPERANDO agora.
// core.messages × agent.turns (mesma régua da trava anti-requentado, invertida:
// lá descarta o já-respondido, aqui acende o não-respondido) + fact 'escalou'.
// A VISÃO da aba (cards/funil/mapa/boca/radar) mora em queries-bot-visao.ts
// (fatia 2, corte por assunto). SÓ LEITURA, admin-only. Zero grant pro parceiro.
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export interface BotCampainhaPayload {
  /** Conversas com a ÚLTIMA mensagem do cliente SEM resposta do bot ou humano
   *  (sem expiração; ≥5 min de espera pra não alarmar conversa em andamento). */
  mudas: Array<{
    conversation_id: string;
    chatwoot_conversation_id: string;
    contact_name: string | null;
    channel_type: string | null;
    bot_mode: 'auto' | 'human';
    preview: string;
    quando: string;
    minutos: number;
  }>;
  /** Encaminhamentos ainda abertos, sem expiração por idade (fact 'escalou'). */
  escalados: Array<{
    conversation_id: string;
    chatwoot_conversation_id: string;
    contact_name: string | null;
    channel_type: string | null;
    bot_mode: 'auto' | 'human';
    motivo: string | null;
    quando: string;
    last_customer_at: string | null;
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
    `WITH respondida AS (
       SELECT t.conversation_id, max(tm.sent_at) AS trigger_at
       FROM agent.turns t
       JOIN core.messages tm ON tm.id = t.trigger_message_id AND tm.environment=t.environment
         AND tm.conversation_id=t.conversation_id AND tm.deleted_at IS NULL
       WHERE t.environment = $1 AND t.agent_version = 'v2' AND t.status IN ('delivered', 'sent_api_ack')
       GROUP BY t.conversation_id
     )
     SELECT cv.id AS conversation_id,
            cv.chatwoot_conversation_id::text AS chatwoot_conversation_id,
            ct.name AS contact_name,
            cv.channel_type, COALESCE(bc.mode,'auto') AS bot_mode,
            u.preview, u.sent_at::text AS quando,
            floor(extract(epoch FROM (now() - u.sent_at)) / 60)::int AS minutos
     FROM core.conversations cv
     JOIN LATERAL (
       SELECT m.sent_at, left(coalesce(m.content, '(sem texto — mídia/áudio)'), 140) AS preview
       FROM core.messages m
       WHERE m.environment=cv.environment AND m.conversation_id=cv.id
         AND m.sender_type='contact' AND m.is_private=false AND m.deleted_at IS NULL
       ORDER BY m.sent_at DESC, m.chatwoot_message_id DESC LIMIT 1
     ) u ON true
     LEFT JOIN core.contacts ct ON ct.id = cv.contact_id AND ct.environment=cv.environment AND ct.deleted_at IS NULL
     LEFT JOIN ops.conversation_bot_control bc ON bc.conversation_id=cv.id AND bc.environment=cv.environment
     LEFT JOIN respondida r ON r.conversation_id = cv.id
     WHERE cv.environment=$1 AND cv.deleted_at IS NULL AND cv.current_status <> 'resolved'
       AND u.sent_at <= now() - interval '5 minutes'
       AND (r.trigger_at IS NULL OR u.sent_at > r.trigger_at)
       AND NOT EXISTS (
         SELECT 1 FROM core.messages h
         WHERE h.environment=cv.environment AND h.conversation_id=cv.id AND h.sent_at>=u.sent_at
           AND h.sender_type='user' AND h.message_type=1 AND h.is_private=false
           AND h.deleted_at IS NULL AND h.status IS DISTINCT FROM 'failed'
           AND NOT EXISTS (SELECT 1 FROM agent.turns t WHERE t.environment=h.environment
             AND t.conversation_id=h.conversation_id AND t.chatwoot_message_id=h.chatwoot_message_id)
           AND NOT EXISTS (SELECT 1 FROM ops.outbound_messages o WHERE o.environment=h.environment
             AND o.conversation_id=h.conversation_id AND (o.provider_message_id=h.chatwoot_message_id
               OR (o.attempts>0 AND o.echo_id IS NOT NULL
                 AND (o.echo_id=h.echo_id OR o.echo_id=h.content_attributes->>'farejador_echo_id'))))
       )
     ORDER BY u.sent_at ASC, cv.id`,
    [environment],
  );

  const escalados = await dbPool.query<BotCampainhaPayload['escalados'][number]>(
    `SELECT cf.conversation_id,
            cv.chatwoot_conversation_id::text AS chatwoot_conversation_id,
            ct.name AS contact_name,
            cv.channel_type, COALESCE(bc.mode,'auto') AS bot_mode,
            cf2.motivo,
            max(cf.created_at)::text AS quando, ultima.sent_at::text AS last_customer_at
     FROM analytics.conversation_facts cf
     JOIN core.conversations cv ON cv.id = cf.conversation_id AND cv.environment=cf.environment AND cv.deleted_at IS NULL
     LEFT JOIN core.contacts ct ON ct.id = cv.contact_id AND ct.environment=cv.environment AND ct.deleted_at IS NULL
     LEFT JOIN ops.conversation_bot_control bc ON bc.conversation_id=cv.id AND bc.environment=cv.environment
     LEFT JOIN LATERAL (
       SELECT max(m.sent_at) AS sent_at FROM core.messages m
       WHERE m.environment=cv.environment AND m.conversation_id=cv.id
         AND m.sender_type='contact' AND m.is_private=false AND m.deleted_at IS NULL
     ) ultima ON true
     LEFT JOIN LATERAL (
       SELECT replace(f.fact_value::text, '"', '') AS motivo
       FROM analytics.conversation_facts f
       WHERE f.environment=cf.environment AND f.conversation_id=cf.conversation_id
         AND f.fact_key='motivo_escalacao' AND f.superseded_by IS NULL
       ORDER BY f.created_at DESC, f.id DESC LIMIT 1
     ) cf2 ON true
     WHERE cf.environment = $1 AND cf.fact_key = 'escalou'
       AND cf.fact_value='true'::jsonb AND cf.superseded_by IS NULL
       AND cv.current_status <> 'resolved'
       AND (bc.resumed_at IS NULL OR cf.created_at>bc.resumed_at)
     GROUP BY cf.conversation_id, cv.chatwoot_conversation_id, ct.name, cv.channel_type, bc.mode, cf2.motivo, ultima.sent_at
     ORDER BY max(cf.created_at) ASC, cf.conversation_id`,
    [environment],
  );

  return { mudas: mudas.rows, escalados: escalados.rows };
}
