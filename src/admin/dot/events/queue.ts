import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import { activeSubscriptions,type Subscription } from './subscriptions.js';
import { readSnapshot } from './snapshots.js';
import { hash,matches,type TargetKind,type Snapshot } from './model.js';
import { quietUntil } from './policy.js';

export async function enqueueSnapshot(db:Pool,s:Subscription,snapshot:Snapshot,changedAt:Date,now=new Date()) {
  if(s.event_name!==snapshot.name||!matches(s.arguments,snapshot.id)||changedAt<s.created_at
    ||snapshot.data.reason==='entrega_agendada')return;
  const id='evt_'+hash(JSON.stringify([s.id,s.activation_id,snapshot.kind,snapshot.id,snapshot.fingerprint]));
  const latest=await db.query<{sent_at:Date}>(`SELECT sent_at FROM ops.dot_event_deliveries
    WHERE environment=$1 AND subscription_id=$2 AND kind=$3 AND entity_id=$4 AND status='sent'
    ORDER BY sent_at DESC LIMIT 1`,[env.FAREJADOR_ENV,s.id,snapshot.kind,snapshot.id]);
  const last=latest.rows[0]?.sent_at?.getTime()??0;
  const due=snapshot.urgent?now:new Date(Math.max(now.getTime(),last+env.DOT_EVENTS_COOLDOWN_MINUTES*60_000,
    quietUntil(now)?.getTime()??0));
  const payload={eventId:id,name:snapshot.name,timestamp:snapshot.occurredAt.toISOString(),data:snapshot.data,cursor:null};
  await db.query(`INSERT INTO ops.dot_event_deliveries(id,environment,subscription_id,kind,entity_id,fingerprint,payload,not_before,activation_id)
    SELECT $1::text,$2::env_t,$3::text,$4::text,$5::uuid,$6::text,$7::jsonb,$8::timestamptz,$9::uuid
      FROM network.dot_event_subscriptions
      WHERE id=$3::text AND environment=$2::env_t AND activation_id=$9::uuid AND revoked_at IS NULL AND expires_at>now()
    ON CONFLICT DO NOTHING`,
  [id,env.FAREJADOR_ENV,s.id,snapshot.kind,snapshot.id,snapshot.fingerprint,payload,due,s.activation_id]);
}

/** No source writes: the trigger queue is consumed independently of ingestion. */
export async function collectEvents(db:Pool,now=new Date()) {
  const subscriptions=await activeSubscriptions(db);
  const targets=await db.query<{kind:TargetKind;entity_id:string;revision:string;changed_at:Date}>(`SELECT kind,entity_id,revision,changed_at
    FROM ops.dot_monitor_targets WHERE environment=$1 AND due_at<=$2 ORDER BY due_at,entity_id LIMIT 100`,[env.FAREJADOR_ENV,now]);
  for(const target of targets.rows) {
    const snapshot=await readSnapshot(target.kind,target.entity_id,db,now);
    // Changed or solved cases invalidate queued notices, including notices held by quiet hours/cooldown.
    await db.query(`UPDATE ops.dot_event_deliveries SET status='cancelled' WHERE environment=$1 AND kind=$2 AND entity_id=$3
      AND status='pending' AND ($4::text IS NULL OR fingerprint<>$4)`,
    [env.FAREJADOR_ENV,target.kind,target.entity_id,snapshot?.fingerprint??null]);
    if(snapshot)for(const sub of subscriptions)await enqueueSnapshot(db,sub,snapshot,target.changed_at,now);
    // Concurrent source updates increment revision; never overwrite their due time.
    await db.query(`UPDATE ops.dot_monitor_targets SET due_at=$5,first_dirty_at=$6
      WHERE environment=$1 AND kind=$2 AND entity_id=$3 AND revision=$4`,
    [env.FAREJADOR_ENV,target.kind,target.entity_id,target.revision,snapshot?.nextCheck??null,now]);
  }
}
