import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMetaCreatives, metaAdManagerUrl, type MetaCreative } from '../../marketing/meta-creatives.js';
import { marketingDateWindow, type MarketingPeriod, type MetaMarketingConfig } from './marketing-meta.js';
import { loadCreativeInsights, loadCreativeAttribution, type CreativeAttribution } from './queries-marketing-creatives-data.js';

export function marketingCreativeConfig(): MetaMarketingConfig | null {
  return env.MARKETING_META_ENABLED && env.META_ADS_ACCOUNT_ID && env.META_ADS_ACCESS_TOKEN
    ? { adAccountId: env.META_ADS_ACCOUNT_ID, accessToken: env.META_ADS_ACCESS_TOKEN, apiVersion: env.META_GRAPH_API_VERSION } : null;
}
const num = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = (value: number) => Math.round(value * 100) / 100;
export interface MarketingCreativeRow {
  id: string; name: string; campaign_id: string; campaign_name: string; scope: string; currency: string;
  media: MetaCreative | null; meta_url: string; preview_url: string; investment: number; conversations: number;
  impressions: number; clicks: number; cost_per_conversation: number | null;
  tracked: number | null; channels: string[]; attributed_sales: number | null; attributed_revenue: number | null;
  attribution_status: string; series: Array<{ date: string; spend: number; conversations: number }>;
}

export async function getMarketingCreatives(period: MarketingPeriod = '30d', dependencies: {
  dbPool?: Pool; now?: Date; config?: MetaMarketingConfig | null;
  attributionEnabled?: boolean; enforceScope?: boolean; mediaProvider?: typeof getMetaCreatives;
} = {}) {
  const db = dependencies.dbPool ?? pool;
  const now = dependencies.now ?? new Date();
  const window = marketingDateWindow(period, now);
  const config = dependencies.config === undefined ? marketingCreativeConfig() : dependencies.config;
  const account = config?.adAccountId ?? env.META_ADS_ACCOUNT_ID;
  const enabled = dependencies.attributionEnabled ?? env.MARKETING_ATTRIBUTION;
  const enforceScope = dependencies.enforceScope ?? env.MARKETING_SCOPE_ENFORCEMENT_ENABLED;
  const base = { environment: env.FAREJADOR_ENV, generated_at: now.toISOString(), period: { id: period, ...window } };
  if (!account) return { ...base, available: false, media_status: 'not_configured', attribution_enabled: enabled,
    last_collected: null, creatives: [] as MarketingCreativeRow[] };
  const insights = await loadCreativeInsights(db, env.FAREJADOR_ENV, account, window.since, window.until);
  const groups = new Map<string, typeof insights>();
  for (const row of insights) {
    const group = groups.get(row.entity_id) ?? [];
    group.push(row); groups.set(row.entity_id, group);
  }
  const ids = [...groups.keys()];
  const [metadata, attributionResult] = await Promise.all([
    config && ids.length ? (dependencies.mediaProvider ?? getMetaCreatives)(config, ids)
      : Promise.resolve({ ads: [] as MetaCreative[], unavailable: ids.length }),
    loadCreativeAttribution(db, env.FAREJADOR_ENV, account, window.since, window.until)
      .then((rows) => ({ available: true, rows }))
      .catch(() => ({ available: false, rows: [] as CreativeAttribution[] })),
  ]);
  const media = new Map(metadata.ads.map((row) => [row.id, row]));
  const attributions = new Map(attributionResult.rows.map((row) => [row.ad_id, row]));
  const creatives = [...groups.entries()].map(([id, rows]): MarketingCreativeRow => {
    const latest = rows.at(-1)!;
    const spend = money(rows.reduce((sum, row) => sum + num(row.spend), 0));
    const conversations = rows.reduce((sum, row) => sum + num(row.conversations), 0);
    const attributed = attributions.get(id);
    const tracking = attributionResult.available ? num(attributed?.tracked) : null;
    const status = !enabled ? 'disabled' : !attributionResult.available ? 'unavailable'
      : enforceScope && latest.campaign_scope !== 'matrix' ? 'scope_pending'
      : num(tracking) > 0 || num(attributed?.sales) > 0 ? 'ready' : 'pending';
    return {
      id, name: media.get(id)?.name ?? latest.entity_name ?? id,
      campaign_id: latest.campaign_id, campaign_name: latest.campaign_name ?? latest.campaign_id,
      scope: latest.campaign_scope, currency: latest.account_currency,
      media: media.get(id) ?? null, meta_url: metaAdManagerUrl(account, id),
      preview_url: `/admin/api/marketing/creatives/${encodeURIComponent(id)}/preview`,
      investment: spend, conversations, impressions: rows.reduce((sum, row) => sum + num(row.impressions), 0),
      clicks: rows.reduce((sum, row) => sum + num(row.clicks), 0),
      cost_per_conversation: conversations > 0 ? money(spend / conversations) : null,
      tracked: tracking, channels: attributed?.channels ?? [], attribution_status: status,
      attributed_sales: status === 'ready' ? num(attributed?.sales) : null,
      attributed_revenue: status === 'ready' ? money(num(attributed?.revenue)) : null,
      series: rows.map((row) => ({ date: row.metric_date, spend: num(row.spend), conversations: num(row.conversations) })),
    };
  });
  return { ...base, available: true, media_status: !config ? 'not_configured' : metadata.unavailable ? 'partial' : 'ready',
    attribution_enabled: enabled,
    last_collected: insights.map((row) => row.collected_at).sort().at(-1) ?? null, creatives };
}
