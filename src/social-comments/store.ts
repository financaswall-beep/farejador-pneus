import type { Pool } from 'pg';
import { env } from '../shared/config/env.js';
import { COMMENT_PROMPT_VERSION } from './prompt.js';
import type { AiDecision } from './ai.js';
import type { Platform } from './config.js';

export interface CommentTask {
  id:string; platform:Platform; account_id:string; comment_id:string; post_id:string;
  author_id:string|null; body:string; revision:string; decision_id:string|null;
  action:'reply'|'delete'|'ignore'; reply_text:string; decision_revision:string; attempts:number; lease_id:string;
}
export async function commentsPaused(pool: Pool): Promise<boolean> {
  const result = await pool.query(`SELECT paused FROM ops.meta_comment_controls WHERE environment=$1`,[env.FAREJADOR_ENV]);
  return result.rows[0]?.paused === true;
}
export async function recoverCommentLeases(pool: Pool): Promise<void> {
  // Uma escrita sem confirmação nunca é repetida: a Meta não oferece chave de idempotência para reply.
  await pool.query(`UPDATE ops.meta_comment_actions SET status='uncertain',error_code='delivery_confirmation_missing',updated_at=now()
    WHERE environment=$1 AND status='sending' AND updated_at<now()-interval '3 minutes'`,[env.FAREJADOR_ENV]);
  await pool.query(`UPDATE ops.meta_comment_actions SET status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,
    error_code='analysis_interrupted',updated_at=now()
    WHERE environment=$1 AND status='generating' AND updated_at<now()-interval '3 minutes'`,[env.FAREJADOR_ENV]);
}
export async function claimComment(pool: Pool, phase:'generation'|'publication'): Promise<CommentTask|null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<CommentTask>(`SELECT c.*,a.attempts,a.decision_id,d.action,d.reply_text,d.revision AS decision_revision
      FROM ops.meta_comment_actions a JOIN core.meta_comments c ON c.environment=a.environment AND c.id=a.comment_id
      LEFT JOIN analytics.meta_comment_decisions d ON d.environment=a.environment AND d.id=a.decision_id
      WHERE a.environment=$1 AND a.status=$2 AND a.next_attempt_at<=now() AND NOT c.removed
        AND NOT EXISTS(SELECT 1 FROM ops.meta_comment_controls s WHERE s.environment=a.environment AND s.paused)
      ORDER BY c.occurred_at,c.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,[env.FAREJADOR_ENV,phase==='generation' ? 'pending' : 'queued']);
    const row = result.rows[0];
    if (row) {
      const lease = await client.query<{lease_id:string}>(`UPDATE ops.meta_comment_actions SET status=$3,updated_at=now(),attempts=attempts+1,lease_id=gen_random_uuid()
        WHERE environment=$1 AND comment_id=$2 RETURNING lease_id`,[env.FAREJADOR_ENV,row.id,phase==='generation' ? 'generating' : 'sending']);
      row.lease_id = lease.rows[0]!.lease_id;
    }
    await client.query('COMMIT');
    return row ?? null;
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function saveDecision(pool: Pool, task: CommentTask, ai: AiDecision, postUrl: string|null = null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A edição/remoção ou uma resposta humana ocorrida durante a IA invalida o resultado.
    const current = await client.query(`SELECT a.decision_id FROM ops.meta_comment_actions a
      JOIN core.meta_comments c ON c.environment=a.environment AND c.id=a.comment_id
      WHERE a.environment=$1 AND a.comment_id=$2 AND a.status='generating' AND c.revision=$3 AND NOT c.removed AND a.lease_id=$4
      FOR UPDATE OF a,c`,[env.FAREJADOR_ENV,task.id,task.revision,task.lease_id]);
    if (!current.rowCount) { await client.query('COMMIT'); return; }
    const d = ai.decision;
    const inserted = await client.query<{id:string}>(`INSERT INTO analytics.meta_comment_decisions
      (environment,comment_id,revision,action,sentiment,reply_text,reason,extractor_version,confidence_level,source_reference,model,input_tokens,output_tokens,comment_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [env.FAREJADOR_ENV,task.id,task.revision,d.action,d.sentiment,d.reply_text,d.reason,COMMENT_PROMPT_VERSION,
      d.confidence_level,`core.meta_comments:${task.id}:${task.revision}`,ai.model,ai.inputTokens,ai.outputTokens,task.body]);
    const decisionId = inserted.rows[0]!.id;
    if (current.rows[0].decision_id) await client.query(`UPDATE analytics.meta_comment_decisions SET superseded_by=$3
      WHERE environment=$1 AND id=$2 AND superseded_by IS NULL`,[env.FAREJADOR_ENV,current.rows[0].decision_id,decisionId]);
    await client.query(`UPDATE ops.meta_comment_actions SET decision_id=$3,status=$4,attempts=0,error_code=NULL,updated_at=now(),post_url=$5
      WHERE environment=$1 AND comment_id=$2`,[env.FAREJADOR_ENV,task.id,decisionId,d.action==='ignore' ? 'ignored' : 'queued',postUrl]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function finishComment(pool: Pool, task: CommentTask, expected: string, status: string, error: string|null = null, providerId:string|null = null): Promise<void> {
  await pool.query(`UPDATE ops.meta_comment_actions SET status=$4,error_code=$5,
    provider_reply_id=COALESCE($6,provider_reply_id),updated_at=now(),next_attempt_at=now()+interval '1 minute',
    completion_source=CASE WHEN $4 IN ('replied','deleted') THEN 'automation' ELSE completion_source END
    WHERE environment=$1 AND comment_id=$2 AND lease_id=$7 AND (status=$3
      OR ($4='replied' AND status='replied' AND provider_reply_id=$6))`,[env.FAREJADOR_ENV,task.id,expected,status,error,providerId,task.lease_id]);
}
