import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

export interface BotControl {
  mode: 'auto' | 'human'; version: number; resumed_at: string | null;
  last_human_at: string | null; last_human_message_id: string | null;
}

/** Lock TRANSACIONAL: compatível com o pooler Supabase em modo transaction.
 * O caller mantém BEGIN até o fim do envio + confirmação, com timeout HTTP limitado. */
export async function lockBotConversation(client: PoolClient, environment: Environment,
  conversationId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`bot-control:${environment}:${conversationId}`]);
}

export async function ensureBotControl(client: PoolClient, environment: Environment,
  conversationId: string): Promise<BotControl> {
  await client.query(`INSERT INTO ops.conversation_bot_control(environment,conversation_id)
    SELECT environment,id FROM core.conversations WHERE environment=$1 AND id=$2 AND deleted_at IS NULL
    ON CONFLICT (environment,conversation_id) DO NOTHING`, [environment,conversationId]);
  // Texto preserva os microssegundos do PostgreSQL. Date/pg reduziria para ms,
  // fazendo o mesmo evento parecer mais novo ao reprocessar e reabrindo a pausa.
  const result = await client.query<BotControl>(`SELECT mode,version,resumed_at::text AS resumed_at,
    last_human_at::text AS last_human_at,last_human_message_id
    FROM ops.conversation_bot_control WHERE environment=$1 AND conversation_id=$2`, [environment,conversationId]);
  if (!result.rows[0]) throw new Error('bot_conversation_not_found');
  return result.rows[0];
}

export async function cancelConversationBotQueue(client: PoolClient, environment: Environment,
  conversationId: string): Promise<void> {
  await client.query(`UPDATE ops.outbound_messages SET status='superseded',locked_at=NULL,locked_by=NULL,
      last_error_kind='superseded',last_error_summary='human_takeover',updated_at=now()
    WHERE environment=$1 AND conversation_id=$2 AND status IN ('pending','failed','sending')`,
  [environment,conversationId]);
  await client.query(`UPDATE ops.atendente_jobs SET status='superseded',locked_at=NULL,locked_by=NULL,
      processed_at=now(),error_message='superseded:human_takeover'
    WHERE environment=$1 AND conversation_id=$2 AND status IN ('pending','processing','failed')`,
  [environment,conversationId]);
}

/** Invocar com lock da conversa. Prova de autoria: id confirmado OU correlação
 * da própria outbox em envio. Nunca usa texto, nome, ou id do usuário da API. */
export async function syncHumanIntervention(client: PoolClient, environment: Environment,
  conversationId: string): Promise<BotControl> {
  let state = await ensureBotControl(client,environment,conversationId);
  const human = await client.query<{ chatwoot_message_id: string; sent_at: string }>(
    `SELECT m.chatwoot_message_id,m.sent_at::text AS sent_at FROM core.messages m
      WHERE m.environment=$1 AND m.conversation_id=$2 AND m.sender_type='user'
        AND m.message_type=1 AND m.is_private=false
        AND ($3::timestamptz IS NULL OR m.sent_at>$3)
        AND ($4::timestamptz IS NULL OR (m.sent_at,m.chatwoot_message_id)>($4,$5::bigint))
        AND NOT EXISTS (SELECT 1 FROM ops.outbound_messages o
          WHERE o.environment=m.environment AND o.conversation_id=m.conversation_id
            AND (o.provider_message_id=m.chatwoot_message_id OR
              (o.attempts>0 AND o.echo_id IS NOT NULL AND
                (o.echo_id=m.echo_id OR o.echo_id=m.content_attributes->>'farejador_echo_id'))))
        AND NOT EXISTS (SELECT 1 FROM agent.turns t WHERE t.environment=m.environment
          AND t.conversation_id=m.conversation_id AND t.chatwoot_message_id=m.chatwoot_message_id)
      ORDER BY m.sent_at DESC,m.chatwoot_message_id DESC LIMIT 1`,
    [environment,conversationId,state.resumed_at,state.last_human_at,state.last_human_message_id]);
  const message = human.rows[0];
  if (!message) return state;
  const updated = await client.query<BotControl>(`UPDATE ops.conversation_bot_control
    SET mode='human',version=version+1,last_human_at=$3,last_human_message_id=$4,
      updated_by='chatwoot:human',updated_at=now()
    WHERE environment=$1 AND conversation_id=$2
    RETURNING mode,version,resumed_at::text AS resumed_at,last_human_at::text AS last_human_at,last_human_message_id`,
  [environment,conversationId,message.sent_at,message.chatwoot_message_id]);
  state = updated.rows[0]!;
  await client.query(`INSERT INTO ops.conversation_bot_control_events
      (environment,conversation_id,version,action,actor,chatwoot_message_id)
    VALUES ($1,$2,$3,'human_message','chatwoot:human',$4)`,
  [environment,conversationId,state.version,message.chatwoot_message_id]);
  await cancelConversationBotQueue(client,environment,conversationId);
  return state;
}

/** Falha de banco interrompe o agente: nunca interpretar indisponibilidade como autorização. */
export async function botMayProcessTrigger(client: PoolClient, environment: Environment,
  conversationId: string, triggerMessageId: string): Promise<boolean> {
  await client.query('BEGIN');
  try {
    await lockBotConversation(client,environment,conversationId);
    const state = await syncHumanIntervention(client,environment,conversationId);
    const trigger = await client.query<{ allowed: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM core.messages WHERE environment=$1 AND conversation_id=$2 AND id=$3
        AND sender_type='contact' AND is_private=false
        AND ($4::timestamptz IS NULL OR sent_at>$4)) AS allowed`,
    [environment,conversationId,triggerMessageId,state.resumed_at]);
    await client.query('COMMIT');
    return state.mode==='auto' && trigger.rows[0]?.allowed===true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
