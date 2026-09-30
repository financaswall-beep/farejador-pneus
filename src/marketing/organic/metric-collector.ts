import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { commentsConfig, type CommentsConfig } from '../../social-comments/config.js';
import { readPublications } from '../../social-comments/publications.js';
import { InsightsGraph } from './insights.js';
import { activeOrganicPlatforms } from './results-model.js';
import { latestViewObservations, metricHistoryReady, recordViewObservation } from './metric-history.js';

/** Coleta limitada e somente leitura na Meta. Replicas compartilham um lock por ambiente. */
export async function collectOrganicMetrics(db: Pool, environment: string, config: CommentsConfig) {
  const active = activeOrganicPlatforms(config);
  if (!active.length || !await metricHistoryReady(db)) return;
  const client = await db.connect();
  let locked = false;
  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired`,
      [`organic_metrics:${environment}`]);
    locked = lock.rows[0]?.acquired === true;
    if (!locked) return;
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const snapshot = await readPublications(config, environment, since);
    const posts = snapshot.rows.filter(row => active.includes(row.platform) && Date.parse(row.published_at) <= Date.now());
    const refs = posts.map(row => ({ platform: row.platform, account_id: row.account_id, post_id: row.id }));
    const latest = await latestViewObservations(db, environment, refs);
    const last = new Map(latest.map(row => [`${row.platform}:${row.account_id}:${row.post_id}`, Date.parse(row.observed_at)]));
    const due = refs.filter(row => (last.get(`${row.platform}:${row.account_id}:${row.post_id}`) ?? 0) < Date.now() - 6 * 3600000)
      .sort((a, b) => (last.get(`${a.platform}:${a.account_id}:${a.post_id}`) ?? 0) - (last.get(`${b.platform}:${b.account_id}:${b.post_id}`) ?? 0))
      .slice(0, 24);
    const graph = new InsightsGraph(config);
    // Duas consultas simultâneas; erros viram observações ausentes, nunca visualizações zero.
    for (let i = 0; i < due.length; i += 2) {
      await Promise.all(due.slice(i, i + 2).map(async ref => {
        const metric = ref.platform === 'instagram' ? 'views' : 'post_media_view';
        const views = await graph.readViews(ref.platform, ref.account_id, ref.post_id).catch(() => null);
        await recordViewObservation(db, environment, { ...ref, metric, views, observed_at: new Date().toISOString() });
      }));
    }
    await db.query(`DELETE FROM analytics.organic_metric_observations
      WHERE environment=$1 AND observed_at < now()-interval '180 days'`, [environment]);
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`organic_metrics:${environment}`]);
    } finally { client.release(); }
  }
}
export function startOrganicMetricCollector(): () => void {
  if (!activeOrganicPlatforms(commentsConfig()).length) return () => undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    if (stopped) return;
    try { await collectOrganicMetrics(pool, env.FAREJADOR_ENV, commentsConfig()); }
    catch { logger.warn('Organic metric collection deferred'); }
    if (!stopped) timer = setTimeout(() => void run(), 10 * 60_000);
  };
  void run();
  return () => { stopped = true; clearTimeout(timer); };
}
