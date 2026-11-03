/** Metadados de apresentação das revisões. Só GET na Meta; nunca classifica ou lança valores. */
import { env } from '../shared/config/env.js';
import type { MetaMarketingConfig } from '../admin/painel/marketing-meta.js';
import { getMetaCreatives, safeMetaImageUrl, type MetaCreative } from './meta-creatives.js';

interface ReviewRow {
  ad_account_id: string; ad_id: string; campaign_id: string;
  ad_name?: string | null; campaign_name?: string | null;
}
const label = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 1000) : null;
const name = (value: unknown, id: string) => { const result = label(value); return result === id ? null : result; };
function configured(): MetaMarketingConfig | null {
  return env.MARKETING_META_ENABLED && env.META_ADS_ACCOUNT_ID && env.META_ADS_ACCESS_TOKEN
    ? { adAccountId: env.META_ADS_ACCOUNT_ID, accessToken: env.META_ADS_ACCESS_TOKEN, apiVersion: env.META_GRAPH_API_VERSION } : null;
}

export async function enrichMetaReviewRows<T extends ReviewRow>(rows: T[], options: {
  config?: MetaMarketingConfig | null; provider?: typeof getMetaCreatives;
} = {}) {
  const config = options.config === undefined ? configured() : options.config;
  const wanted = config ? [...new Set(rows.filter(row => row.ad_account_id === config.adAccountId).map(row => row.ad_id))] : [];
  let creatives: MetaCreative[] = [];
  if (config && wanted.length) {
    try { creatives = (await (options.provider ?? getMetaCreatives)(config, wanted)).ads; }
    catch { /* Falha de metadados não oculta a lista nem repassa detalhes do provedor. */ }
  }
  const found = new Map(creatives.map(ad => [ad.id, ad]));
  return rows.map(row => {
    const adName = name(row.ad_name, row.ad_id), campaignName = name(row.campaign_name, row.campaign_id);
    const fallback = { ...row, ad_name: adName, campaign_name: campaignName,
      metadata_status: adName || campaignName ? 'history' : 'unavailable', preview: null as {
        title: string | null; body: string | null; image_url: string | null; format: MetaCreative['format'];
      } | null };
    const creative = config && row.ad_account_id === config.adAccountId ? found.get(row.ad_id) : undefined;
    if (!creative) return fallback;
    // Não mostrar o conteúdo de um vínculo diferente do snapshot que será revisado.
    if (creative.campaign_id !== row.campaign_id) return { ...fallback, metadata_status: 'changed' };
    return { ...fallback, ad_name: name(creative.name, row.ad_id) ?? adName, campaign_name: name(creative.campaign_name, row.campaign_id) ?? campaignName,
      metadata_status: 'available', preview: { title: label(creative.title), body: label(creative.body),
        image_url: safeMetaImageUrl(creative.image_url), format: creative.format } };
  });
}
