import type { Pool } from 'pg';
import { pool } from '../../../persistence/db.js';
import { env } from '../../../shared/config/env.js';
import { logger } from '../../../shared/logger.js';
import { collectEvents } from './queue.js';
import { deliverEvents } from './delivery.js';
import { seal } from './crypto.js';
import { sendWebhook,type WebhookSender } from './https.js';

/** Transaction-scoped lock works through Supabase transaction pooling as well as direct connections. */
export async function runEventCycle(db:Pool=pool,send:WebhookSender=sendWebhook) {
  if(!env.DOT_EVENTS_ENABLED||!env.DOT_MCP_ENABLED)return;
  const lock=await db.connect();let held=false;
  try {
    await lock.query('BEGIN');
    await lock.query("SET LOCAL idle_in_transaction_session_timeout='5min'");
    held=(await lock.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',[env.FAREJADOR_ENV+':dot-event-worker'])).rows[0].locked;
    if(!held)return;
    await collectEvents(db);
    await deliverEvents(db,send,undefined,async()=>{await lock.query('SELECT 1');});
    // Private technical history only. Preserve pending retries and live incident deduplication for seven days.
    await db.query(`DELETE FROM ops.dot_event_deliveries WHERE environment=$1 AND status<>'pending' AND created_at<now()-interval '7 days'`,[env.FAREJADOR_ENV]);
    await db.query(`DELETE FROM ops.dot_monitor_targets WHERE environment=$1 AND due_at IS NULL AND changed_at<now()-interval '7 days'`,[env.FAREJADOR_ENV]);
    await db.query(`DELETE FROM network.dot_event_subscriptions WHERE environment=$1
      AND COALESCE(revoked_at,expires_at)<now()-interval '7 days'`,[env.FAREJADOR_ENV]);
  }finally{
    try{await lock.query('ROLLBACK');}finally{lock.release();}
  }
}
export async function assertDotEventsSchema(db:Pool=pool) {
  if(!env.DOT_EVENTS_ENABLED)return;
  if(!env.DOT_MCP_ENABLED)throw new Error('DOT_EVENTS_ENABLED requires DOT_MCP_ENABLED');
  if(env.DATABASE_POOL_MAX<2)throw new Error('DOT_EVENTS_ENABLED requires DATABASE_POOL_MAX >= 2');
  seal('configuration-check','configuration-check');
  await db.query('SELECT id,verified_at FROM network.dot_event_subscriptions LIMIT 0');
  await db.query('SELECT id FROM ops.dot_event_deliveries LIMIT 0');
  await db.query('SELECT revision FROM ops.dot_monitor_targets LIMIT 0');
}
export function startDotEventsWorker() {
  if(!env.DOT_EVENTS_ENABLED)return ()=>{};
  let stopped=false,timer:NodeJS.Timeout;
  async function loop() {
    try { await runEventCycle(); }catch { logger.warn({code:'dot_event_cycle_failed'},'dot events unavailable'); }
    if(!stopped)timer=setTimeout(()=>void loop(),30_000);
  }
  void loop();return ()=>{stopped=true;clearTimeout(timer);};
}
