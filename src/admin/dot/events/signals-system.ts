import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import type { DotSettings } from './settings.js';
import { signal } from './signal-model.js';
import type { Snapshot } from './model.js';
import { freshnessMs } from './freshness.js';
import { readExternalHealth } from './external-health.js';

export async function systemSignals(db:Pool,settings:DotSettings,now:Date):Promise<Snapshot[]> {
 const result:Snapshot[]=[],cutoff=new Date(now.getTime()-settings.system_stale_minutes*60000);
 if(env.AGENT_V2_WORKER_ENABLED||env.BOT_OUTBOX) {
  if(!env.CHATWOOT_ACCOUNT_ID)throw Error('chatwoot_account_unavailable');
  const row=(await db.query<{jobs:number;outbound:number;dead:number;first_job:Date|null;first_outbound:Date|null;first_dead:Date|null}>(
   `SELECT
    (SELECT count(*)::int FROM ops.atendente_jobs j JOIN core.conversations c ON c.id=j.conversation_id AND c.environment=j.environment
      WHERE j.environment=$1 AND c.chatwoot_account_id=$2 AND c.deleted_at IS NULL AND j.status IN ('pending','failed','processing') AND j.created_at<$3) jobs,
    (SELECT min(j.created_at) FROM ops.atendente_jobs j JOIN core.conversations c ON c.id=j.conversation_id AND c.environment=j.environment
      WHERE j.environment=$1 AND c.chatwoot_account_id=$2 AND c.deleted_at IS NULL AND j.status IN ('pending','failed','processing') AND j.created_at<$3) first_job,
    (SELECT count(*)::int FROM ops.outbound_messages o JOIN core.conversations c ON c.id=o.conversation_id AND c.environment=o.environment
      WHERE o.environment=$1 AND c.chatwoot_account_id=$2 AND c.deleted_at IS NULL AND o.status IN ('pending','failed','sending','sent_api_ack')
       AND o.created_at<$3 AND (o.status<>'sent_api_ack' OR o.delivery_suspect_at IS NOT NULL) AND o.not_before<=$4) outbound,
    (SELECT min(o.created_at) FROM ops.outbound_messages o JOIN core.conversations c ON c.id=o.conversation_id AND c.environment=o.environment
      WHERE o.environment=$1 AND c.chatwoot_account_id=$2 AND c.deleted_at IS NULL AND o.status IN ('pending','failed','sending','sent_api_ack')
       AND o.created_at<$3 AND (o.status<>'sent_api_ack' OR o.delivery_suspect_at IS NOT NULL) AND o.not_before<=$4) first_outbound,
    (SELECT count(*)::int FROM ops.atendente_dead_letters d JOIN core.conversations c ON c.id=d.conversation_id AND c.environment=d.environment
      WHERE d.environment=$1 AND c.chatwoot_account_id=$2 AND c.deleted_at IS NULL AND d.resolved_at IS NULL) dead,
    (SELECT min(d.created_at) FROM ops.atendente_dead_letters d JOIN core.conversations c ON c.id=d.conversation_id AND c.environment=d.environment
      WHERE d.environment=$1 AND c.chatwoot_account_id=$2 AND c.deleted_at IS NULL AND d.resolved_at IS NULL) first_dead`,
   [env.FAREJADOR_ENV,env.CHATWOOT_ACCOUNT_ID,cutoff,now])).rows[0]!;
  if(!env.AGENT_V2_WORKER_ENABLED){row.jobs=0;row.first_job=null;}
  if(!env.BOT_OUTBOX){row.outbound=0;row.first_outbound=null;}
  if(row.jobs||row.outbound||row.dead)result.push(signal('farejador.sistema.atencao','bot',
   'fila_do_bot_requer_conferencia','ops.atendente_jobs + ops.outbound_messages + ops.atendente_dead_letters',row,now));
 }
 const raw=(await db.query<{pending:number;failed:number;oldest:Date|null}>(`SELECT
  count(*) FILTER(WHERE processing_status='pending' AND received_at<$2)::int pending,
  count(*) FILTER(WHERE processing_status='failed')::int failed,
  min(received_at) FILTER(WHERE processing_status='failed' OR (processing_status='pending' AND received_at<$2)) oldest
  FROM raw.raw_events WHERE environment=$1 AND processing_status IN ('pending','failed')`,[env.FAREJADOR_ENV,cutoff])).rows[0]!;
 if(raw.pending||raw.failed)result.push(signal('farejador.sistema.atencao','ingestion','ingestao_com_fila_ou_falha','raw.raw_events',raw,now));
 // No traffic is not an outage. Only scheduled integrations have a freshness expectation.
 if(env.MARKETING_META_ENABLED&&env.MARKETING_SYNC_ENABLED) {
  const latest=(await db.query<{status:string;started_at:Date;finished_at:Date|null}>(`SELECT status,started_at,finished_at
   FROM marketing.meta_sync_runs WHERE environment=$1 ORDER BY started_at DESC,id DESC LIMIT 1`,[env.FAREJADOR_ENV])).rows[0];
  if(!latest||latest.status==='failed'||new Date(latest.finished_at??latest.started_at).getTime()<now.getTime()-freshnessMs('meta',settings))
   result.push(signal('farejador.sistema.atencao','meta_sync','sincronizacao_meta_sem_confirmacao_recente','marketing.meta_sync_runs',
    {last_run:latest??null,stale_after_minutes:freshnessMs('meta',settings)/60000},now,[latest?.started_at??null,latest?.status??'never']));
 }
 if(env.GOOGLE_ADS_ENABLED) {
  const latest=(await db.query<{last_sync_at:Date|null}>('SELECT last_sync_at FROM marketing.google_accounts WHERE environment=$1 AND account_id=$2',
   [env.FAREJADOR_ENV,env.GOOGLE_ADS_CUSTOMER_ID??''])).rows[0]?.last_sync_at;
  if(!latest||latest.getTime()<now.getTime()-freshnessMs('google',settings))result.push(signal('farejador.sistema.atencao','google_sync',
   'sincronizacao_google_sem_confirmacao_recente','marketing.google_accounts',
   {last_sync_at:latest??null,stale_after_minutes:freshnessMs('google',settings)/60000},now,[latest??null]));
 }
 const external=await readExternalHealth(db,settings,now);if(external)result.push(external);
 return result;
}
