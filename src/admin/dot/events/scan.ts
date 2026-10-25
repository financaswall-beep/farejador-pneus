import type { Pool } from 'pg';
import { env } from '../../../shared/config/env.js';
import { withDotReadOnly } from '../read-only.js';
import { activeSubscriptions } from './subscriptions.js';
import { enqueueSnapshot } from './queue.js';
import { readSettings,ruleEnabled } from './settings.js';
import { readSignals,signalEventNames } from './signals.js';
import { bounded } from './signal-model.js';

/** Bounded scans run only for enabled, subscribed categories. No commercial writes. */
export async function scanSignals(db:Pool,now=new Date(),onlySystem=false) {
 const {settings}=await readSettings(db);if(settings.paused)return;
 const subs=await activeSubscriptions(db);
 for(const name of signalEventNames) {
  if(onlySystem&&name!=='farejador.sistema.atencao')continue;
  const matching=subs.filter(s=>s.event_name===name);
  if(!matching.length||!ruleEnabled(settings,name))continue;
  // A failed source does not prevent independent categories from being checked.
  let rows;try{rows=await readSignals(name,db,now);}catch{continue;}
  for(const snapshot of rows)for(const sub of matching)await enqueueSnapshot(db,sub,snapshot,now,now);
 }
 if(!onlySystem&&ruleEnabled(settings,'farejador.entrega.atencao')&&subs.some(s=>s.event_name==='farejador.entrega.atencao')) {
  const rows=await withDotReadOnly(async reader=>bounded((await reader.query<{id:string}>(`SELECT o.id
   FROM commerce.orders o JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
   WHERE o.environment=$1 AND o.partner_order_id IS NULL AND o.fulfillment_mode='delivery' AND o.status<>'cancelled'
    AND o.delivery_status IN ('pending','dispatched','failed') ORDER BY o.created_at,o.id LIMIT 1001`,[env.FAREJADOR_ENV])).rows),db);
  for(const row of rows)await db.query(`INSERT INTO ops.dot_monitor_targets(environment,kind,entity_id,due_at)
   VALUES($1,'order',$2,$3) ON CONFLICT(environment,kind,entity_id) DO UPDATE
   SET due_at=LEAST(COALESCE(ops.dot_monitor_targets.due_at,$3),$3)`,[env.FAREJADOR_ENV,row.id,now]);
 }
}
