import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

/** Estado operacional atual; pedir_foto em um turno antigo não comprova pendência. */
export async function loadConversationPhotoStatus(client: PoolClient, environment: Environment, conversationId: string) {
  const result = await client.query<{ medida: string; status: string; enviada_em: Date | null }>(
    `SELECT pr.tire_size AS medida,pr.status,pr.sent_to_customer_at AS enviada_em
       FROM commerce.photo_requests pr
       JOIN core.conversations cv ON cv.environment=pr.environment AND cv.chatwoot_conversation_id=pr.conversation_id
      WHERE cv.environment=$1 AND cv.id=$2
      ORDER BY pr.created_at DESC,pr.id DESC LIMIT 10`,
    [environment, conversationId],
  );
  return result.rows;
}
