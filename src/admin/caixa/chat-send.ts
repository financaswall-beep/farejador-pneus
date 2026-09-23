import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { lockBotConversation, syncHumanIntervention, cancelConversationBotQueue } from '../../atendente-v2/conversation-control.js';
import { notifyClientesKanban } from '../../shared/clientes-kanban.notify.js';
import { recordOutboundEvent } from '../../atendente-v2/outbound-events.js';

export interface OperatorSend {
  conversationId: string; clientToken: string; actor: string; content: string;
  photoRequestId?: string;
  file?: { bytes: Buffer; mime: string; filename: string };
}

async function pauseForOperator(client: import('pg').PoolClient, conversationId: string, actor: string) {
  const state=await syncHumanIntervention(client,env.FAREJADOR_ENV,conversationId);
  if (state.mode!=='human') {
    const updated=await client.query(`UPDATE ops.conversation_bot_control SET mode='human',version=version+1,
      updated_by=$3,updated_at=now() WHERE environment=$1 AND conversation_id=$2 RETURNING version`,
    [env.FAREJADOR_ENV,conversationId,actor]);
    await client.query(`INSERT INTO ops.conversation_bot_control_events
      (environment,conversation_id,version,action,actor) VALUES($1,$2,$3,'takeover',$4)`,
    [env.FAREJADOR_ENV,conversationId,updated.rows[0].version,actor]);
  }
  await cancelConversationBotQueue(client,env.FAREJADOR_ENV,conversationId);
}

