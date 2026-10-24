import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import { pool } from '../../../persistence/db.js';
import { env } from '../../../shared/config/env.js';
import { dotConfig } from '../config.js';
import type { DotIdentity } from '../token-store.js';
import { callbackUrl,sendWebhook,type WebhookSender } from './https.js';
import { equalChallenge,seal,signedHeaders,signingKey,unseal } from './crypto.js';
import { canonicalFilters,eventNames,filterSchema,hash,type EventFilters, type EventName } from './model.js';
import { withSubscriptionLock } from './subscription-lock.js';

export const subscriptionInput=z.object({name:z.enum(eventNames),arguments:filterSchema.default({}),
  delivery:z.object({mode:z.literal('webhook'),url:z.string().max(2048),secret:z.string().max(100)}).strict(),
  cursor:z.null().optional(),ttlMs:z.number().int().min(60_000).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}).strict();
const unsubscribeInput=subscriptionInput.omit({cursor:true,ttlMs:true}).extend({
  delivery:z.object({mode:z.literal('webhook'),url:z.string().max(2048)}).strict(),
}).strict();
export interface Subscription {
  id:string;person_id:string;grant_id:string;activation_id:string;event_name:EventName;arguments:EventFilters;callback_url:string;
  secret_ciphertext:string;previous_secret_ciphertext:string|null;previous_secret_until:Date|null;
  expires_at:Date;created_at:Date;verified_at:Date;revoked_at:Date|null;pending_nonce:string|null;
}
export const activeSubscriptionsSql=`SELECT s.* FROM network.dot_event_subscriptions s
  JOIN network.dot_oauth_grants g ON g.id=s.grant_id AND g.environment=s.environment AND g.person_id=s.person_id
  JOIN network.partner_people p ON p.id=g.person_id AND p.environment=g.environment AND p.revoked_at IS NULL
  JOIN network.matriz_collaborators c ON c.id=g.collaborator_id AND c.person_id=p.id AND c.environment=g.environment
    AND c.panel_role='owner' AND c.revoked_at IS NULL
  WHERE s.environment=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
    AND g.revoked_at IS NULL AND g.expires_at>now() AND g.code_used_at IS NOT NULL
    AND g.client_id=$2 AND g.resource=$3 AND g.scope='farejador.read'`;
