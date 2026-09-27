import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { META_BUSINESS_ACCOUNTS } from '../../shared/meta-business-accounts.js';
import { CommentsGraph } from '../../social-comments/graph.js';
import { commentsConfig } from '../../social-comments/config.js';
import { hasAgentV2Wildcard } from '../../atendente-v2/conversation-scope.js';

export async function organicInboxes(fetcher: typeof fetch = fetch) {
  if (!env.CHATWOOT_API_BASE_URL || !env.CHATWOOT_API_TOKEN || !env.CHATWOOT_ACCOUNT_ID) throw Error('chatwoot_not_configured');
  const base=env.CHATWOOT_API_BASE_URL.replace(/\/api\/v1\/?$/,'').replace(/\/$/,'');
  const response=await fetcher(`${base}/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID}/inboxes`,{
    headers:{api_access_token:env.CHATWOOT_API_TOKEN},redirect:'error',signal:AbortSignal.timeout(6000),
  });
  if(!response.ok)throw Error('chatwoot_unavailable');
  const body=await response.json() as any;
  if(!Array.isArray(body.payload))throw Error('chatwoot_unavailable');
  return body.payload.flatMap((i:any)=>{
    const type=String(i.channel_type).toLowerCase();
    const platform=['channel::instagram','instagram'].includes(type)?'instagram'
      :['channel::facebookpage','facebook'].includes(type)?'facebook':null;
    return platform && Number.isSafeInteger(i.id) && (!i.account_id || Number(i.account_id)===env.CHATWOOT_ACCOUNT_ID)
      ? [{id:i.id,name:String(i.name ?? platform).slice(0,100),platform,reauthorization_required:i.reauthorization_required===true}] : [];
  }) as Array<{id:number;name:string;platform:string;reauthorization_required:boolean}>;
}
export function organicRuntimeReady(platform:string) {
  return env.ORGANIC_ATTRIBUTION_ENABLED && env.BOT_AUDIO_ENABLED && env.BOT_OUTBOX && env.AGENT_V2_WORKER_ENABLED
    && !!env.OPENAI_API_KEY && hasAgentV2Wildcard(env.AGENT_V2_CONVERSATION_IDS)
    && env.META_MESSAGING_WEBHOOK_ENABLED && env.FAREJADOR_ENV==='prod'
    && (platform==='instagram'?env.ORGANIC_INSTAGRAM_PRIVATE_ENABLED:env.ORGANIC_FACEBOOK_PRIVATE_ENABLED);
}
export async function verifyOrganicInbox(pool:Pool, platform:'instagram'|'facebook', inboxId:number, actor:string) {
  const inbox=(await organicInboxes()).find(i=>i.id===inboxId && i.platform===platform && !i.reauthorization_required);
  if(!inbox)throw Error('organic_inbox_mismatch');
  const graph=new CommentsGraph(commentsConfig());
  await graph.assertAccount(platform,META_BUSINESS_ACCOUNTS[platform].id);
  const health=await graph.health() as any;
  if(health.token_valid!==true || health.app_matches!==true || !health.private_missing
    || health.private_missing[platform].length)throw Error('organic_messaging_permissions_missing');
  // Prova de ponta a ponta: MESMO mid recebido pela Meta e pelo Chatwoot.
  const proof=await pool.query(`SELECT m.id FROM ops.organic_inbound i
    JOIN core.messages m ON m.environment=i.environment AND m.native_message_id=i.provider_message_id
      AND m.sender_type='contact' AND NOT m.is_private AND m.deleted_at IS NULL
    JOIN core.conversations c ON c.environment=m.environment AND c.id=m.conversation_id
    WHERE i.environment=$1 AND i.platform=$2 AND i.account_id=$3 AND c.chatwoot_inbox_id=$4
      AND c.chatwoot_account_id=$5 AND c.deleted_at IS NULL AND i.occurred_at>now()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM core.messages other WHERE other.environment=m.environment
        AND other.native_message_id=m.native_message_id AND other.id<>m.id)
    LIMIT 1`,[env.FAREJADOR_ENV,platform,META_BUSINESS_ACCOUNTS[platform].id,inboxId,env.CHATWOOT_ACCOUNT_ID]);
  if(!proof.rowCount)throw Error('organic_inbound_test_required');
  await pool.query(`INSERT INTO ops.organic_controls(environment,platform,verified_inbox_id,verified_at,updated_by)
    VALUES($1,$2,$3,now(),$4) ON CONFLICT(environment,platform) DO UPDATE
    SET verified_inbox_id=excluded.verified_inbox_id,verified_at=now(),enabled=false,updated_by=$4,updated_at=now()`,
    [env.FAREJADOR_ENV,platform,inboxId,actor]);
  return {verified:true};
}
