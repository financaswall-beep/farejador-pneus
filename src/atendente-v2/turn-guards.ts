import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

/**
 * O anti-eco considera somente respostas que a API do provedor aceitou.
 * Rascunhos gerados, falhas e envios ambíguos não podem suprimir um retry.
 */
export async function loadLastAcceptedAgentText(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
): Promise<string | null> {
  const result = await client.query<{ say_text: string }>(
    `SELECT say_text FROM agent.turns
      WHERE environment = $1 AND conversation_id = $2
        AND status IN ('sent_api_ack', 'delivered')
      ORDER BY created_at DESC LIMIT 1`,
    [environment, conversationId],
  );
  return result.rows[0]?.say_text ?? null;
}
