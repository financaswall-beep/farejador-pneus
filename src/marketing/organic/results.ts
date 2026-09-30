import type { Pool } from 'pg';
import type { CommentsConfig } from '../../social-comments/config.js';
import { readPublications, PublicationsGraph } from '../../social-comments/publications.js';
import { PublisherStorage } from '../publisher/storage.js';
import { activeOrganicPlatforms, deliveryViews, mergeOrganicResults, type CentralResult, type ResultPublication } from './results-model.js';
import { dailyViewHistory, latestViewObservations, metricHistoryReady, recordViewObservation } from './metric-history.js';
import { organicInsights } from './insights.js';
import { publisherConfig } from '../publisher/config.js';

export async function centralResults(db: Pool, environment: string, config: CommentsConfig, id?: string) {
  const ready = (await db.query("SELECT to_regclass('ops.publisher_posts') IS NOT NULL AS ready")).rows[0]?.ready;
  if (!ready) return { rows: [] as CentralResult[], available: false, truncated: false };
  const rows = (await db.query(`SELECT p.id,p.title,p.caption,p.status,p.version,p.scheduled_at,p.created_at,m.thumbnail_path,
      coalesce((SELECT jsonb_agg(jsonb_build_object('platform',d.platform,'account_id',d.account_id,
        'post_id',coalesce(d.provider_id,''),'format',d.format,'status',d.status,'post_url',d.post_url,
        'error_code',d.error_code,'published_at',CASE WHEN d.status='published' THEN d.updated_at END,
        'views',NULL,'observed_at',NULL) ORDER BY d.platform)
        FROM ops.publisher_destinations d WHERE d.environment=p.environment AND d.post_id=p.id),'[]') deliveries
    FROM ops.publisher_posts p LEFT JOIN ops.publisher_media m ON m.environment=p.environment AND m.id=p.media_id
    WHERE p.environment=$1 AND p.status NOT IN ('draft','scheduled') ${id ? 'AND p.id=$2' : ''}
    ORDER BY p.created_at DESC LIMIT 201`, id ? [environment, id] : [environment])).rows;
  // Troca de conta não pode herdar dados ou ações de uma conta antiga.
  for (const row of rows) {
    row.created_at = new Date(row.created_at).toISOString();
    row.scheduled_at = row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null;
    row.deliveries = row.deliveries.filter((d: any) =>
      d.account_id === (d.platform === 'instagram' ? config.instagramId : d.platform === 'facebook' ? config.pageId : null));
  }
  return { rows: rows.slice(0, 200) as CentralResult[], available: true, truncated: rows.length > 200 };
}
async function thumbnails(rows: ResultPublication[], central: CentralResult[]) {
  const storage = new PublisherStorage();
  await Promise.allSettled(rows.filter(row => !row.image_url && row.publisher_id).map(async row => {
    const path = central.find(post => post.id === row.publisher_id)?.thumbnail_path;
    if (path) row.image_url = await storage.signedUrl(path, 3600);
  }));
}
export async function organicResults(db: Pool, environment: string, config: CommentsConfig, since: string) {
  const active = activeOrganicPlatforms(config);
  const [native, saved] = await Promise.allSettled([
    readPublications(config, environment, since), centralResults(db, environment, config),
  ]);
  const posts = native.status === 'fulfilled' ? native.value.rows : [];
  const central = saved.status === 'fulfilled' ? saved.value : { rows: [], available: false, truncated: false };
  const rows = mergeOrganicResults(posts, central.rows, active).filter(row =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date(row.published_at)) >= since
    && Date.parse(row.published_at) <= Date.now());
  let historyReady = false;
  try {
    historyReady = await metricHistoryReady(db);
    if (historyReady) {
      const latest = await latestViewObservations(db, environment, rows.flatMap(row => row.deliveries.filter(d => d.status === 'published' && d.post_id)));
      for (const row of rows) {
        for (const delivery of row.deliveries) {
          const observation = latest.find(o => o.platform === delivery.platform && o.account_id === delivery.account_id && o.post_id === delivery.post_id);
          if (observation) Object.assign(delivery, { views: observation.views, observed_at: observation.observed_at });
        }
        Object.assign(row, deliveryViews(row.deliveries));
      }
    }
  } catch { historyReady = false; }
  await thumbnails(rows, central.rows);
  return { rows, active_platforms: active, history_ready: historyReady, sending_enabled: publisherConfig().sending,
    sources: native.status === 'fulfilled' ? native.value.sources.filter(s => active.includes(s.platform)) :
      active.map(platform => ({ platform, status: 'unavailable', truncated: false, error: null })),
    central_available: central.available, central_truncated: central.truncated, fetched_at: new Date().toISOString() };
}
export async function resolveOrganicResult(db: Pool, environment: string, config: CommentsConfig, key: string) {
  const [platform, id] = key.split(':');
  if (platform === 'publisher') {
    const saved = await centralResults(db, environment, config, id);
    const row = mergeOrganicResults([], saved.rows, activeOrganicPlatforms(config))[0];
    if (!row) return null;
    await thumbnails([row], saved.rows);
    return row;
  }
  if (platform !== 'instagram' && platform !== 'facebook' || !activeOrganicPlatforms(config).includes(platform)) return null;
  const account = platform === 'instagram' ? config.instagramId! : config.pageId!;
  const post = await new PublicationsGraph(config).publication(platform, account, id!);
  return mergeOrganicResults([post], [], activeOrganicPlatforms(config))[0] ?? null;
}
export async function organicResultMetrics(db: Pool, environment: string, config: CommentsConfig,
  publication: ResultPublication, days: 7 | 30, refresh: boolean) {
  const active = activeOrganicPlatforms(config);
  const deliveries = publication.deliveries.filter(d => active.includes(d.platform));
  let historyReady = false;
  try { historyReady = await metricHistoryReady(db); } catch { /* Mantém as métricas atuais se o histórico estiver indisponível. */ }
  const networks = await Promise.all(deliveries.map(async delivery => {
    if (delivery.status !== 'published' || !delivery.post_id) return { ...delivery, insights: null, error: null };
    try {
      const insights = await organicInsights(config, delivery.platform, delivery.account_id, delivery.post_id, refresh);
      const metric = delivery.platform === 'instagram' ? 'views' : 'post_media_view';
      const views = insights.rows.find(row => row.metric === metric)?.value ?? null;
      if (historyReady) {
        try { await recordViewObservation(db, environment, { ...delivery, metric, views, observed_at: insights.fetched_at }); }
        catch { historyReady = false; }
      }
      return { ...delivery, views, observed_at: insights.fetched_at, insights, error: null };
    } catch { return { ...delivery, insights: null, views: null, error: 'organic_insights_unavailable' }; }
  }));
  let history: Awaited<ReturnType<typeof dailyViewHistory>> = [];
  if (historyReady) {
    try { history = await dailyViewHistory(db, environment, deliveries.filter(d => d.status === 'published' && d.post_id), days); }
    catch { historyReady = false; }
  }
  return { networks, history, history_ready: historyReady, active_platforms: active,
    fetched_at: new Date().toISOString(),
    note: 'Acumulado observado em cada dia, no horário de Brasília. Sem coletas anteriores não há histórico. Lacunas não são interpoladas. Pode incluir impulsionamento; visualizações não são pessoas únicas.' };
}
