import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { env } from '../shared/config/env.js';
interface ResolutionGuard { allowed: boolean; has_completed_order: boolean; }

/**
 * Guarda única usada antes de enfileirar e repetida imediatamente antes do HTTP.
 * Qualquer pendência deixa `allowed=false`; indisponibilidade de banco lança erro.
 */
export async function assessResolutionGuard(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  expectedLastMessageId: string,
  excludedOutboundId: string | null = null,
): Promise<ResolutionGuard> {
  const result = await client.query<ResolutionGuard>(
    `WITH matching_conversation AS (
       SELECT c.id,c.chatwoot_conversation_id
         FROM core.conversations c
        WHERE c.environment=$1 AND c.id=$2 AND c.deleted_at IS NULL
          AND c.current_status IN ('open','pending')
          AND EXISTS (
            SELECT 1 FROM core.messages expected
             WHERE expected.environment=c.environment
               AND expected.conversation_id=c.id AND expected.id=$3
               AND expected.sender_type<>'contact' AND NOT expected.is_private
               AND expected.deleted_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM core.messages newer
                  WHERE newer.environment=expected.environment
                    AND newer.conversation_id=expected.conversation_id
                    AND NOT newer.is_private AND newer.deleted_at IS NULL
                    AND newer.message_type IN (0,1,3)
                    AND (newer.sent_at,newer.chatwoot_message_id)>
                        (expected.sent_at,expected.chatwoot_message_id)
               )
          )
          AND COALESCE((SELECT control.mode FROM ops.conversation_bot_control control
                         WHERE control.environment=c.environment
                           AND control.conversation_id=c.id),'auto')='auto'
     ), linked_orders AS (
       SELECT o.*,
              CASE WHEN o.partner_order_id IS NOT NULL THEN
                po.status<>'cancelled' AND po.deleted_at IS NULL AND
                ((po.fulfillment_mode='delivery' AND po.delivery_status='delivered') OR
                 (po.fulfillment_mode='pickup' AND po.retrieved_at IS NOT NULL))
              ELSE o.status<>'cancelled' AND
                ((o.fulfillment_mode='delivery' AND o.delivery_status='delivered') OR
                 (o.fulfillment_mode='pickup' AND o.retrieved_at IS NOT NULL))
              END AS completed,
              po.status AS partner_status,po.deleted_at AS partner_deleted_at
         FROM commerce.orders o
         LEFT JOIN commerce.partner_orders po
           ON po.environment=o.environment AND po.id=o.partner_order_id
        WHERE o.environment=$1 AND o.source_conversation_id=$2
     ), state AS (
       SELECT EXISTS(SELECT 1 FROM matching_conversation) AS conversation_ok,
              EXISTS(SELECT 1 FROM linked_orders WHERE completed) AS has_completed_order,
              EXISTS(SELECT 1 FROM linked_orders
                      WHERE status<>'cancelled' AND NOT completed) AS has_order_pending,
              EXISTS(SELECT 1 FROM ops.atendente_jobs j
                      WHERE j.environment=$1 AND j.conversation_id=$2
                        AND j.status IN ('pending','processing','failed')) AS has_job_pending,
              EXISTS(SELECT 1 FROM ops.outbound_messages o
                      WHERE o.environment=$1 AND o.conversation_id=$2
                        AND ($4::uuid IS NULL OR o.id<>$4)
                        AND o.status IN ('pending','sending','failed','sent_api_ack')) AS has_outbound_pending,
              EXISTS(SELECT 1 FROM ops.atendente_dead_letters d
                      WHERE d.environment=$1 AND d.conversation_id=$2
                        AND d.resolved_at IS NULL) AS has_dead_letter,
              EXISTS(SELECT 1 FROM agent.escalations e
                      WHERE e.environment=$1 AND e.conversation_id=$2
                        AND e.status IN ('waiting','in_attendance')) AS has_escalation,
              EXISTS(SELECT 1 FROM agent.order_drafts d
                      WHERE d.environment=$1 AND d.conversation_id=$2
                        AND d.draft_status='ready')
              OR EXISTS(SELECT 1 FROM agent.pending_confirmations p
                        WHERE p.environment=$1 AND p.conversation_id=$2
                          AND p.status='open'
                          AND p.confirmation_type='order_confirmation') AS has_checkout_pending,
              EXISTS(SELECT 1 FROM core.conversations c
                      JOIN commerce.photo_requests p
                        ON p.environment=c.environment
                       AND p.conversation_id=c.chatwoot_conversation_id
                      WHERE c.environment=$1 AND c.id=$2
                        AND p.status IN ('pending','answered')) AS has_photo_pending,
              EXISTS(SELECT 1 FROM core.conversations c
                      JOIN commerce.satisfaction_surveys s
                        ON s.environment=c.environment
                       AND s.conversation_id=c.chatwoot_conversation_id
                      WHERE c.environment=$1 AND c.id=$2 AND s.status='pending') AS has_survey_pending,
              EXISTS(
                SELECT 1 FROM linked_orders o
                 WHERE o.completed AND $5::boolean
                   AND NOT EXISTS (
                     SELECT 1 FROM commerce.satisfaction_surveys s
                      WHERE s.environment=o.environment
                        AND (s.order_id=o.id OR
                             (o.partner_order_id IS NOT NULL AND s.partner_order_id=o.partner_order_id))
                   )
              ) AS missing_completed_survey
     )
     SELECT (conversation_ok AND NOT has_order_pending AND NOT has_job_pending
             AND NOT has_outbound_pending AND NOT has_dead_letter AND NOT has_escalation
             AND NOT has_checkout_pending AND NOT has_photo_pending AND NOT has_survey_pending
             AND NOT missing_completed_survey) AS allowed,
            has_completed_order
       FROM state`,
    [environment, conversationId, expectedLastMessageId, excludedOutboundId,
      env.SATISFACTION_SURVEY],
  );
  return result.rows[0] ?? { allowed: false, has_completed_order: false };
}
