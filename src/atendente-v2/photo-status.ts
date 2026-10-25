import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

/** Estado operacional atual; pedir_foto em um turno antigo não comprova pendência. */
export async function loadConversationPhotoStatus(client: PoolClient, environment: Environment, conversationId: string) {
  const result = await client.query<{ medida: string; status: string; enviada_em: Date | null }>(
    `SELECT medida,status,enviada_em FROM (
       SELECT pr.tire_size AS medida,pr.status,pr.sent_to_customer_at AS enviada_em,pr.created_at,pr.id
       FROM commerce.photo_requests pr
       JOIN core.conversations cv ON cv.environment=pr.environment AND cv.chatwoot_conversation_id=pr.conversation_id
      WHERE cv.environment=$1 AND cv.id=$2
       UNION ALL
       SELECT COALESCE(ts.tire_size,p.product_name) medida,
        CASE WHEN o.status IN ('sent_api_ack','core_echo_seen','delivered') THEN 'sent'
         WHEN o.status IN ('pending','sending') THEN 'queued' WHEN o.status='superseded' THEN 'cancelled' ELSE 'failed' END,
        o.sent_at,o.created_at,o.id
       FROM ops.outbound_messages o JOIN commerce.products p ON p.environment=o.environment
        AND p.id::text=CASE WHEN o.kind='photo_attachment' THEN (o.body::jsonb)->>'product_id' END
       LEFT JOIN commerce.tire_specs ts ON ts.product_id=p.id AND ts.environment=p.environment
       WHERE o.environment=$1 AND o.conversation_id=$2 AND o.kind='photo_attachment'
        AND CASE WHEN o.kind='photo_attachment' THEN o.body::jsonb ? 'catalog_photo_id' ELSE false END
     ) photos ORDER BY created_at DESC,id DESC LIMIT 10`,
    [environment, conversationId],
  );
  return result.rows;
}
