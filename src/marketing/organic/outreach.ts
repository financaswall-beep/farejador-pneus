import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { type CommentsGraph, MetaCommentError } from '../../social-comments/graph.js';
import type { CommentTask } from '../../social-comments/store.js';
import { composePrivateOffer, privateReplyEligible } from './private-message.js';
import { organicRuntimeReady } from './controls.js';

/** Esta escrita tem estado durável antes da chamada; resultado incerto nunca é reenviado. */
export async function sendOrganicPrivate(pool:Pool, task:CommentTask, graph:CommentsGraph):Promise<boolean> {
  if (!organicRuntimeReady(task.platform)) return false;
  const client=await pool.connect();
  let id:string|null=null;
  let writeStarted=false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`organic:${env.FAREJADOR_ENV}:${task.platform}:${task.account_id}:${task.author_id ?? task.id}`]);
    const existing=await client.query(`SELECT status FROM ops.organic_outreach WHERE environment=$1 AND comment_id=$2`,[env.FAREJADOR_ENV,task.id]);
    if(existing.rows[0]) { await client.query('COMMIT');return existing.rows[0].status==='sent'; }
    const decision=await client.query(`SELECT d.*,c.occurred_at,c.removed,s.activated_at FROM analytics.meta_comment_decisions d
      JOIN core.meta_comments c ON c.environment=d.environment AND c.id=d.comment_id
      JOIN ops.organic_controls s ON s.environment=d.environment AND s.platform=c.platform AND s.enabled
      WHERE d.environment=$1 AND d.id=$2 AND d.superseded_by IS NULL AND d.revision=c.revision
        AND s.verified_at IS NOT NULL AND s.verified_inbox_id IS NOT NULL`,[env.FAREJADOR_ENV,task.decision_id]);
    const d=decision.rows[0];
    if(!d || !task.author_id || !privateReplyEligible(d)) {await client.query('COMMIT');return false;}
    const busy=await client.query(`SELECT 1 FROM ops.organic_outreach o JOIN core.meta_comments c
        ON c.environment=o.environment AND c.id=o.comment_id
      WHERE o.environment=$1 AND o.platform=$2 AND o.account_id=$3 AND c.author_id=$4
        AND o.status IN ('sending','uncertain','sent') AND o.created_at>now()-interval '24 hours'
      UNION ALL SELECT 1 FROM ops.organic_inbound i JOIN core.conversations cv
        ON cv.environment=i.environment AND cv.id=i.conversation_id
      LEFT JOIN ops.conversation_bot_control b ON b.environment=cv.environment AND b.conversation_id=cv.id
      WHERE i.environment=$1 AND i.platform=$2 AND i.account_id=$3 AND i.sender_id=$4
        AND cv.deleted_at IS NULL AND (cv.current_status<>'resolved' OR b.mode='human') LIMIT 1`,
      [env.FAREJADOR_ENV,task.platform,task.account_id,task.author_id]);
    const body=composePrivateOffer(d.private_body,d.commercial_snapshot);
    const row=await client.query(`INSERT INTO ops.organic_outreach
      (environment,comment_id,decision_id,platform,account_id,body,status,error_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[env.FAREJADOR_ENV,task.id,task.decision_id,
      task.platform,task.account_id,body,busy.rowCount?'skipped':'sending',busy.rowCount?'existing_attendance':null]);
    await client.query('COMMIT');
    if(busy.rowCount)return false;
    id=row.rows[0].id;
    // Sem rede dentro da transação. Havendo conversa anterior, a continuidade cabe ao atendimento.
    if(await graph.hasConversation(task.platform,task.account_id,task.author_id)) {
      await pool.query(`UPDATE ops.organic_outreach SET status='skipped',error_code='existing_attendance',updated_at=now()
        WHERE environment=$1 AND id=$2 AND status='sending'`,[env.FAREJADOR_ENV,id]);
      return false;
    }
    const active=await pool.query(`SELECT 1 FROM ops.organic_controls s
      WHERE s.environment=$1 AND s.platform=$2 AND s.enabled
        AND EXISTS(SELECT 1 FROM ops.meta_comment_actions a JOIN core.meta_comments c
          ON c.environment=a.environment AND c.id=a.comment_id WHERE a.environment=s.environment
          AND a.comment_id=$3 AND a.status='sending' AND a.lease_id=$4 AND c.revision=$5 AND NOT c.removed)
        AND NOT EXISTS(SELECT 1 FROM ops.meta_comment_controls c WHERE c.environment=s.environment AND c.paused)`,
      [env.FAREJADOR_ENV,task.platform,task.id,task.lease_id,task.revision]);
    if(!active.rowCount) {
      await pool.query(`UPDATE ops.organic_outreach SET status='skipped',error_code='paused',updated_at=now() WHERE environment=$1 AND id=$2`,[env.FAREJADOR_ENV,id]);
      return false;
    }
    await pool.query(`UPDATE ops.organic_outreach SET submitted_at=now(),updated_at=now()
      WHERE environment=$1 AND id=$2 AND status='sending'`,[env.FAREJADOR_ENV,id]);
    writeStarted=true;
    const sent=await graph.privateReply(task.platform,task.account_id,task.comment_id,body);
    await pool.query(`UPDATE ops.organic_outreach SET status='sent',recipient_id=$3,provider_message_id=$4,
      sent_at=now(),updated_at=now() WHERE environment=$1 AND id=$2 AND status='sending'`,
      [env.FAREJADOR_ENV,id,sent.recipientId,sent.messageId]);
    return true;
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    if(!id)return false;
    const uncertain=writeStarted && (!(error instanceof MetaCommentError) || error.uncertain);
    await pool.query(`UPDATE ops.organic_outreach SET status=$3,error_code=$4,updated_at=now()
      WHERE environment=$1 AND id=$2 AND status='sending'`,[env.FAREJADOR_ENV,id,uncertain?'uncertain':'failed',
      error instanceof MetaCommentError ? error.code : writeStarted?'private_ack_unknown':'private_preflight_failed']);
    return false;
  } finally {client.release();}
}