/** Pausa + mensagem na mesma transação. Repetir a requisição nunca repete o envio. */
export async function queueOperatorMessage(input: OperatorSend, db: Pool = pool) {
  if (!env.BOT_OUTBOX) throw Error('chat_delivery_disabled');
  const environment = env.FAREJADOR_ENV;
  const fingerprint = createHash('sha256').update(JSON.stringify([
    input.content, input.file?.mime, input.file?.filename,input.photoRequestId,
  ])).update(input.file?.bytes ?? Buffer.alloc(0)).digest('hex');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await lockBotConversation(client, environment, input.conversationId);
    const conversation = await client.query(`SELECT chatwoot_conversation_id FROM core.conversations
      WHERE environment=$1 AND id=$2 AND deleted_at IS NULL AND chatwoot_account_id=$3`,
    [environment, input.conversationId, env.CHATWOOT_ACCOUNT_ID]);
    if (!conversation.rows[0]) throw Error('bot_conversation_not_found');
    const existing = await client.query(`SELECT m.fingerprint,o.id,o.status FROM ops.operator_messages m
      JOIN ops.outbound_messages o ON o.environment=m.environment AND o.id=m.outbound_id
      WHERE m.environment=$1 AND m.conversation_id=$2 AND m.client_token=$3`,
    [environment, input.conversationId, input.clientToken]);
    if (existing.rows[0]) {
      if (existing.rows[0].fingerprint !== fingerprint) throw Error('chat_idempotency_conflict');
      await client.query('COMMIT');
      return { id: existing.rows[0].id, status: existing.rows[0].status, replayed: true };
    }
    await pauseForOperator(client,input.conversationId,input.actor);
    if (input.photoRequestId) {
      if (!input.file?.mime.startsWith('image/')) throw Error('chat_media_invalid');
      const photo = await client.query(`SELECT p.id FROM commerce.photo_requests p JOIN core.units u
        ON u.environment=p.environment AND u.id=p.unit_id AND u.slug='main'
        WHERE p.environment=$1 AND p.conversation_id=$2 AND p.id=$3 AND p.status='pending'
          AND p.expires_at>now() FOR UPDATE OF p`, [environment,conversation.rows[0].chatwoot_conversation_id,input.photoRequestId]);
      if (!photo.rows[0]) throw Error('chat_photo_conflict');
      await client.query('SELECT * FROM commerce.attach_partner_photo($1,$2,$3,$4)',
        [input.photoRequestId,input.file.bytes,input.file.mime,input.file.bytes.length]);
    }
    const outbound = await client.query(`INSERT INTO ops.outbound_messages
      (environment,conversation_id,chatwoot_conversation_id,echo_id,kind,body,body_sha256,status,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'pending',clock_timestamp()) RETURNING id,status`,
    [environment, input.conversationId, conversation.rows[0].chatwoot_conversation_id,
      input.photoRequestId ? `photo:${input.photoRequestId}` : `operator:${input.clientToken}`,
      input.file ? 'operator_attachment' : 'operator_text', input.content,
      createHash('sha256').update(input.content).digest('hex')]);
    const row = outbound.rows[0]!;
    await client.query(`INSERT INTO ops.operator_messages
      (environment,conversation_id,outbound_id,client_token,actor,fingerprint,filename,mime,bytes,photo_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [environment, input.conversationId, row.id,
      input.clientToken, input.actor, fingerprint, input.file?.filename ?? null,
      input.file?.mime ?? null, input.file?.bytes ?? null,input.photoRequestId ?? null]);
    await recordOutboundEvent(client, { environment, outboundId: row.id, actor: input.actor,
      toStatus: 'pending', reason: 'operator_message_queued' });
    await notifyClientesKanban(client, environment, input.conversationId, 'message');
    await client.query('COMMIT');
    return { id: row.id, status: row.status, replayed: false };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** Só repete falhas definitivas. ACK ou resultado ambíguo exigem reconciliação, nunca reenvio cego. */
export async function retryOperatorMessage(conversationId: string, outboundId: string, actor: string, db: Pool=pool) {
  if (!env.BOT_OUTBOX) throw Error('chat_delivery_disabled');
  const client=await db.connect(),environment=env.FAREJADOR_ENV;
  try {
    await client.query('BEGIN');
    await lockBotConversation(client,environment,conversationId);
    const result=await client.query(`SELECT o.id,o.status,o.last_error_kind,o.provider_message_id,
      o.kind,m.bytes IS NOT NULL AS has_file,
      EXISTS(SELECT 1 FROM core.messages echo WHERE echo.environment=o.environment
        AND echo.conversation_id=o.conversation_id AND (echo.echo_id=o.echo_id
        OR echo.content_attributes->>'farejador_echo_id'=o.echo_id OR echo.chatwoot_message_id=o.provider_message_id)) AS echoed
      FROM ops.outbound_messages o JOIN ops.operator_messages m ON m.environment=o.environment AND m.outbound_id=o.id
      JOIN core.conversations c ON c.environment=o.environment AND c.id=o.conversation_id
      WHERE o.environment=$1 AND o.conversation_id=$2 AND o.id=$3 AND c.chatwoot_account_id=$4
        AND c.deleted_at IS NULL FOR UPDATE OF o`,[environment,conversationId,outboundId,env.CHATWOOT_ACCOUNT_ID]);
    const row=result.rows[0];
    if (!row) throw Error('bot_conversation_not_found');
    if (row.status!=='dead_letter') {await client.query('COMMIT');return {id:row.id,status:row.status};}
    if (row.last_error_kind==='ambiguous' || row.provider_message_id || row.echoed
      || (row.kind==='operator_attachment'&&!row.has_file)) throw Error('chat_retry_conflict');
    await pauseForOperator(client,conversationId,actor);
    await client.query(`UPDATE ops.outbound_messages SET status='pending',attempts=0,not_before=now(),
      locked_at=NULL,locked_by=NULL,last_error_code=NULL,last_error_kind=NULL,last_error_summary=NULL,updated_at=now()
      WHERE environment=$1 AND id=$2`,[environment,outboundId]);
    await client.query(`UPDATE ops.atendente_dead_letters SET resolved_at=now(),resolved_by=$3
      WHERE environment=$1 AND outbound_id=$2 AND resolved_at IS NULL`,[environment,outboundId,actor]);
    await recordOutboundEvent(client,{environment,outboundId,actor,fromStatus:'dead_letter',toStatus:'pending',reason:'operator_retry'});
    await notifyClientesKanban(client,environment,conversationId,'message');
    await client.query('COMMIT');return {id:row.id,status:'pending'};
  } catch (error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