export function subscriptionParams() {
  const config=dotConfig();if(!config)throw new Error('dot_disabled');
  return [env.FAREJADOR_ENV,config.clientId,config.resource];
}
export async function activeSubscriptions(db:Pick<Pool,'query'>=pool) {
  return (await db.query<Subscription>(activeSubscriptionsSql,subscriptionParams())).rows;
}
export function subscriptionId(identity:DotIdentity,name:string,url:string,args:unknown) {
  return 'sub_'+hash(JSON.stringify([env.FAREJADOR_ENV,identity.person_id,name,url,canonicalFilters(args)]));
}
export async function subscribe(identity:DotIdentity,raw:unknown,db:Pool=pool,send:WebhookSender=sendWebhook) {
  const input=subscriptionInput.parse(raw),url=callbackUrl(input.delivery.url).href;
  signingKey(input.delivery.secret);
  const args=canonicalFilters(input.arguments),id=subscriptionId(identity,input.name,url,args);
  const nonce=randomUUID();
  // Reserve a generation before network I/O. Unsubscribe/newer refresh invalidates this generation.
  const prior=await withSubscriptionLock(db,identity,async client=>{
    const count=await client.query(`SELECT count(*)::int n FROM network.dot_event_subscriptions
      WHERE environment=$1 AND person_id=$2 AND id<>$3 AND ((revoked_at IS NULL AND expires_at>now())
        OR (pending_nonce IS NOT NULL AND requested_at>now()-interval '1 minute'))`,[env.FAREJADOR_ENV,identity.person_id,id]);
    if(count.rows[0].n>=10)throw new Error('subscription_limit');
    const previous=(await client.query<Subscription>('SELECT * FROM network.dot_event_subscriptions WHERE id=$1 AND environment=$2',
      [id,env.FAREJADOR_ENV])).rows[0];
    await client.query(`INSERT INTO network.dot_event_subscriptions
      (id,environment,person_id,grant_id,event_name,arguments,callback_url,secret_ciphertext,expires_at,revoked_at,pending_nonce,requested_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),now(),$9,now()) ON CONFLICT(id) DO UPDATE SET pending_nonce=$9,requested_at=now()`,
    [id,env.FAREJADOR_ENV,identity.person_id,identity.grant_id,input.name,args,url,seal(input.delivery.secret,id),nonce]);
    return previous;
  });
  const secretMatches=prior&&unseal(prior.secret_ciphertext,id)===input.delivery.secret;
  const reuseVerification=secretMatches&&!prior.revoked_at&&prior.grant_id===identity.grant_id
    &&prior.expires_at.getTime()>Date.now()&&Date.now()-prior.verified_at.getTime()<3600_000;
  try { if(!reuseVerification) {
    const challenge=randomUUID(),body=JSON.stringify({type:'verification',challenge});
    const response=await send(url,body,signedHeaders('verify_'+randomUUID(),body,id,[input.delivery.secret]));
    let echoed:unknown;try{echoed=JSON.parse(response.body).challenge;}catch{echoed=null;}
    if(response.status<200||response.status>=300||!equalChallenge(challenge,echoed))throw new Error('callback_verification_failed');
  }
  return await withSubscriptionLock(db,identity,async(client,grantExpires)=>{
    const current=(await client.query<Subscription>('SELECT * FROM network.dot_event_subscriptions WHERE id=$1 AND environment=$2',
      [id,env.FAREJADOR_ENV])).rows[0];
    if(current?.pending_nonce!==nonce)throw new Error('subscription_changed');
    const expires=new Date(Math.min(Date.now()+Math.min(input.ttlMs??86400_000,86400_000),grantExpires.getTime()));
    // Reconnecting must never revive queued events authorized by an earlier grant.
    await client.query(`UPDATE ops.dot_event_deliveries d SET status='cancelled' FROM network.dot_event_subscriptions s
      WHERE d.subscription_id=s.id AND d.environment=s.environment AND s.id=$1 AND s.environment=$2
        AND d.status='pending' AND (s.grant_id<>$3 OR s.revoked_at IS NOT NULL OR s.expires_at<=now())`,[id,env.FAREJADOR_ENV,identity.grant_id]);
    const rotating=!!prior&&!prior.revoked_at&&prior.grant_id===identity.grant_id&&!secretMatches;
    await client.query(`UPDATE network.dot_event_subscriptions SET
      previous_secret_ciphertext=CASE WHEN revoked_at IS NOT NULL OR expires_at<=now() OR grant_id<>$3 THEN NULL
        WHEN $7 THEN secret_ciphertext ELSE previous_secret_ciphertext END,
      previous_secret_until=CASE WHEN revoked_at IS NOT NULL OR expires_at<=now() OR grant_id<>$3 THEN NULL
        WHEN $7 THEN now()+interval '2 minutes' ELSE previous_secret_until END,
      secret_ciphertext=$4,expires_at=$5,
      activation_id=CASE WHEN revoked_at IS NOT NULL OR expires_at<=now() OR grant_id<>$3 THEN gen_random_uuid() ELSE activation_id END,
      created_at=CASE WHEN revoked_at IS NOT NULL OR expires_at<=now() OR grant_id<>$3 THEN now() ELSE created_at END,
      grant_id=$3,verified_at=CASE WHEN $6 THEN verified_at ELSE now() END,revoked_at=NULL,pending_nonce=NULL
      WHERE id=$1 AND environment=$2 AND pending_nonce=$8`,
    [id,env.FAREJADOR_ENV,identity.grant_id,seal(input.delivery.secret,id),expires,!!reuseVerification,rotating,nonce]);
    return {id,refreshBefore:expires.toISOString(),cursor:null,truncated:false};
  });
  }catch(error){
    await db.query(`UPDATE network.dot_event_subscriptions SET pending_nonce=NULL WHERE id=$1 AND environment=$2 AND pending_nonce=$3`,
      [id,env.FAREJADOR_ENV,nonce]);throw error;
  }
}
export async function unsubscribe(identity:DotIdentity,raw:unknown,db:Pool=pool) {
  const input=unsubscribeInput.parse(raw),url=callbackUrl(input.delivery.url).href;
  const id=subscriptionId(identity,input.name,url,input.arguments);
  await withSubscriptionLock(db,identity,async client=>client.query(`WITH stopped AS (UPDATE network.dot_event_subscriptions
    SET revoked_at=COALESCE(revoked_at,now()),pending_nonce=NULL
    WHERE id=$1 AND environment=$2 AND person_id=$3 RETURNING id)
    UPDATE ops.dot_event_deliveries SET status='cancelled' WHERE subscription_id IN(SELECT id FROM stopped)
      AND environment=$2 AND status='pending'`,[id,env.FAREJADOR_ENV,identity.person_id]));
  return {};
}
