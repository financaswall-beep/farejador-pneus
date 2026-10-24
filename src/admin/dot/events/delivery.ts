import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import { activeSubscriptionsSql,subscriptionParams,type Subscription } from './subscriptions.js';
import { sendWebhook,type WebhookSender } from './https.js';
import { signedHeaders,unseal } from './crypto.js';
import { readSnapshot } from './snapshots.js';
import { matches,type TargetKind } from './model.js';
import { quietUntil,retryDelay,retryable } from './policy.js';

interface Delivery {id:string;subscription_id:string;activation_id:string;kind:TargetKind;entity_id:string;fingerprint:string;
  payload:{data:Record<string,unknown>};attempts:number;created_at:Date}
export async function deliverEvents(db:Pool,send:WebhookSender=sendWebhook,now=new Date(),checkLock:()=>Promise<void>=async()=>{}) {
  const rows=await db.query<Delivery>(`SELECT * FROM ops.dot_event_deliveries
    WHERE environment=$1 AND status='pending' AND not_before<=$2 ORDER BY not_before,id LIMIT 10`,[env.FAREJADOR_ENV,now]);
  for(const item of rows.rows) {
    if(!env.DOT_EVENTS_ENABLED)return;
    await checkLock();
    let sub=(await db.query<Subscription>(activeSubscriptionsSql+' AND s.id=$4 AND s.activation_id=$5',
      [...subscriptionParams(),item.subscription_id,item.activation_id])).rows[0];
    const current=await readSnapshot(item.kind,item.entity_id,db,now);
    if(!sub||!current||current.fingerprint!==item.fingerprint||!matches(sub.arguments,item.entity_id)
      ||now.getTime()-item.created_at.getTime()>86400_000) {
      await setState(db,item.id,'cancelled',null);continue;
    }
    const quiet=!current.urgent?quietUntil(now):null;
    const recent=await db.query<{n:number}>(`SELECT count(*)::int n FROM ops.dot_event_deliveries WHERE environment=$1
      AND subscription_id=$2 AND status='sent' AND sent_at>$3::timestamptz-interval '1 hour'`,[env.FAREJADOR_ENV,sub.id,now]);
    if(quiet||(!current.urgent&&recent.rows[0]!.n>=env.DOT_EVENTS_MAX_PER_HOUR)) {
      await db.query(`UPDATE ops.dot_event_deliveries SET not_before=$3 WHERE id=$1 AND environment=$2 AND status='pending'`,
        [item.id,env.FAREJADOR_ENV,quiet??new Date(now.getTime()+300_000)]);continue;
    }
    // Reads/limits may take time. Refresh authorization, cancellation state and signing keys at the send boundary.
    sub=(await db.query<Subscription>(activeSubscriptionsSql+` AND s.id=$4 AND s.activation_id=$6 AND EXISTS
      (SELECT 1 FROM ops.dot_event_deliveries d WHERE d.id=$5 AND d.environment=s.environment
        AND d.subscription_id=s.id AND d.status='pending')`,[...subscriptionParams(),item.subscription_id,item.id,item.activation_id])).rows[0];
    if(!sub){await setState(db,item.id,'cancelled',null);continue;}
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
