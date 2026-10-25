import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import { dotConfig } from '../config.js';
import { withDotReadOnly } from '../read-only.js';
import { readSettings,ruleEnabled } from './settings.js';
import { getPublicHealth,sendWebhook,type WebhookSender } from './https.js';
import { recordExternalHealth,readExternalHealth,externalHealthId } from './external-health.js';
import { activeSubscriptions } from './subscriptions.js';
import { enqueueSnapshot } from './queue.js';
import { deliverEvents } from './delivery.js';
import { dotEventsAvailable } from './availability.js';

export type HealthProbe=(url:string)=>Promise<{status:number;body:string}>;
export function healthResponseOk(response:{status:number;body:string}) {
 if(response.status!==200)return false;
 try{return ['ok','degraded'].includes(JSON.parse(response.body).status);}catch{return false;}
}
/** Run ONLY on a separate host. Sends only its own probe event, never processes business queues. */
export async function runExternalCycle(db:Pool,probe:HealthProbe=getPublicHealth,send:WebhookSender=sendWebhook,now=new Date()) {
 if(!dotEventsAvailable())return;
 const config=dotConfig();if(!config)return;
 const response=await probe(config.origin+'/healthz').catch(()=>({status:0,body:''}));
 const lock=await db.connect();
 try {
  await lock.query('BEGIN');await lock.query("SET LOCAL idle_in_transaction_session_timeout='5min'");
  if(!(await lock.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',[env.FAREJADOR_ENV+':dot-event-worker'])).rows[0].locked)return;
  await recordExternalHealth(db,healthResponseOk(response),response.status,now);
  const {settings}=await readSettings(db);
  if(ruleEnabled(settings,'farejador.sistema.atencao')) {
   const snapshot=await withDotReadOnly(reader=>readExternalHealth(reader,settings,now),db);
   if(snapshot)for(const sub of await activeSubscriptions(db))await enqueueSnapshot(db,sub,snapshot,now,now);
  }
  await deliverEvents(db,send,now,async()=>{await lock.query('SELECT 1');},externalHealthId);
 }finally{try{await lock.query('ROLLBACK');}finally{lock.release();}}
}
