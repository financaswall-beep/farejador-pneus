/**
 * Marketing Meta — leitura SÓ de insights agregados.
 * Token vive exclusivamente em variável de ambiente e nunca sai deste módulo.
 * Sem escrita/CAPI; falha externa não pode derrubar o painel.
 */

const LEAD_ACTION_TYPES = new Set([
  'lead',
  'onsite_conversion.lead_grouped',
  'onsite_conversion.messaging_conversation_started_7d',
]);

export type MarketingPeriod = '7d' | '30d';

export interface MetaMarketingConfig {
  accessToken: string;
  adAccountId: string;
  apiVersion: string;
}

export interface MetaDailyMetric {
  date: string;
  spend: number;
  conversations: number;
}

export interface MetaCampaignMetric {
  id: string;
  name: string;
  spend: number;
  conversations: number;
  cost_per_conversation: number | null;
  delivery_days: number;
  last_delivery: string;
}

export interface MetaPeriodSummary {
  spend: number;
  conversations: number;
  campaigns: number;
  cost_per_conversation: number | null;
  daily: MetaDailyMetric[];
  campaign_rows: MetaCampaignMetric[];
}

export interface MetaMarketingSnapshot {
  current: MetaPeriodSummary;
  previous: MetaPeriodSummary;
  fetched_at: string;
}

interface MetaInsightRow {
  campaign_id?: unknown;
  campaign_name?: unknown;
  date_start?: unknown;
  spend?: unknown;
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

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

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

function leadCount(actions: unknown): number {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((total, action) => {
    if (!action || typeof action !== 'object') return total;
    const row = action as Record<string, unknown>;
    return LEAD_ACTION_TYPES.has(String(row.action_type ?? ''))
      ? total + numberValue(row.value)
      : total;
  }, 0);
}

function summarize(rows: MetaInsightRow[], since: string, until: string): MetaPeriodSummary {
  const campaigns = new Set<string>();
  const byDate = new Map<string, MetaDailyMetric>();
  const byCampaign = new Map<string, {
    id: string;
    name: string;
    spend: number;
    conversations: number;
    deliveryDates: Set<string>;
  }>();
  let spend = 0;
  let conversations = 0;

  for (const row of rows) {
    const date = String(row.date_start ?? '');
    if (date < since || date > until) continue;
    const rowSpend = numberValue(row.spend);
    const rowConversations = leadCount(row.actions);
    spend += rowSpend;
    conversations += rowConversations;
    if (row.campaign_id) {
      const id = String(row.campaign_id);
      campaigns.add(id);
      const current = byCampaign.get(id) ?? {
        id,
        name: String(row.campaign_name || id),
        spend: 0,
        conversations: 0,
        deliveryDates: new Set<string>(),
      };
      current.spend += rowSpend;
      current.conversations += rowConversations;
      if (date) current.deliveryDates.add(date);
      byCampaign.set(id, current);
    }
    const daily = byDate.get(date) ?? { date, spend: 0, conversations: 0 };
    daily.spend += rowSpend;
    daily.conversations += rowConversations;
    byDate.set(date, daily);
  }

  const roundedSpend = Math.round(spend * 100) / 100;
  return {
    spend: roundedSpend,
    conversations: Math.round(conversations),
    campaigns: campaigns.size,
    cost_per_conversation: conversations > 0
      ? Math.round((roundedSpend / conversations) * 100) / 100
      : null,
    daily: [...byDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((row) => ({ ...row, spend: Math.round(row.spend * 100) / 100 })),
    campaign_rows: [...byCampaign.values()]
      .map((row) => {
        const rounded = Math.round(row.spend * 100) / 100;
        const dates = [...row.deliveryDates].sort();
        return {
          id: row.id,
          name: row.name,
          spend: rounded,
          conversations: Math.round(row.conversations),
          cost_per_conversation: row.conversations > 0
            ? Math.round((rounded / row.conversations) * 100) / 100
            : null,
          delivery_days: dates.length,
          last_delivery: dates.at(-1) ?? until,
        };
      })
      .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name)),
  };
}

function validateNextPage(next: unknown): URL | null {
  if (typeof next !== 'string' || next.length === 0) return null;
  const parsed = new URL(next);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'graph.facebook.com') {
    throw new Error('meta_invalid_pagination_origin');
  }
  return parsed;
}

async function fetchInsightRows(
  config: MetaMarketingConfig,
  since: string,
  until: string,
  fetcher: typeof fetch,
): Promise<MetaInsightRow[]> {
  const first = new URL(
    `https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/${encodeURIComponent(config.adAccountId)}/insights`,
  );
  first.search = new URLSearchParams({
    access_token: config.accessToken,
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,frequency,reach,cpm,actions,cost_per_action_type',
    time_range: JSON.stringify({ since, until }),
    time_increment: '1',
    level: 'campaign',
    limit: '200',
  }).toString();

  const rows: MetaInsightRow[] = [];
  let next: URL | null = first;
  let pages = 0;
  while (next && pages < 20) {
    pages += 1;
    const response = await fetcher(next, {
      headers: { Accept: 'application/json' },
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

  const rows = await fetchInsightRows(config, window.previousSince, window.until, fetcher);
  const value: MetaMarketingSnapshot = {
    current: summarize(rows, window.since, window.until),
    previous: summarize(rows, window.previousSince, window.previousUntil),
    fetched_at: now.toISOString(),
  };
  cache.set(key, { expiresAt: now.getTime() + cacheMs, value });
  return value;
}

export function clearMetaMarketingCache(): void {
  cache.clear();
}
