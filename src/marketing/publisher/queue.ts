import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { publicationStatus, type Environment } from './model.js';
import { publisherEvent } from './posts.js';
import type { Delivery } from './graph.js';

export interface Task extends Delivery {
  post_id:string;lease_id:string;status:string;publish_path:string;original_path:string;started_at:Date|null;
}
export async function claimDelivery(pool:Pool,environment:Environment):Promise<Task|null> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const task=(await client.query<Task>(`SELECT d.*,m.kind media_kind,m.publish_path,m.original_path FROM ops.publisher_destinations d
      JOIN ops.publisher_posts p ON p.environment=d.environment AND p.id=d.post_id
      JOIN ops.publisher_media m ON m.environment=p.environment AND m.id=p.media_id
      WHERE d.environment=$1 AND p.status IN ('scheduled','publishing') AND m.status='ready'
      AND d.status IN ('queued','preparing','processing','publishing','verifying') AND d.next_attempt_at<=now()
      AND (d.lease_until IS NULL OR d.lease_until<now()) ORDER BY d.next_attempt_at
      LIMIT 1 FOR UPDATE OF p SKIP LOCKED`,[environment])).rows[0];
    if(!task){await client.query('COMMIT');return null;}
    const lease=randomUUID();const status=task.status==='queued'?'preparing':task.status;
    await client.query(`UPDATE ops.publisher_destinations SET status=$4,lease_id=$5,lease_until=now()+interval '90 seconds',
      started_at=coalesce(started_at,now()),updated_at=now() WHERE environment=$1 AND post_id=$2 AND platform=$3`,[environment,task.post_id,task.platform,status,lease]);
    await client.query(`UPDATE ops.publisher_posts SET status='publishing',updated_at=now() WHERE environment=$1 AND id=$2`,[environment,task.post_id]);
    await client.query('COMMIT');return {...task,status,lease_id:lease,started_at:task.started_at??new Date()};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function setDelivery(pool:Pool,environment:Environment,task:Task,status:string,values:{container?:string;provider?:string;url?:string|null;error?:string}={}) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Ordem de locks igual à submissão/cancelamento: publicação, depois destino.
    await client.query('SELECT id FROM ops.publisher_posts WHERE environment=$1 AND id=$2 FOR UPDATE',[environment,task.post_id]);
    const result=await client.query(`UPDATE ops.publisher_destinations SET status=$5,container_id=coalesce($6,container_id),
      provider_id=coalesce($7,provider_id),post_url=coalesce($8,post_url),error_code=$9,
      lease_until=CASE WHEN $5='publishing' THEN now()+interval '90 seconds' ELSE NULL END,
      next_attempt_at=now()+interval '15 seconds',updated_at=now()
      WHERE environment=$1 AND post_id=$2 AND platform=$3 AND lease_id=$4 RETURNING platform`,
      [environment,task.post_id,task.platform,task.lease_id,status,values.container??null,values.provider??null,values.url??null,values.error??null]);
    if(!result.rowCount){await client.query('COMMIT');return false;}
    const statuses=(await client.query<{status:string}>('SELECT status FROM ops.publisher_destinations WHERE environment=$1 AND post_id=$2',[environment,task.post_id])).rows;
    await client.query(`UPDATE ops.publisher_posts SET status=$3,updated_at=now() WHERE environment=$1 AND id=$2`,[environment,task.post_id,publicationStatus(statuses.map(d=>d.status))]);
    await publisherEvent(client,environment,task.post_id,'delivery_'+status,'worker',{platform:task.platform,...(values.error?{error:values.error}:{})});
    await client.query('COMMIT');return true;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
