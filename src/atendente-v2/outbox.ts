import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { recordOutboundEvent } from './outbound-events.js';

export interface AgentTextOutboxInput {
  environment: Environment;
  conversationId: string;
  triggerMessageId: string;
  jobId: string;
  chatwootConversationId: number;
  body: string;
  actionsJson: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface AgentTextOutboxResult {
  status: 'queued' | 'already_sent' | 'superseded';
  turnId?: string;
  outboundId?: string;
  chatwootMessageId?: number | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function hasNewerCustomerMessageAfterTrigger(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  triggerMessageId: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `WITH trigger_msg AS (
       SELECT sent_at FROM core.messages
        WHERE environment = $1 AND id = $3 LIMIT 1
     )
     SELECT m.id
       FROM core.messages m, trigger_msg t
      WHERE m.environment = $1 AND m.conversation_id = $2
        AND m.sender_type = 'contact' AND m.is_private = false
        AND m.sent_at > t.sent_at
      ORDER BY m.sent_at DESC LIMIT 1`,
    [environment, conversationId, triggerMessageId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Persiste o rascunho e encerra. O envio externo pertence ao worker da outbox;
 * assim o job do agente nunca precisa repetir tool calls só porque o Chatwoot caiu.
 */
export async function sendAgentTextWithOutbox(
  client: PoolClient,
  input: AgentTextOutboxInput,
): Promise<AgentTextOutboxResult> {
  const newerMessageId = await hasNewerCustomerMessageAfterTrigger(
    client, input.environment, input.conversationId, input.triggerMessageId,
  );
  if (newerMessageId) {
    const superseded = await client.query<{ id: string }>(
      `INSERT INTO ops.outbound_messages (
         environment, job_id, conversation_id, trigger_message_id,
         chatwoot_conversation_id, kind, body, body_sha256,
         status, superseded_by_message_id, last_error_kind, last_error_summary
       ) VALUES ($1,$2,$3,$4,$5,'agent_text',$6,$7,'superseded',$8,
                 'superseded','newer_customer_message_after_draft')
       RETURNING id`,
      [input.environment, input.jobId, input.conversationId, input.triggerMessageId,
        input.chatwootConversationId, input.body, sha256(input.body), newerMessageId],
    );
    if (superseded.rows[0]) await recordOutboundEvent(client, {
      environment: input.environment, outboundId: superseded.rows[0].id,
      toStatus: 'superseded', reason: 'newer_customer_message_after_draft',
    });
    return { status: 'superseded', outboundId: superseded.rows[0]?.id };
  }

  await client.query('BEGIN');
  try {
    const existing = await client.query<{
      id: string; status: string; chatwoot_message_id: string | number | null;
    }>(
      `SELECT id,status,chatwoot_message_id FROM agent.turns
        WHERE environment=$1 AND trigger_message_id=$2 AND agent_version='v2'
        LIMIT 1 FOR UPDATE`,
      [input.environment, input.triggerMessageId],
    );
    const priorTurn = existing.rows[0];
    if (priorTurn && ['sent_api_ack', 'delivered'].includes(priorTurn.status)) {
      await client.query('COMMIT');
      return { status: 'already_sent', turnId: priorTurn.id,
        chatwootMessageId: priorTurn.chatwoot_message_id == null
          ? null : Number(priorTurn.chatwoot_message_id) };
    }

    const turn = await client.query<{ id: string }>(
      `INSERT INTO agent.turns (
         environment,conversation_id,trigger_message_id,agent_version,context_hash,
         say_text,actions,llm_input_tokens,llm_output_tokens,llm_duration_ms,status
       ) VALUES ($1,$2,$3,'v2','',$4,$5::jsonb,$6,$7,$8,'generated')
       ON CONFLICT (environment,trigger_message_id,agent_version) DO UPDATE SET
         say_text=EXCLUDED.say_text, actions=EXCLUDED.actions,
         llm_input_tokens=EXCLUDED.llm_input_tokens,
         llm_output_tokens=EXCLUDED.llm_output_tokens,
         llm_duration_ms=EXCLUDED.llm_duration_ms,
         status=CASE WHEN agent.turns.status IN ('sent_api_ack','delivered')
                     THEN agent.turns.status ELSE 'generated' END,
         error_message=NULL
       RETURNING id`,
      [input.environment, input.conversationId, input.triggerMessageId,
        input.body.slice(0, 4000), input.actionsJson, input.inputTokens,
        input.outputTokens, input.durationMs],
    );
    const turnId = turn.rows[0]!.id;
    const echoId = `turn:${turnId}`;
    const outbound = await client.query<{
      id: string; status: string; provider_message_id: string | number | null;
    }>(
      `INSERT INTO ops.outbound_messages (
         environment,job_id,conversation_id,trigger_message_id,turn_id,
         chatwoot_conversation_id,echo_id,kind,body,body_sha256,status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'agent_text',$8,$9,'pending')
       ON CONFLICT (environment,turn_id) DO UPDATE SET
         job_id=EXCLUDED.job_id, body=EXCLUDED.body, body_sha256=EXCLUDED.body_sha256,
         echo_id=EXCLUDED.echo_id,
         status=CASE WHEN ops.outbound_messages.status IN
           ('sending','sent_api_ack','delivered','dead_letter')
           THEN ops.outbound_messages.status ELSE 'pending' END,
         updated_at=now()
       RETURNING id,status,provider_message_id`,
      [input.environment, input.jobId, input.conversationId, input.triggerMessageId,
        turnId, input.chatwootConversationId, echoId, input.body, sha256(input.body)],
    );
    const row = outbound.rows[0]!;
    if (row.status === 'pending') await recordOutboundEvent(client, {
      environment: input.environment, outboundId: row.id,
      toStatus: 'pending', reason: 'agent_draft_queued',
    });
    await client.query('COMMIT');
    return { status: ['sent_api_ack', 'delivered'].includes(row.status)
      ? 'already_sent' : 'queued', turnId, outboundId: row.id,
      chatwootMessageId: row.provider_message_id == null ? null : Number(row.provider_message_id) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
