import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import { dotConfig } from '../config.js';
import { withDotReadOnly } from '../read-only.js';
import { hash,type Snapshot,type TargetKind } from './model.js';
import { readSettings,ruleEnabled,type DotSettings } from './settings.js';

interface Conversation {
  id:string;chatwoot_conversation_id:number;current_status:string;resolved_at:Date|null;waiting_since:Date|null;
  last_activity_at:Date;message_id:string|null;message_type:number|null;sent_at:Date|null;last_event_at:Date|null;
}
export async function readSnapshot(kind:TargetKind,id:string,db:Pool,now=new Date()):Promise<Snapshot|null> {
  if(kind==='signal')return null;
  return withDotReadOnly(async reader=>{
    const {settings}=await readSettings(reader);
    if(!ruleEnabled(settings,kind==='conversation'?'farejador.conversa.atualizada':'farejador.entrega.atencao'))return null;
    return kind==='conversation'?conversation(reader,id,now,settings):order(reader,id,now,settings);
  },db);
}
async function conversation(db:Pool,id:string,now:Date,settings:DotSettings):Promise<Snapshot|null> {
  if(!env.CHATWOOT_ACCOUNT_ID)return null;
  const found=await db.query<Conversation>(`SELECT c.id,c.chatwoot_conversation_id,c.current_status,c.resolved_at,
    c.waiting_since,c.last_activity_at,m.id message_id,m.message_type,m.sent_at,m.last_event_at
    FROM core.conversations c JOIN core.contacts contact ON contact.id=c.contact_id
      AND contact.environment=c.environment AND contact.deleted_at IS NULL
    LEFT JOIN LATERAL (SELECT id,message_type,sent_at,last_event_at
      FROM core.messages WHERE environment=c.environment AND conversation_id=c.id AND deleted_at IS NULL
        AND NOT is_private AND message_type IN (0,1) ORDER BY sent_at DESC,chatwoot_message_id DESC LIMIT 1) m ON true
    WHERE c.environment=$1 AND c.id=$2 AND c.chatwoot_account_id=$3 AND c.deleted_at IS NULL`,
  [env.FAREJADOR_ENV,id,env.CHATWOOT_ACCOUNT_ID]);
  const row=found.rows[0];if(!row||!row.message_id)return null;
  const closed=row.current_status==='resolved';
  const waiting=!closed&&row.message_type===0?row.waiting_since??row.sent_at:null;
  const deadline=waiting?new Date(waiting.getTime()+settings.wait_minutes*60_000):null;
  const overdue=!!deadline&&deadline<=now;
  const reason=closed?'conversa_encerrada':overdue?'aguardando_resposta':'conversa_atualizada';
  const occurredAt=overdue?deadline!:closed?row.resolved_at??row.last_activity_at:row.sent_at??row.last_activity_at;
  return {name:'farejador.conversa.atualizada',kind:'conversation',id,urgent:false,
    fingerprint:hash(JSON.stringify([row.message_id,row.last_event_at,row.current_status,row.resolved_at,reason])),
    occurredAt,nextCheck:deadline&&!overdue?deadline:null,
    data:{entity_id:id,kind:'conversation',reason,status:row.current_status,observed_at:now.toISOString(),
      source:'core.conversations',last_message_id:row.message_id,waiting_since:waiting?.toISOString()??null,
      url:env.CHATWOOT_API_BASE_URL
        ?`${env.CHATWOOT_API_BASE_URL.replace(/\/$/,'')}/app/accounts/${env.CHATWOOT_ACCOUNT_ID}/conversations/${row.chatwoot_conversation_id}`
        :dotConfig()!.origin+'/admin/painel'}};
}
async function order(db:Pool,id:string,now:Date,settings:DotSettings):Promise<Snapshot|null> {
  const found=await db.query<{id:string;delivery_status:string;scheduled_delivery_date:string|null;updated_at:Date;
    deadline:Date|null;delivery_failure_reason:string|null}>(`SELECT o.id,o.delivery_status,o.updated_at,o.delivery_failure_reason,
      o.scheduled_delivery_date::text,(o.scheduled_delivery_date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo' deadline
    FROM commerce.orders o JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
    WHERE o.environment=$1 AND o.id=$2 AND o.partner_order_id IS NULL AND o.fulfillment_mode='delivery'
      AND o.status<>'cancelled' AND o.delivery_status IN ('pending','dispatched','failed')`,[env.FAREJADOR_ENV,id]);
  const row=found.rows[0];if(!row)return null;
  const failed=row.delivery_status==='failed',overdue=!!row.deadline&&row.deadline<=now;
  const idleDeadline=!row.deadline&&settings.delivery_without_date?new Date(row.updated_at.getTime()+settings.delivery_stale_hours*3600000):null;
  const idle=!!idleDeadline&&idleDeadline<=now;
  const reason=failed?'entrega_falhou':overdue?'entrega_atrasada':idle?'entrega_sem_atualizacao_e_sem_prazo':'entrega_agendada';
  return {name:'farejador.entrega.atencao',kind:'order',id,urgent:failed,
    fingerprint:hash(JSON.stringify([row.delivery_status,row.scheduled_delivery_date,row.delivery_failure_reason,reason,idle?idleDeadline:null])),
    occurredAt:failed?row.updated_at:overdue?row.deadline!:idle?idleDeadline!:row.updated_at,
    nextCheck:!failed&&!overdue&&!idle?row.deadline??idleDeadline:null,
    data:{entity_id:id,kind:'order',reason,status:row.delivery_status,observed_at:now.toISOString(),
      source:'commerce.orders',url:dotConfig()!.origin+'/admin/painel'}};
}
