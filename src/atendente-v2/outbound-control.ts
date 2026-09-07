import type { PoolClient } from 'pg';
import type { OutboundRow } from './outbound-worker.js';
import { syncHumanIntervention } from './conversation-control.js';
import { recordOutboundEvent } from './outbound-events.js';
import { validateResolutionOutbound } from './auto-resolve.js';

/** Última trava antes do HTTP, dentro da transação do caller, com lock até o ACK.
 * Mesmo após retomar, respostas antigas e fotos pedidas antes da retomada não saem. */
export async function prepareControlledOutbound(client: PoolClient, row: OutboundRow): Promise<boolean> {
    const state = await syncHumanIntervention(client,row.environment,row.conversation_id);
    const result = await client.query<{ allowed: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM ops.outbound_messages o
      LEFT JOIN core.messages m ON m.environment=o.environment AND m.id=o.trigger_message_id
        AND m.conversation_id=o.conversation_id
      WHERE o.environment=$1 AND o.conversation_id=$2 AND o.id=$3 AND o.status='sending'
        AND (o.kind<>'agent_text' OR m.id IS NOT NULL)
        AND ($4::timestamptz IS NULL OR
          (COALESCE(m.sent_at,o.created_at)>$4 AND (o.kind<>'photo_attachment' OR EXISTS (
            SELECT 1 FROM commerce.photo_requests p WHERE p.environment=o.environment
              AND p.id::text=CASE WHEN o.kind='photo_attachment' THEN (o.body::jsonb)->>'photo_request_id' END
              AND p.created_at>$4))))) AS allowed`,
    [row.environment,row.conversation_id,row.id,state.resumed_at]);
    const baseAllowed = state.mode==='auto' && result.rows[0]?.allowed===true;
    const allowed = baseAllowed && (row.kind !== 'conversation_resolution'
      || await validateResolutionOutbound(
        client,row.environment,row.conversation_id,row.id,row.body,
      ));
    if (!allowed) {
      await client.query(`UPDATE ops.outbound_messages SET status='superseded',locked_at=NULL,locked_by=NULL,
        last_error_kind='superseded',last_error_summary=$3,updated_at=now()
        WHERE environment=$1 AND id=$2 AND status='sending'`,
      [row.environment,row.id,baseAllowed ? 'resolution_guard' : 'conversation_control']);
      await recordOutboundEvent(client,{ environment:row.environment,outboundId:row.id,
        fromStatus:'sending',toStatus:'superseded',reason:baseAllowed
          ? 'resolution_guard' : 'conversation_control' });
    }
    return allowed;
}
