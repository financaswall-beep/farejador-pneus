import { canonicalConversationAction, type MetaInsightRow, type MetaInsightLevel } from '../admin/painel/marketing-meta.js';

export function insightValues(row: MetaInsightRow, level: MetaInsightLevel) {
  const entityId = String(level === 'ad' ? row.ad_id ?? '' : row.campaign_id ?? '');
  const campaignId = String(row.campaign_id ?? '');
  if (!entityId || !campaignId || !row.date_start) return null;
  const canonical = canonicalConversationAction(row.actions);
  return {
    entityId,
    campaignId,
    entityName: String(level === 'ad' ? row.ad_name ?? entityId : row.campaign_name ?? entityId),
    campaignName: String(row.campaign_name ?? campaignId),
    adsetId: row.adset_id ? String(row.adset_id) : null,
    adsetName: row.adset_name ? String(row.adset_name) : null,
    metricDate: String(row.date_start),
    currency: String(row.account_currency ?? 'BRL'),
    spend: Number(row.spend ?? 0),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    reach: row.reach == null ? null : Number(row.reach),
    conversations: Math.round(canonical.value),
    actionType: canonical.actionType,
    actions: Array.isArray(row.actions) ? row.actions : [],
  };
}
