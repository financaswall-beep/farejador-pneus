/**
 * Marketing Meta — leitura SÓ de insights agregados.
 * Token vive exclusivamente em variável de ambiente e nunca sai deste módulo.
 * Sem escrita/CAPI; falha externa não pode derrubar o painel.
 */

import { summarizeMetaRows } from './marketing-meta-summary.js';
export {
  canonicalConversationAction,
  summarizeMetaRows,
} from './marketing-meta-summary.js';

export type MarketingPeriod = '7d' | '30d';
export type MetaCampaignScope = 'pending' | 'matrix' | 'external';

export interface MetaMarketingConfig {
  accessToken: string;
  adAccountId: string;
  apiVersion: string;
}

export interface MetaDailyMetric {
  date: string;
  spend: number;
  conversations: number;
  impressions: number;
  clicks: number;
}

export interface MetaCampaignMetric {
  id: string;
  ad_account_id?: string | null;
  name: string;
  scope?: MetaCampaignScope;
  spend: number;
  financial_spend?: number;
  conversations: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cost_per_conversation: number | null;
  delivery_days: number;
  last_delivery: string;
}

export interface MetaPeriodSummary {
  spend: number;
  conversations: number;
  campaigns: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cost_per_conversation: number | null;
  daily: MetaDailyMetric[];
  campaign_rows: MetaCampaignMetric[];
}

export interface MetaMarketingSnapshot {
  current: MetaPeriodSummary;
  previous: MetaPeriodSummary;
  fetched_at: string;
}

export type MetaInsightLevel = 'campaign' | 'ad';

export interface MetaInsightRow {
  ad_account_id?: unknown;
  account_currency?: unknown;
  campaign_id?: unknown;
  campaign_name?: unknown;
  adset_id?: unknown;
  adset_name?: unknown;
  ad_id?: unknown;
  ad_name?: unknown;
  date_start?: unknown;
  spend?: unknown;
  financial_spend?: unknown;
  campaign_scope?: unknown;
  summary_included?: unknown;
  impressions?: unknown;
  clicks?: unknown;
  reach?: unknown;
  actions?: unknown;
}

interface MetaPage {
  data?: unknown;
  paging?: { next?: unknown };
  error?: unknown;
}

interface CacheEntry {
  expiresAt: number;
  value: MetaMarketingSnapshot;
}

const cache = new Map<string, CacheEntry>();

function shiftIsoDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

function saoPauloDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function marketingDateWindow(period: MarketingPeriod, now = new Date()) {
  const days = period === '7d' ? 7 : 30;
  const until = saoPauloDate(now);
  const since = shiftIsoDate(until, -(days - 1));
  const previousUntil = shiftIsoDate(since, -1);
  const previousSince = shiftIsoDate(previousUntil, -(days - 1));
  return { days, since, until, previousSince, previousUntil };
}

function validateNextPage(next: unknown): URL | null {
  if (typeof next !== 'string' || next.length === 0) return null;
  const parsed = new URL(next);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'graph.facebook.com') {
    throw new Error('meta_invalid_pagination_origin');
  }
  // A Meta pode repetir o token em paging.next. O servidor já autentica por
  // header; removê-lo da URL reduz exposição acidental em logs e traces.
  parsed.searchParams.delete('access_token');
  return parsed;
}

export async function fetchMetaInsightRows(
  config: MetaMarketingConfig,
  since: string,
  until: string,
  level: MetaInsightLevel,
  fetcher: typeof fetch,
): Promise<MetaInsightRow[]> {
  const first = new URL(
    `https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/${encodeURIComponent(config.adAccountId)}/insights`,
  );
  first.search = new URLSearchParams({
    fields: [
      'account_currency',
      'campaign_id',
      'campaign_name',
      ...(level === 'ad' ? ['adset_id', 'adset_name', 'ad_id', 'ad_name'] : []),
      'spend',
      'impressions',
      'clicks',
      'reach',
      'actions',
    ].join(','),
    time_range: JSON.stringify({ since, until }),
    time_increment: '1',
    level,
    limit: '200',
  }).toString();

  const rows: MetaInsightRow[] = [];
  let next: URL | null = first;
  let pages = 0;
  while (next && pages < 20) {
    pages += 1;
    const response = await fetcher(next, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.accessToken}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({})) as MetaPage;
    if (!response.ok || body.error) throw new Error(`meta_api_${response.status}`);
    if (Array.isArray(body.data)) rows.push(...body.data as MetaInsightRow[]);
    next = validateNextPage(body.paging?.next);
  }
  if (next) throw new Error('meta_pagination_limit');
  return rows;
}

export async function getMetaMarketingSnapshot(
  config: MetaMarketingConfig,
  period: MarketingPeriod,
  options: { now?: Date; fetcher?: typeof fetch; cacheMs?: number } = {},
): Promise<MetaMarketingSnapshot> {
  const now = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  const cacheMs = options.cacheMs ?? 5 * 60_000;
  const window = marketingDateWindow(period, now);
  const key = `${config.apiVersion}:${config.adAccountId}:${period}:${window.until}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now.getTime()) return cached.value;

  const rows = await fetchMetaInsightRows(
    config,
    window.previousSince,
    window.until,
    'campaign',
    fetcher,
  );
  const value: MetaMarketingSnapshot = {
    current: summarizeMetaRows(rows, window.since, window.until),
    previous: summarizeMetaRows(rows, window.previousSince, window.previousUntil),
    fetched_at: now.toISOString(),
  };
  cache.set(key, { expiresAt: now.getTime() + cacheMs, value });
  return value;
}

export function clearMetaMarketingCache(): void {
  cache.clear();
}
