import type { PoolClient } from 'pg';
import { env } from '../shared/config/env.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { notifyClientesKanban } from '../shared/clientes-kanban.notify.js';
import type { ChatMessage } from './types.js';
import { sendAgentTextWithOutbox } from './outbox.js';

export interface SendFinalAgentTextInput {
  jobId: string;
  conversationId: string;
  triggerMessageId: string;
  environment: Environment;
  chatwootConversationId: number;
  body: string;
  actions: ChatMessage[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export async function sendFinalAgentText(
  client: PoolClient,
  input: SendFinalAgentTextInput,
): Promise<'sent' | 'superseded' | 'shadowed'> {
  if (env.BOT_OUTBOX) {
    const outboxResult = await sendAgentTextWithOutbox(client, {
      environment: input.environment,
      conversationId: input.conversationId,
      triggerMessageId: input.triggerMessageId,
      jobId: input.jobId,
      chatwootConversationId: input.chatwootConversationId,
      body: input.body,
      actionsJson: JSON.stringify(input.actions),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      durationMs: input.durationMs,
    });
    if (outboxResult.status === 'superseded') return 'superseded';
  } else {
    await client.query(
      `INSERT INTO agent.turns (
         environment, conversation_id, trigger_message_id,
         agent_version, context_hash, say_text, actions,
         llm_input_tokens, llm_output_tokens, llm_duration_ms, status, error_message
       ) VALUES ($1, $2, $3, 'v2', '', $4, $5::jsonb, $6, $7, $8,
                 'generated', 'shadow:no_external_send')
       ON CONFLICT (environment, trigger_message_id, agent_version) DO UPDATE SET
         say_text=EXCLUDED.say_text,
         actions=EXCLUDED.actions,
         llm_input_tokens=EXCLUDED.llm_input_tokens,
         llm_output_tokens=EXCLUDED.llm_output_tokens,
         llm_duration_ms=EXCLUDED.llm_duration_ms,
         status=CASE WHEN agent.turns.status IN ('sent_api_ack','delivered')
                     THEN agent.turns.status ELSE 'generated' END,
         error_message=CASE WHEN agent.turns.status IN ('sent_api_ack','delivered')
                            THEN agent.turns.error_message ELSE 'shadow:no_external_send' END`,
      [
        input.environment,
        input.conversationId,
        input.triggerMessageId,
        input.body.slice(0, 4000),
        JSON.stringify(input.actions),
        input.inputTokens,
        input.outputTokens,
        input.durationMs,
      ],
    );
    await notifyClientesKanban(client, input.environment, input.conversationId, 'agent_turn');
    return 'shadowed';
  }

  await notifyClientesKanban(client, input.environment, input.conversationId, 'agent_turn');
  return 'sent';
}
