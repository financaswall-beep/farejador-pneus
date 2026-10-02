import type { Pool, PoolClient } from 'pg';
import type { MetaMarketingConfig } from '../admin/painel/marketing-meta.js';
import { META_BUSINESS_ACCOUNTS } from '../shared/meta-business-accounts.js';
import type { MetaAdIdentity } from './meta-ad-identity.js';

interface SpendRow { adId: string; campaignId: string; date: string; spend: string }
interface Check {
  ads: MetaAdIdentity[]; since: string; until: string;
  rows: SpendRow[]; error: string | null;
}
export interface PendingSpendSnapshot { financeSince: string; checks: Check[] }
const shift = (date: string, days: number) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000)
  .toISOString().slice(0, 10);

export function pendingAdBelongsToReview(ad: MetaAdIdentity): boolean {
  return ad.scope === 'pending' && Boolean(ad.fingerprint)
    && (ad.hasMatrixIdentity || ad.pageId === META_BUSINESS_ACCOUNTS.facebook.id
      || ad.instagramId === META_BUSINESS_ACCOUNTS.instagram.id);
}

export async function metaFinanceSince(db: Pick<Pool, 'query'>, environment: string,
  account: string, today: string): Promise<string> {
  const result = await db.query<{ since: string }>(`SELECT COALESCE(
    (SELECT NULLIF(finance_since,'-infinity'::date) FROM marketing.meta_identity_accounts WHERE environment=$1 AND ad_account_id=$2),
    LEAST((SELECT min(competence_on) FROM finance.matriz_ledger_transactions WHERE environment=$1),
      (SELECT min(metric_date) FROM marketing.meta_insights_daily WHERE environment=$1 AND ad_account_id=$2),
      $3::date))::text since`, [environment, account, today]);
  return result.rows[0]!.since;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function fetchPendingSpend(config: MetaMarketingConfig, ads: MetaAdIdentity[],
  since: string, until: string, fetcher: typeof fetch): Promise<SpendRow[]> {
  const allowed = new Map(ads.map(ad => [ad.id, ad.campaignId]));
  const rows: SpendRow[] = [], seen = new Set<string>();
  let next: URL | null = new URL(`https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/${encodeURIComponent(config.adAccountId)}/insights`);
  next.search = new URLSearchParams({ fields: 'ad_id,campaign_id,date_start,spend,account_currency',
    level: 'ad', time_range: JSON.stringify({ since, until }), time_increment: '1', limit: '200',
    filtering: JSON.stringify([{ field: 'ad.id', operator: 'IN', value: ads.map(ad => ad.id) }]),
  }).toString();
  for (let page = 0; next && page < 100; page++) {
    if (next.protocol !== 'https:' || next.hostname !== 'graph.facebook.com') throw new Error('meta_pending_pagination_origin');
    next.searchParams.delete('access_token');
    const response = await fetcher(next, { headers: { Authorization: `Bearer ${config.accessToken}` },
      signal: AbortSignal.timeout(20_000) });
    const body = await response.json() as { data?: Record<string, unknown>[]; error?: unknown; paging?: { next?: string } };
    if (!response.ok || body.error || !Array.isArray(body.data)) throw new Error(`meta_pending_api_${response.status}`);
    for (const row of body.data) {
      const adId = String(row.ad_id), campaignId = String(row.campaign_id);
      if (allowed.get(adId) !== campaignId) throw new Error('meta_pending_identity_mismatch');
      if (!validDate(row.date_start) || row.date_start < since || row.date_start > until
        || !/^\d{1,12}(\.\d{1,2})?$/.test(String(row.spend)) || row.account_currency !== 'BRL') {
        throw new Error('meta_pending_invalid_metric');
      }
      const key = `${adId}:${row.date_start}`;
      if (seen.has(key)) throw new Error('meta_pending_duplicate_metric');
      seen.add(key);
      rows.push({ adId, campaignId, date: row.date_start, spend: String(row.spend) });
    }
    next = body.paging?.next ? new URL(body.paging.next) : null;
  }
  if (next) throw new Error('meta_pending_pagination_limit');
  return rows;
}

export async function collectPendingSpend(db: Pick<Pool, 'query'>, environment: string,
  config: MetaMarketingConfig, identities: MetaAdIdentity[], normalSince: string,
  until: string, fetcher: typeof fetch): Promise<PendingSpendSnapshot> {
  const financeSince = await metaFinanceSince(db, environment, config.adAccountId, until);
  const candidates = identities.filter(pendingAdBelongsToReview);
  if (!candidates.length || financeSince > until) return { financeSince, checks: [] };
  const proof = await db.query<{ ad_id: string; since: string }>(`WITH wanted AS (
      SELECT ad_id,fingerprint FROM unnest($3::text[],$4::text[]) AS x(ad_id,fingerprint)
    ) SELECT w.ad_id,LEAST($5::date,COALESCE((SELECT min(lower(gap)) FROM unnest(
      datemultirange(daterange($6::date,$7::date,'[]')) - marketing.meta_pending_spend_coverage(
        $1,$2,w.ad_id,w.fingerprint)) gap),$5::date))::text since FROM wanted w`,
  [environment, config.adAccountId, candidates.map(ad => ad.id), candidates.map(ad => ad.fingerprint),
    normalSince > financeSince ? normalSince : financeSince, financeSince, until]);
  const starts = new Map(proof.rows.map(row => [row.ad_id, row.since]));
  const checks: Check[] = [];
  for (let offset = 0; offset < candidates.length; offset += 50) {
    const ads = candidates.slice(offset, offset + 50);
    let since = ads.map(ad => starts.get(ad.id) ?? financeSince).sort()[0]!;
    for (let chunk = 0; since <= until && chunk < 100; chunk++) {
      const end = shift(since, 89) < until ? shift(since, 89) : until;
      try { checks.push({ ads, since, until: end, rows: await fetchPendingSpend(config, ads, since, end, fetcher), error: null }); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        checks.push({ ads, since, until: end, rows: [],
          error: /^meta_pending_[a-z_]+(?:_\d+)?$/.test(message) ? message : 'meta_pending_unavailable' });
        break; // A failed range stays missing; retry the gap during the next sync.
      }
      since = shift(end, 1);
    }
  }
  return { financeSince, checks };
}

export async function ownedBackfillSince(db: Pick<Pool, 'query'>, environment: string,
  account: string, identities: MetaAdIdentity[], financeSince: string, normalSince: string): Promise<string> {
  const ids = identities.filter(ad => ad.scope === 'matrix').map(ad => ad.id);
  if (!ids.length) return normalSince;
  const result = await db.query<{ since: string | null }>(`SELECT min(since)::text since FROM (
    SELECT $4::date since WHERE EXISTS(SELECT 1 FROM unnest($3::text[]) w(ad_id)
      LEFT JOIN marketing.meta_ad_identities d ON d.environment=$1 AND d.ad_account_id=$2 AND d.ad_id=w.ad_id
      WHERE d.ad_id IS NULL OR d.metrics_backfill_pending)
    UNION ALL SELECT min(p.metric_date) since
    FROM marketing.meta_pending_spend_daily p WHERE p.environment=$1 AND p.ad_account_id=$2
      AND p.ad_id=ANY($3::text[]) AND p.spend>0 AND p.metric_date>=$4::date
      AND NOT EXISTS(SELECT 1 FROM marketing.meta_insights_daily i WHERE i.environment=p.environment
        AND i.ad_account_id=p.ad_account_id AND i.entity_level='ad' AND i.entity_id=p.ad_id
        AND i.metric_date=p.metric_date AND i.collected_at>=p.collected_at)) dates`, [environment, account, ids, financeSince]);
  return result.rows[0]?.since && result.rows[0].since < normalSince ? result.rows[0].since : normalSince;
}

export async function persistPendingSpend(client: PoolClient, environment: string,
  account: string, runId: string, snapshot: PendingSpendSnapshot): Promise<void> {
  for (const check of snapshot.checks) {
    if (!check.error) {
      // A fully verified empty result replaces stale pending amounts with zero.
      for (const ad of check.ads) await client.query(`UPDATE marketing.meta_pending_spend_daily
        SET spend=0,sync_run_id=$5,collected_at=now() WHERE environment=$1 AND ad_account_id=$2
          AND ad_id=$3 AND identity_fingerprint=$4 AND metric_date BETWEEN $6::date AND $7::date`,
      [environment, account, ad.id, ad.fingerprint, runId, check.since, check.until]);
      const fingerprints = new Map(check.ads.map(ad => [ad.id, ad.fingerprint]));
      for (const row of check.rows) await client.query(`INSERT INTO marketing.meta_pending_spend_daily
        (environment,ad_account_id,ad_id,campaign_id,identity_fingerprint,metric_date,spend,sync_run_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(environment,ad_account_id,ad_id,identity_fingerprint,metric_date)
        DO UPDATE SET spend=EXCLUDED.spend,sync_run_id=EXCLUDED.sync_run_id,collected_at=now()`,
      [environment, account, row.adId, row.campaignId, fingerprints.get(row.adId), row.date, row.spend, runId]);
    }
    for (const ad of check.ads) await client.query(`INSERT INTO marketing.meta_pending_spend_checks
      (environment,ad_account_id,ad_id,identity_fingerprint,sync_run_id,window_since,window_until,status,error_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [environment, account, ad.id, ad.fingerprint, runId, check.since, check.until,
      check.error ? 'failed' : 'succeeded', check.error]);
  }
}
