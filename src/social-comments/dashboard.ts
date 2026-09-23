import type { Pool } from 'pg';
import { env } from '../shared/config/env.js';
import { commentsConfig } from './config.js';

export async function commentsDashboard(pool: Pool, page = 1) {
  const config = commentsConfig();
  const available = await pool.query(`SELECT to_regclass('ops.meta_comment_actions') IS NOT NULL AS ready`);
  const configuration = { enabled:config.enabled,publishing:config.publish && env.FAREJADOR_ENV === 'prod',
    account_scope_valid:config.scopeValid,
    ai_configured:Boolean(env.OPENAI_API_KEY),token_configured:Boolean(config.token),
    facebook_configured:Boolean(config.pageId),instagram_configured:Boolean(config.instagramId),
    webhook_configured:Boolean(config.appSecret && env.META_MESSAGING_WEBHOOK_VERIFY_TOKEN) };
  if (!available.rows[0]?.ready) return { ready:false,configuration,paused:false,rows:[],total:0,page,summary:{} };
  const [rows,summary,control,jobs] = await Promise.all([
    pool.query(`SELECT c.id,c.platform,c.author_label,c.body,c.occurred_at,c.removed,a.status,a.error_code,
      a.provider_reply_id,a.completion_source,a.post_url,a.updated_at,d.action,d.sentiment,d.reply_text,d.reason,d.comment_snapshot
      FROM core.meta_comments c JOIN ops.meta_comment_actions a ON a.environment=c.environment AND a.comment_id=c.id
      LEFT JOIN analytics.meta_comment_decisions d ON d.environment=a.environment AND d.id=a.decision_id
      WHERE c.environment=$1 ORDER BY c.occurred_at DESC,c.id DESC LIMIT 30 OFFSET $2`,[env.FAREJADOR_ENV,(page-1)*30]),
    pool.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE status='replied')::int AS replied,
      count(*) FILTER(WHERE status='deleted')::int AS deleted,
      count(*) FILTER(WHERE status IN ('failed','uncertain'))::int AS failed,
      count(*) FILTER(WHERE status IN ('pending','generating','queued','sending'))::int AS pending
      FROM ops.meta_comment_actions WHERE environment=$1`,[env.FAREJADOR_ENV]),
    pool.query(`SELECT paused FROM ops.meta_comment_controls WHERE environment=$1`,[env.FAREJADOR_ENV]),
    pool.query(`SELECT count(*)::int AS failed FROM ops.meta_comment_events WHERE environment=$1 AND status='failed'`,[env.FAREJADOR_ENV]),
  ]);
  return {ready:true,configuration,paused:control.rows[0]?.paused ?? false,rows:rows.rows,
    total:summary.rows[0].total,page,summary:summary.rows[0],failed_events:jobs.rows[0].failed};
}
