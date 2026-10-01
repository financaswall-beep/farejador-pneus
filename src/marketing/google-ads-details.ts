import { GoogleAdsError, type GoogleAdsConfig } from './google-ads-client.js';

export interface GoogleAd {
  id: string; ad_id: string; ad_group_id: string; campaign_id: string;
  name: string; campaign_name: string; status: string; format: string;
  headlines: string[]; descriptions: string[]; final_url: string | null;
  investment: number; impressions: number; clicks: number; conversions: number;
  conversion_value: number; ctr: number | null; cpc: number | null; cpm: number | null;
  daily: Array<{ date: string; cost_micros: string; investment: number; impressions: number; clicks: number; conversions: number }>;
}
interface Row {
  campaign?: { id?: string; name?: string };
  adGroup?: { id?: string };
  adGroupAd?: { status?: string; ad?: { id?: string; name?: string; type?: string; finalUrls?: string[];
    responsiveSearchAd?: { headlines?: Array<{ text?: string }>; descriptions?: Array<{ text?: string }> } } };
  segments?: { date?: string };
  metrics?: { costMicros?: string; impressions?: string; clicks?: string; conversions?: string | number; conversionsValue?: string | number };
}
const fields = `campaign.id, campaign.name, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.name,
  ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.ad.final_urls,
  ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions`;
const ratio = (a: number, b: number, scale = 1) => b ? Math.round(a / b * scale * 100) / 100 : null;
function positive(value: unknown, whole = false): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0 || (whole && !Number.isSafeInteger(n))) throw new GoogleAdsError('invalid_metric');
  return n;
}
function cents(cost: bigint): number {
  const n = (cost + 5_000n) / 10_000n;
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new GoogleAdsError('invalid_metric');
  return Number(n) / 100;
}
function safeUrl(value?: string): string | null {
  try { const u = new URL(value ?? ''); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}

/** A identidade é (grupo, anúncio). Performance Max pode não ter ad_group_ad. */
export async function loadGoogleAdDetails(search: <T>(query: string) => Promise<T[]>, config: GoogleAdsConfig,
  window: { since: string; until: string }): Promise<GoogleAd[]> {
  const filter = config.scope === 'campaigns' ? ` AND campaign.id IN (${config.campaignIds.join(',')})` : '';
  const inventory = await search<Row>(`SELECT ${fields} FROM ad_group_ad
    WHERE ad_group_ad.status IN ('ENABLED','PAUSED','REMOVED')${filter}`);
  const rows = await search<Row>(`SELECT ${fields}, segments.date, metrics.cost_micros,
    metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
    FROM ad_group_ad WHERE segments.date BETWEEN '${window.since}' AND '${window.until}'
    AND ad_group_ad.status IN ('ENABLED','PAUSED','REMOVED')${filter}
    ORDER BY ad_group.id, ad_group_ad.ad.id, segments.date`);
  const ads = new Map<string, GoogleAd & { micros: bigint }>();
  const seen = new Set<string>();
  for (const row of [...inventory, ...rows]) {
    const campaign = row.campaign?.id, group = row.adGroup?.id, ad = row.adGroupAd?.ad;
    if (!campaign || !group || !ad?.id || ![campaign, group, ad.id].every(x => /^\d+$/.test(x))
      || (config.scope === 'campaigns' && !config.campaignIds.includes(campaign))) throw new GoogleAdsError('invalid_response');
    const id = `${group}:${ad.id}`;
    let item = ads.get(id);
    if (item && item.campaign_id !== campaign) throw new GoogleAdsError('invalid_response');
    if (!item) {
      const headlines = (ad.responsiveSearchAd?.headlines ?? []).map(x => (x.text ?? '').slice(0, 300));
      item = { id, ad_id: ad.id, ad_group_id: group, campaign_id: campaign, campaign_name: row.campaign?.name ?? campaign,
        name: ad.name || headlines.join(' · ') || `Anúncio ${ad.id}`, status: row.adGroupAd?.status ?? 'UNKNOWN',
        format: ad.type ?? 'UNKNOWN', headlines,
        descriptions: (ad.responsiveSearchAd?.descriptions ?? []).map(x => (x.text ?? '').slice(0, 1000)),
        final_url: safeUrl(ad.finalUrls?.[0]), investment: 0, impressions: 0, clicks: 0, conversions: 0,
        conversion_value: 0, ctr: null, cpc: null, cpm: null, daily: [], micros: 0n };
      ads.set(id, item);
    }
    if (!row.segments?.date) continue;
    const date = row.segments.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < window.since || date > window.until || seen.has(`${id}:${date}`)) {
      throw new GoogleAdsError('invalid_response');
    }
    seen.add(`${id}:${date}`);
    const costText = String(row.metrics?.costMicros ?? '0');
    if (!/^\d{1,18}$/.test(costText)) throw new GoogleAdsError('invalid_metric');
    const cost = BigInt(costText), impressions = positive(row.metrics?.impressions, true), clicks = positive(row.metrics?.clicks, true);
    const conversions = positive(row.metrics?.conversions);
    item.micros += cost; item.impressions += impressions; item.clicks += clicks; item.conversions += conversions;
    item.conversion_value += positive(row.metrics?.conversionsValue);
    item.daily.push({ date, cost_micros: costText, investment: cents(cost), impressions, clicks, conversions });
  }
  return [...ads.values()].map(({ micros, ...ad }) => ({ ...ad, investment: cents(micros),
    conversion_value: Math.round(ad.conversion_value * 100) / 100,
    ctr: ratio(ad.clicks, ad.impressions, 100), cpc: ratio(Number(micros) / 1e6, ad.clicks),
    cpm: ratio(Number(micros) / 1e6, ad.impressions, 1000),
  })).sort((a, b) => b.investment - a.investment);
}
