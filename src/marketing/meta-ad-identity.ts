import type { PoolClient } from 'pg';
import { META_BUSINESS_ACCOUNTS } from '../shared/meta-business-accounts.js';
import { fetchMetaInsightRows, type MetaInsightRow, type MetaMarketingConfig } from '../admin/painel/marketing-meta.js';

type Scope = 'matrix' | 'external' | 'pending';
export interface MetaAdIdentity {
  id: string; campaignId: string; pageId: string | null; instagramId: string | null; scope: Scope;
}
type MetaAd = { id?: string; campaign_id?: string; creative?: {
  actor_id?: string; instagram_user_id?: string; effective_object_story_id?: string;
  object_story_spec?: { page_id?: string; instagram_user_id?: string };
} };

export function classifyMetaAd(ad: MetaAd): MetaAdIdentity {
  const creative = ad.creative;
  const pages = [...new Set([creative?.actor_id, creative?.object_story_spec?.page_id,
    creative?.effective_object_story_id?.split('_')[0]].filter(Boolean))];
  const instagram = [...new Set([creative?.instagram_user_id,
    creative?.object_story_spec?.instagram_user_id].filter(Boolean))];
  const ownPage = pages.includes(META_BUSINESS_ACCOUNTS.facebook.id);
  const ownInstagram = instagram.includes(META_BUSINESS_ACCOUNTS.instagram.id);
  const foreign = pages.some(id => id !== META_BUSINESS_ACCOUNTS.facebook.id)
    || instagram.some(id => id !== META_BUSINESS_ACCOUNTS.instagram.id);
  const known = ownPage || ownInstagram;
  return {
    id: String(ad.id ?? ''), campaignId: String(ad.campaign_id ?? ''),
    pageId: pages[0] ?? null, instagramId: instagram[0] ?? null,
    scope: known ? foreign ? 'pending' : 'matrix' : foreign ? 'external' : 'pending',
  };
}

export async function fetchMetaAdIdentities(config: MetaMarketingConfig, fetcher: typeof fetch): Promise<MetaAdIdentity[]> {
  let next: URL | null = new URL(`https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/${encodeURIComponent(config.adAccountId)}/ads`);
  next.searchParams.set('fields', 'id,campaign_id,creative{actor_id,instagram_user_id,object_story_spec,effective_object_story_id}');
  next.searchParams.set('limit', '200');
  // Include paused/archived ads: their past spend still belongs in the period.
  next.searchParams.set('filtering', JSON.stringify([{ field: 'effective_status', operator: 'IN',
    value: ['ACTIVE','PAUSED','DELETED','ARCHIVED','CAMPAIGN_PAUSED','ADSET_PAUSED','DISAPPROVED','PENDING_REVIEW','PREAPPROVED','PENDING_BILLING_INFO','WITH_ISSUES'] }]));
  const found = new Map<string, MetaAdIdentity>();
  for (let page = 0; next && page < 100; page++) {
    if (next.protocol !== 'https:' || next.hostname !== 'graph.facebook.com') throw new Error('meta_identity_pagination_origin');
    next.searchParams.delete('access_token');
    const response = await fetcher(next, { headers: { Authorization: `Bearer ${config.accessToken}` }, signal: AbortSignal.timeout(20_000) });
    const body = await response.json() as { data?: MetaAd[]; error?: unknown; paging?: { next?: string } };
    if (!response.ok || body.error || !Array.isArray(body.data)) throw new Error(`meta_identity_api_${response.status}`);
    for (const ad of body.data) {
      const identity = classifyMetaAd(ad);
      if (!/^\d+$/.test(identity.id) || !/^\d+$/.test(identity.campaignId)) throw new Error('meta_identity_invalid');
      found.set(identity.id, identity);
    }
    next = body.paging?.next ? new URL(body.paging.next) : null;
  }
  if (next) throw new Error('meta_identity_pagination_limit');
  return [...found.values()];
}

export async function fetchOwnedMetaInsights(config: MetaMarketingConfig, identities: MetaAdIdentity[], since: string, until: string, fetcher: typeof fetch) {
  const owned = identities.filter(ad => ad.scope === 'matrix');
  const rows: MetaInsightRow[] = [];
  // Small batches bound concurrency and URL size; Meta filters before returning metrics.
  for (let start = 0; start < owned.length; start += 50) {
    const batch = owned.slice(start, start + 50);
    const allowed = new Map(batch.map(ad => [ad.id, ad.campaignId]));
    const fetched = await fetchMetaInsightRows(config, since, until, 'ad', fetcher, batch.map(ad => ad.id));
    for (const row of fetched) {
      if (allowed.get(String(row.ad_id)) !== String(row.campaign_id)) throw new Error('meta_insight_identity_mismatch');
      rows.push(row);
    }
  }
  return rows;
}

export async function persistMetaAdIdentities(client: PoolClient, environment: string, account: string, runId: string, identities: MetaAdIdentity[]) {
  await client.query(`INSERT INTO marketing.meta_identity_accounts(environment,ad_account_id,sync_run_id)
    VALUES ($1,$2,$3) ON CONFLICT (environment,ad_account_id) DO UPDATE
    SET sync_run_id=EXCLUDED.sync_run_id,verified_at=now()`, [environment, account, runId]);
  // An ad omitted by the API is unresolved, never silently kept as approved.
  await client.query(`UPDATE marketing.meta_ad_identities SET scope='pending'
    WHERE environment=$1 AND ad_account_id=$2`, [environment, account]);
  for (const ad of identities) {
    await client.query(`INSERT INTO marketing.meta_ad_identities
      (environment,ad_account_id,ad_id,campaign_id,facebook_page_id,instagram_user_id,scope)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (environment,ad_account_id,ad_id) DO UPDATE
      SET campaign_id=EXCLUDED.campaign_id,facebook_page_id=EXCLUDED.facebook_page_id,
        instagram_user_id=EXCLUDED.instagram_user_id,scope=EXCLUDED.scope,verified_at=now()`,
    [environment, account, ad.id, ad.campaignId, ad.pageId, ad.instagramId, ad.scope]);
  }
}

// Campaign rows provide stable ledger IDs. Their read view always re-sums owned ads.
export function campaignAnchors(ads: MetaInsightRow[]): MetaInsightRow[] {
  const groups = new Map<string, { row: MetaInsightRow; actions: Map<string, number> }>();
  for (const ad of ads) {
    const key = `${ad.campaign_id}:${ad.date_start}`;
    let group = groups.get(key);
    if (!group) {
      group = { row: { ...ad, ad_id: undefined, ad_name: undefined, reach: undefined,
        spend: 0, impressions: 0, clicks: 0 }, actions: new Map() };
      groups.set(key, group);
    }
    for (const field of ['spend','impressions','clicks'] as const) {
      group.row[field] = Number(group.row[field]) + Number(ad[field] ?? 0);
    }
    for (const action of Array.isArray(ad.actions) ? ad.actions : []) {
      const type = String(action.action_type ?? '');
      const value = Number(action.value ?? 0);
      if (type && Number.isFinite(value)) group.actions.set(type, (group.actions.get(type) ?? 0) + value);
    }
  }
  return [...groups.values()].map(({ row, actions }) => ({ ...row,
    spend: Math.round(Number(row.spend) * 100) / 100,
    actions: [...actions].map(([action_type, value]) => ({ action_type, value })),
  }));
}
