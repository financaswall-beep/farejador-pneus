import type { Pool, PoolClient } from 'pg';
import { META_BUSINESS_ACCOUNTS } from '../../shared/meta-business-accounts.js';
import { env } from '../../shared/config/env.js';
import { reconcileOrganicOrders } from './orders.js';
export interface OrganicInbound {platform:'instagram'|'facebook';account:string;sender:string;mid:string;replyTo:string|null;at:Date}
export function extractOrganicInbound(payload:any):OrganicInbound[] {
  const platform=payload?.object==='instagram'?'instagram':payload?.object==='page'?'facebook':null;
  if(!platform)return [];
  const result:OrganicInbound[]=[];
  for(const entry of Array.isArray(payload.entry)?payload.entry:[]) {
    if(String(entry.id)!==META_BUSINESS_ACCOUNTS[platform].id)continue;
    for(const event of Array.isArray(entry.messaging)?entry.messaging:[]) {
      const sender=String(event?.sender?.id ?? ''),mid=event?.message?.mid,at=new Date(Number(event?.timestamp));
      if(event?.message?.is_echo || sender===String(entry.id) || !/^\d+$/.test(sender)
        || typeof mid!=='string' || !mid || mid.length>1000 || !Number.isFinite(at.getTime())
        || String(event?.recipient?.id)!==String(entry.id))continue;
      result.push({platform,account:String(entry.id),sender,mid,at,
        replyTo:typeof event.message.reply_to?.mid==='string'?event.message.reply_to.mid:null});
    }
  }
  return result;
}
/** Uma referência explícita tem prioridade. Sem ela, exige UMA abordagem elegível. */
export async function bindOrganicSource(client:PoolClient,environment:string,input:{
  platform:string;account:string;sender:string;conversationId:string;messageId:string;at:Date;replyTo?:string|null;
}):Promise<void> {
  await client.query(`WITH candidates AS (
    SELECT o.id FROM ops.organic_outreach o WHERE o.environment=$1 AND o.platform=$2 AND o.account_id=$3 AND o.recipient_id=$4
      AND o.status='sent' AND COALESCE(o.submitted_at,o.sent_at)<=$7 AND o.sent_at>=$7-interval '7 days'
      AND ($8::text IS NULL OR o.provider_message_id=$8)
      AND NOT EXISTS(SELECT 1 FROM analytics.organic_conversation_sources s
        WHERE s.environment=o.environment AND s.outreach_id=o.id AND s.conversation_id<>$5)
  ) INSERT INTO analytics.organic_conversation_sources
    (environment,conversation_id,outreach_id,first_reply_at,source_message_id,source_reference)
    SELECT $1,$5,id,$7,$6::uuid,'core.messages:'||($6::uuid)::text FROM candidates
    WHERE (SELECT count(*) FROM candidates)=1 ON CONFLICT DO NOTHING`,
    [environment,input.platform,input.account,input.sender,input.conversationId,input.messageId,input.at,input.replyTo ?? null]);
}
export async function reconcileOrganicInbound(client:PoolClient,environment:string) {
  const result=await client.query(`SELECT i.*,m.id message_id,m.conversation_id FROM ops.organic_inbound i
    JOIN core.messages m ON m.environment=i.environment AND m.native_message_id=i.provider_message_id
      AND m.sender_type='contact' AND NOT m.is_private AND m.deleted_at IS NULL
    JOIN core.conversations c ON c.environment=m.environment AND c.id=m.conversation_id AND c.deleted_at IS NULL
    JOIN ops.organic_controls s ON s.environment=i.environment AND s.platform=i.platform AND s.verified_inbox_id=c.chatwoot_inbox_id
    WHERE i.environment=$1 AND i.reconciled_at IS NULL AND i.occurred_at>now()-interval '8 days' AND c.chatwoot_account_id=$2
      AND NOT EXISTS(SELECT 1 FROM ops.organic_outreach pending WHERE pending.environment=i.environment
        AND pending.platform=i.platform AND pending.account_id=i.account_id AND pending.status='sending'
        AND pending.updated_at>now()-interval '3 minutes')
      AND NOT EXISTS(SELECT 1 FROM core.messages other WHERE other.environment=m.environment
        AND other.native_message_id=m.native_message_id AND other.id<>m.id)
    ORDER BY i.occurred_at LIMIT 100`,[environment,env.CHATWOOT_ACCOUNT_ID ?? null]);
  for(const i of result.rows) {
    await bindOrganicSource(client,environment,{platform:i.platform,account:i.account_id,sender:i.sender_id,
      conversationId:i.conversation_id,messageId:i.message_id,at:new Date(i.occurred_at),replyTo:i.reply_to_mid});
    await client.query(`UPDATE ops.organic_inbound SET conversation_id=$3,message_id=$4,reconciled_at=now() WHERE environment=$1 AND id=$2`,
      [environment,i.id,i.conversation_id,i.message_id]);
  }
}
/** Identidade nativa do contact_inbox, exclusivamente na caixa verificada da conta. */
export async function bindOrganicChatwootMessage(client:PoolClient,environment:string,payload:any,
  message:{senderType:string;isPrivate:boolean;sentAt:Date},ids:{conversationId:string;messageId:string}) {
  if(!env.ORGANIC_ATTRIBUTION_ENABLED || message.senderType!=='contact' || message.isPrivate)return;
  await client.query('SAVEPOINT organic_message');
  try {
    const sender=payload?.conversation?.contact_inbox?.source_id;
    if(typeof sender==='string' && /^\d+$/.test(sender)) {
      const control=await client.query(`SELECT s.platform FROM core.conversations c JOIN ops.organic_controls s
        ON s.environment=c.environment AND s.verified_inbox_id=c.chatwoot_inbox_id
        WHERE c.environment=$1 AND c.id=$2 AND c.chatwoot_account_id=$3 AND s.verified_at IS NOT NULL`,
        [environment,ids.conversationId,env.CHATWOOT_ACCOUNT_ID ?? null]);
      if(control.rows.length===1) {
        const platform=control.rows[0].platform as 'instagram'|'facebook';
        await bindOrganicSource(client,environment,{platform,account:META_BUSINESS_ACCOUNTS[platform].id,sender,...ids,at:message.sentAt});
      }
    }
    await reconcileOrganicInbound(client,environment);
    await client.query('RELEASE SAVEPOINT organic_message');
  } catch {await client.query('ROLLBACK TO SAVEPOINT organic_message');await client.query('RELEASE SAVEPOINT organic_message');}
}
export async function pollOrganicEvents(pool:Pool):Promise<void> {
  if(!env.ORGANIC_ATTRIBUTION_ENABLED)return;
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const events=await client.query(`SELECT e.raw_event_id,r.payload FROM ops.organic_meta_events e
      JOIN raw.meta_messaging_events r ON r.environment=e.environment AND r.id=e.raw_event_id
      WHERE e.environment=$1 AND e.processed_at IS NULL ORDER BY e.raw_event_id LIMIT 30 FOR UPDATE OF e SKIP LOCKED`,[env.FAREJADOR_ENV]);
    for(const row of events.rows) {
      for(const i of extractOrganicInbound(row.payload)) await client.query(`INSERT INTO ops.organic_inbound
        (environment,platform,account_id,sender_id,provider_message_id,reply_to_mid,occurred_at,raw_event_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [env.FAREJADOR_ENV,i.platform,i.account,i.sender,i.mid,i.replyTo,i.at,row.raw_event_id]);
      await client.query(`UPDATE ops.organic_meta_events SET processed_at=now() WHERE environment=$1 AND raw_event_id=$2`,[env.FAREJADOR_ENV,row.raw_event_id]);
    }
    await reconcileOrganicInbound(client,env.FAREJADOR_ENV);
    await reconcileOrganicOrders(client,env.FAREJADOR_ENV);
    await client.query(`UPDATE ops.organic_outreach SET status='uncertain',error_code='private_ack_missing',updated_at=now()
      WHERE environment=$1 AND status='sending' AND updated_at<now()-interval '3 minutes'`,[env.FAREJADOR_ENV]);
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
