import type { PoolClient } from 'pg';
import type { OutboundRow } from './outbound-worker.js';
/** Não anuncia estoque confirmado depois de cancelar, trocar a consulta ou vencer a confirmação. */
export async function validateStockConfirmationOutbound(client:PoolClient,row:OutboundRow):Promise<boolean> {
  const id=/^stock:([0-9a-f-]{36}):\d+$/.exec(row.echo_id??'')?.[1];
  if(!id)return false;
  const result=await client.query<{allowed:boolean}>(`SELECT EXISTS (
    SELECT 1 FROM commerce.partner_stock_requests r
    WHERE r.environment=$1 AND r.conversation_id=$2 AND r.id=$3
      AND (r.status='completed' OR (r.status IN ('matrix','exhausted','confirmed')
        AND (r.status<>'confirmed' OR r.valid_until>now())
        AND NOT EXISTS(SELECT 1 FROM commerce.partner_stock_requests newer
          WHERE newer.environment=r.environment AND newer.conversation_id=r.conversation_id
            AND newer.created_at>r.created_at)))) AS allowed`,[row.environment,row.conversation_id,id]);
  return result.rows[0]?.allowed===true;
}
