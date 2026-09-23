import type { Pool, PoolClient } from 'pg';
import { commentsConfig, type CommentsConfig } from './config.js';
import { commentRevision, extractComments } from './extract.js';
import { env } from '../shared/config/env.js';

export async function enqueueCommentEvent(client: PoolClient, rawId: number, payload: unknown): Promise<void> {
  const config = commentsConfig();
  if (!config.enabled || extractComments(payload,config).length === 0) return;
  await client.query(`INSERT INTO ops.meta_comment_events(environment,raw_event_id) VALUES($1,$2)
    ON CONFLICT DO NOTHING`,[env.FAREJADOR_ENV,rawId]);
}
export async function normalizeCommentEvent(pool: Pool, config: CommentsConfig): Promise<boolean> {
  const client = await pool.connect();
  let rawId: number | null = null;
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT j.raw_event_id,r.payload,r.received_at FROM ops.meta_comment_events j
      JOIN raw.meta_messaging_events r ON r.environment=j.environment AND r.id=j.raw_event_id
      WHERE j.environment=$1 AND j.status='pending' AND j.next_attempt_at<=now() AND j.attempts<5
      ORDER BY j.raw_event_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,[env.FAREJADOR_ENV]);
    const row = result.rows[0];
    if (!row) { await client.query('COMMIT'); return false; }
    rawId = row.raw_event_id;
    for (const event of extractComments(row.payload,config,new Date(row.received_at))) {
      if (event.own) {
        // Resposta já feita pela própria página (inclusive fora do Farejador).
        if (event.parentId && !event.removed) await client.query(`UPDATE ops.meta_comment_actions a
          SET status='replied',provider_reply_id=$5,completion_source='page',updated_at=now(),error_code=NULL FROM core.meta_comments c
          WHERE a.environment=$1 AND c.environment=a.environment AND c.id=a.comment_id
            AND c.platform=$2 AND c.account_id=$3 AND c.comment_id=$4
            AND a.status NOT IN ('deleted','replied')`,[env.FAREJADOR_ENV,event.platform,event.accountId,event.parentId,event.commentId]);
        continue;
      }
      const normalized = await client.query<{id:string}>(`INSERT INTO core.meta_comments
        (environment,platform,account_id,comment_id,post_id,parent_id,author_id,author_label,body,revision,removed,occurred_at,last_event_at,raw_event_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT(environment,platform,account_id,comment_id) DO UPDATE SET
          body=CASE WHEN excluded.removed THEN core.meta_comments.body ELSE excluded.body END,
          revision=excluded.revision,removed=excluded.removed,last_event_at=excluded.last_event_at,raw_event_id=excluded.raw_event_id
        WHERE excluded.last_event_at>=core.meta_comments.last_event_at
          AND excluded.revision<>core.meta_comments.revision RETURNING id`,
      [env.FAREJADOR_ENV,event.platform,event.accountId,event.commentId,event.postId,event.parentId,event.authorId,event.authorLabel,
        event.body,commentRevision(event.body,event.removed),event.removed,event.occurredAt,event.eventAt,rawId]);
      if (!normalized.rows[0]) continue;
      await client.query(`INSERT INTO ops.meta_comment_actions(environment,comment_id,status) VALUES($1,$2,$3)
        ON CONFLICT(environment,comment_id) DO UPDATE SET status=excluded.status,attempts=0,next_attempt_at=now(),updated_at=now(),error_code=NULL
        WHERE ops.meta_comment_actions.status NOT IN ('sending','replied','deleted','uncertain')`,
      [env.FAREJADOR_ENV,normalized.rows[0].id,event.removed ? 'ignored' : 'pending']);
    }
    await client.query(`UPDATE ops.meta_comment_events SET status='done',attempts=attempts+1 WHERE environment=$1 AND raw_event_id=$2`,[env.FAREJADOR_ENV,rawId]);
    await client.query('COMMIT');
    return true;
  } catch {
    await client.query('ROLLBACK');
    if (rawId) await pool.query(`UPDATE ops.meta_comment_events SET attempts=attempts+1,
      status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,next_attempt_at=now()+interval '1 minute'
      WHERE environment=$1 AND raw_event_id=$2`,[env.FAREJADOR_ENV,rawId]);
    return false;
  } finally { client.release(); }
}
