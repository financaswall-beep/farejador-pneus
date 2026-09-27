import type { Pool } from 'pg';
import type { Platform } from '../../social-comments/config.js';

/** Post-level operational counts, not lifetime engagement or inferred sales. */
export async function organicPublicationSummary(db: Pool, environment: string, platform: Platform,
  account: string, post: string) {
  const available = await db.query(`SELECT to_regclass('core.meta_comments') IS NOT NULL
    AND to_regclass('ops.meta_comment_actions') IS NOT NULL AS ready`);
  if (!available.rows[0]?.ready) return { available: false, comments: null, series: [] };
  const [totals, series] = await Promise.all([
    db.query(`SELECT count(*)::int AS received,
        count(*) FILTER(WHERE a.status='replied')::int AS replied,
        count(*) FILTER(WHERE a.status='deleted')::int AS deleted,
        count(*) FILTER(WHERE a.status IN ('pending','generating','queued','sending'))::int AS pending,
        count(*) FILTER(WHERE a.status IN ('failed','uncertain'))::int AS failed,
        min(c.occurred_at) AS first_received_at,max(c.occurred_at) AS last_received_at
      FROM core.meta_comments c LEFT JOIN ops.meta_comment_actions a
        ON a.environment=c.environment AND a.comment_id=c.id
      WHERE c.environment=$1 AND c.platform=$2 AND c.account_id=$3 AND c.post_id=$4`,
    [environment, platform, account, post]),
    db.query(`SELECT (c.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS date,
        count(*)::int AS received FROM core.meta_comments c
      WHERE c.environment=$1 AND c.platform=$2 AND c.account_id=$3 AND c.post_id=$4
      GROUP BY 1 ORDER BY 1 DESC LIMIT 30`, [environment, platform, account, post]),
  ]);
  return { available: true, comments: totals.rows[0], series: series.rows.reverse() };
}
