import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import { activeSubscriptionsSql,subscriptionParams,type Subscription } from './subscriptions.js';
import { sendWebhook,type WebhookSender } from './https.js';
import { signedHeaders,unseal } from './crypto.js';
import { readSnapshot } from './snapshots.js';
import { matches,type TargetKind,type EventName } from './model.js';
import { quietUntil,retryDelay,retryable } from './policy.js';
import { dotEventsAvailable } from './availability.js';
import { readSettings,ruleEnabled } from './settings.js';
import { readSignalSnapshot } from './signals.js';

interface Delivery {id:string;subscription_id:string;activation_id:string;kind:TargetKind;entity_id:string;fingerprint:string;
  payload:{name:EventName;data:Record<string,unknown>};attempts:number;created_at:Date}
export async function deliverEvents(db:Pool,send:WebhookSender=sendWebhook,now=new Date(),checkLock:()=>Promise<void>=async()=>{},onlySignalId:string|null=null) {
  const rows=await db.query<Delivery>(`SELECT * FROM ops.dot_event_deliveries
    WHERE environment=$1 AND status='pending' AND not_before<=$2 AND ($3::uuid IS NULL OR (kind='signal' AND entity_id=$3))
    ORDER BY not_before,id LIMIT 10`,[env.FAREJADOR_ENV,now,onlySignalId]);
  for(const item of rows.rows) {
    if(!dotEventsAvailable())return;
    await checkLock();
    if(now.getTime()-item.created_at.getTime()>86400_000){await setState(db,item.id,'cancelled',null);continue;}
    let sub=(await db.query<Subscription>(activeSubscriptionsSql+' AND s.id=$4 AND s.activation_id=$5',
      [...subscriptionParams(),item.subscription_id,item.activation_id])).rows[0];
    if(!sub){await setState(db,item.id,'cancelled',null);continue;}
    let current;
    try{current=item.kind==='signal'?await readSignalSnapshot(item.payload.name,item.entity_id,db,now):await readSnapshot(item.kind,item.entity_id,db,now);}
    catch{await db.query(`UPDATE ops.dot_event_deliveries SET not_before=$3,last_error='source_unavailable'
      WHERE id=$1 AND environment=$2 AND status='pending'`,[item.id,env.FAREJADOR_ENV,new Date(now.getTime()+120000)]);continue;}
    if(!current||current.fingerprint!==item.fingerprint||!matches(sub.arguments,item.entity_id)) {
      await setState(db,item.id,'cancelled',null);continue;
    }
    const {settings}=await readSettings(db);
    if(!ruleEnabled(settings,current.name)){await setState(db,item.id,'cancelled',null);continue;}
    const quiet=current.urgent&&settings.urgent_outside_hours?null:quietUntil(now,settings);
    const recent=await db.query<{n:number}>(`SELECT count(*)::int n FROM ops.dot_event_deliveries d
      JOIN network.dot_event_subscriptions s ON s.environment=d.environment AND s.id=d.subscription_id
      WHERE d.environment=$1 AND s.person_id=$2 AND d.status='sent' AND d.sent_at>$3::timestamptz-interval '1 hour'`,
      [env.FAREJADOR_ENV,sub.person_id,now]);
    const last=(await db.query<{sent_at:Date}>(`SELECT sent_at FROM ops.dot_event_deliveries WHERE environment=$1
      AND subscription_id=$2 AND kind=$3 AND entity_id=$4 AND status='sent' ORDER BY sent_at DESC LIMIT 1`,
      [env.FAREJADOR_ENV,sub.id,item.kind,item.entity_id])).rows[0]?.sent_at;
    const cooldown=(last?.getTime()??0)+settings.cooldown_minutes*60000;
    if(quiet||cooldown>now.getTime()||recent.rows[0]!.n>=settings.max_per_hour) {
      await db.query(`UPDATE ops.dot_event_deliveries SET not_before=$3 WHERE id=$1 AND environment=$2 AND status='pending'`,
        [item.id,env.FAREJADOR_ENV,new Date(Math.max(quiet?.getTime()??0,cooldown,
          now.getTime()+(recent.rows[0]!.n>=settings.max_per_hour?300_000:0)))]);continue;
    }
    // Reads/limits may take time. Refresh authorization, cancellation state and signing keys at the send boundary.
    sub=(await db.query<Subscription>(activeSubscriptionsSql+` AND s.id=$4 AND s.activation_id=$6 AND EXISTS
      (SELECT 1 FROM ops.dot_event_deliveries d WHERE d.id=$5 AND d.environment=s.environment
        AND d.subscription_id=s.id AND d.status='pending')`,[...subscriptionParams(),item.subscription_id,item.id,item.activation_id])).rows[0];
    if(!sub){await setState(db,item.id,'cancelled',null);continue;}
    if(!ruleEnabled((await readSettings(db)).settings,current.name)){await setState(db,item.id,'cancelled',null);continue;}
    await checkLock();
    // Keep exact stored payload and event ID on retries; regenerate only the signing timestamp.
    const secrets=[unseal(sub.secret_ciphertext,sub.id)];
    if(sub.previous_secret_ciphertext&&sub.previous_secret_until&&sub.previous_secret_until>now)
      secrets.push(unseal(sub.previous_secret_ciphertext,sub.id));
    const body=JSON.stringify(item.payload);
    let status=0;
    try { status=(await send(sub.callback_url,body,signedHeaders(item.id,body,sub.id,secrets))).status; }
    catch { status=503; }
    if(status>=200&&status<300) {
      await setState(db,item.id,'sent',null);
      await db.query(`UPDATE network.dot_event_subscriptions SET last_delivery_at=now() WHERE id=$1 AND environment=$2 AND activation_id=$3`,[sub.id,env.FAREJADOR_ENV,item.activation_id]);
    }else if(!retryable(status)||item.attempts>=5) {
      await setState(db,item.id,'failed',`http_${status}`);
      if(status===410)await db.query(`UPDATE network.dot_event_subscriptions SET revoked_at=now() WHERE id=$1 AND environment=$2 AND activation_id=$3`,[sub.id,env.FAREJADOR_ENV,item.activation_id]);
    }else await db.query(`UPDATE ops.dot_event_deliveries SET attempts=attempts+1,last_error=$3,
      not_before=now()+($4::int*interval '1 second') WHERE id=$1 AND environment=$2 AND status='pending'`,
    [item.id,env.FAREJADOR_ENV,`http_${status}`,retryDelay(item.attempts+1)]);
  }
}
async function setState(db:Pool,id:string,status:string,error:string|null) {
  await db.query(`UPDATE ops.dot_event_deliveries SET status=$3,last_error=$4,attempts=attempts+1,
    sent_at=CASE WHEN $3='sent' THEN now() ELSE sent_at END WHERE id=$1 AND environment=$2 AND status='pending'`,[id,env.FAREJADOR_ENV,status,error]);
}
