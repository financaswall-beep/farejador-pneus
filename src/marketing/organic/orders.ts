import type { PoolClient } from 'pg';

/** A criação de commerce.orders registra o aceite do pedido, ainda sem entrega.
 * A origem só é fixada se houver exatamente uma conversa de origem elegível. */
export async function reconcileOrganicOrders(client: PoolClient, environment: string): Promise<void> {
  await client.query(`WITH eligible AS (
    SELECT o.id order_id,o.created_at,s.id source_id,
      count(*) OVER (PARTITION BY o.id) candidates
    FROM commerce.orders o
    JOIN core.conversations cv ON cv.environment=o.environment AND cv.id=o.source_conversation_id
    JOIN analytics.organic_conversation_sources s
      ON s.environment=o.environment AND s.conversation_id=o.source_conversation_id
    WHERE o.environment=$1 AND s.superseded_by IS NULL AND cv.deleted_at IS NULL
      AND COALESCE(cv.additional_attributes->>'farejador_simulator','false')<>'true'
      AND o.created_at>=s.first_reply_at AND o.created_at<s.first_reply_at+interval '7 days'
      AND NOT EXISTS(SELECT 1 FROM analytics.organic_order_sources x WHERE x.environment=o.environment AND x.order_id=o.id)
  ) INSERT INTO analytics.organic_order_sources
      (environment,order_id,conversation_source_id,confirmed_at,source_reference)
    SELECT $1,order_id,source_id,created_at,'commerce.orders:'||order_id::text
    FROM eligible WHERE candidates=1 ORDER BY created_at LIMIT 200 ON CONFLICT DO NOTHING`, [environment]);
}
