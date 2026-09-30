import type { Pool } from 'pg';
import type { PostReference } from './results-model.js';

export type ViewObservation = PostReference & { observed_at: string; views: number | null; metric: string };
type Queryable = Pick<Pool, 'query'>;
const refsJson = (refs: PostReference[]) => JSON.stringify(refs);
export async function metricHistoryReady(db: Queryable) {
  return (await db.query("SELECT to_regclass('analytics.organic_metric_observations') IS NOT NULL AS ready")).rows[0]?.ready === true;
}
export async function recordViewObservation(db: Queryable, environment: string, row: ViewObservation) {
  if (row.views !== null && (!Number.isSafeInteger(row.views) || row.views < 0)) return;
  await db.query(`INSERT INTO analytics.organic_metric_observations
    (environment,platform,account_id,post_id,observed_at,metric,views) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING`, [environment, row.platform, row.account_id, row.post_id,
    row.observed_at, row.metric, row.views]);
}
export async function latestViewObservations(db: Queryable, environment: string, refs: PostReference[]) {
  if (!refs.length) return [];
  return (await db.query(`SELECT DISTINCT ON(o.platform,o.account_id,o.post_id)
      o.platform,o.account_id,o.post_id,o.observed_at,o.metric,o.views
    FROM analytics.organic_metric_observations o
    JOIN jsonb_to_recordset($2::jsonb) AS r(platform text,account_id text,post_id text)
      ON o.platform=r.platform AND o.account_id=r.account_id AND o.post_id=r.post_id
    WHERE o.environment=$1 ORDER BY o.platform,o.account_id,o.post_id,o.observed_at DESC`,
  [environment, refsJson(refs)])).rows.map(row => ({ ...row, views: row.views === null ? null : Number(row.views),
    observed_at: new Date(row.observed_at).toISOString() })) as ViewObservation[];
}
export async function dailyViewHistory(db: Queryable, environment: string, refs: PostReference[], days: 7 | 30) {
  if (!refs.length) return [];
  const rows = (await db.query(`SELECT DISTINCT ON(o.platform,o.account_id,o.post_id,date)
      o.platform,o.account_id,o.post_id,(o.observed_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS date,
      o.observed_at,o.views
    FROM analytics.organic_metric_observations o
    JOIN jsonb_to_recordset($2::jsonb) AS r(platform text,account_id text,post_id text)
      ON o.platform=r.platform AND o.account_id=r.account_id AND o.post_id=r.post_id
    WHERE o.environment=$1 AND o.observed_at >=
      ((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($3::int - 1)) AT TIME ZONE 'America/Sao_Paulo'
    ORDER BY o.platform,o.account_id,o.post_id,date,o.observed_at DESC`, [environment, refsJson(refs), days])).rows;
  return rows.map(row => ({ ...row, views: row.views === null ? null : Number(row.views),
    observed_at: new Date(row.observed_at).toISOString() }));
}
