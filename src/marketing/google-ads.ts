import { GoogleAdsError, googleAdsReader, type GoogleAdsConfig } from './google-ads-client.js';
import type { MarketingPeriod } from '../admin/painel/marketing-meta.js';

interface CustomerRow {
  customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string;
    manager?: boolean; testAccount?: boolean };
}
interface MetricRow {
  campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string };
  segments?: { date?: string };
  metrics?: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number | string; conversionsValue?: number | string };
}
export interface GoogleCampaign {
  id: string; name: string; status: string; channel_type: string;
  investment: number; impressions: number; clicks: number; conversions: number;
  ctr: number | null; cpc: number | null; delivery_days: number; last_delivery: string | null;
}
export interface GoogleAdsSnapshot {
  account: { id: string; name: string; currency: 'BRL'; time_zone: string; scope: GoogleAdsConfig['scope'] };
  period: { since: string; until: string };
  fetched_at: string;
  campaigns: GoogleCampaign[];
  totals: { investment: number; impressions: number; clicks: number; conversions: number;
    ctr: number | null; cpc: number | null };
  daily: Array<{ date: string; investment: number; clicks: number; impressions: number }>;
  campaign_daily?: Array<{ campaign_id: string; date: string; cost_micros: string; impressions: number; clicks: number; conversions: number }>;
  ads?: import('./google-ads-details.js').GoogleAd[];
}

function integer(value: unknown): number {
  const text = String(value ?? '0');
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new GoogleAdsError('invalid_metric');
  return Number(text);
}
function micros(value: unknown): bigint {
  const text = String(value ?? '0');
  if (!/^\d{1,18}$/.test(text)) throw new GoogleAdsError('invalid_metric');
  return BigInt(text);
}
function money(value: bigint): number {
  const cents = (value + 5_000n) / 10_000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new GoogleAdsError('invalid_metric');
  return Number(cents) / 100;
}
function ratio(n: number, d: number, factor = 1): number | null {
  return d ? Math.round(n / d * factor * 100) / 100 : null;
}
function dateWindow(period: MarketingPeriod, now: Date, timeZone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now); }
  catch { throw new GoogleAdsError('invalid_account'); }
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  const until = `${get('year')}-${get('month')}-${get('day')}`;
  const start = new Date(`${until}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (period === '7d' ? 6 : 29));
  return { since: start.toISOString().slice(0, 10), until };
}

/** Relatório observado da conta aprovada. Conversões do Google não são vendas do Farejador. */
export async function fetchGoogleAds(config: GoogleAdsConfig, period: MarketingPeriod,
  options: { fetcher?: typeof fetch; now?: Date; includeDetails?: boolean } = {}): Promise<GoogleAdsSnapshot> {
  const search = await googleAdsReader(config, options.fetcher);
  const accounts = await search<CustomerRow>(
    'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account FROM customer LIMIT 1');
  const account = accounts[0]?.customer;
  if (accounts.length !== 1 || account?.id !== config.customerId || !account.timeZone) throw new GoogleAdsError('invalid_account');
  if (account.manager) throw new GoogleAdsError('manager_account');
  if (Boolean(account.testAccount) !== (config.environment === 'test')) throw new GoogleAdsError('environment_mismatch');
  if (account.currencyCode !== 'BRL') throw new GoogleAdsError('unsupported_currency');
  const window = dateWindow(period, options.now ?? new Date(), account.timeZone);
  const filter = config.scope === 'campaigns' ? ` AND campaign.id IN (${config.campaignIds.join(',')})` : '';
  const rows = await search<MetricRow>(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
    segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
    FROM campaign WHERE segments.date BETWEEN '${window.since}' AND '${window.until}'${filter}
    ORDER BY campaign.id, segments.date`);
  const campaigns = new Map<string, GoogleCampaign & { micros: bigint }>();
  const daily = new Map<string, { date: string; micros: bigint; clicks: number; impressions: number }>();
  const seen = new Set<string>();
  const campaignDaily: NonNullable<GoogleAdsSnapshot['campaign_daily']> = [];
  let totalMicros = 0n;
  for (const row of rows) {
    const id = row.campaign?.id, date = row.segments?.date;
    if (!id || !/^\d+$/.test(id) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || date < window.since || date > window.until || seen.has(`${id}:${date}`)
      || (config.scope === 'campaigns' && !config.campaignIds.includes(id))) throw new GoogleAdsError('invalid_response');
    seen.add(`${id}:${date}`);
    const cost = micros(row.metrics?.costMicros), impressions = integer(row.metrics?.impressions), clicks = integer(row.metrics?.clicks);
    const conversions = Number(row.metrics?.conversions ?? 0);
    if (!Number.isFinite(conversions) || conversions < 0) throw new GoogleAdsError('invalid_metric');
    campaignDaily.push({ campaign_id: id, date, cost_micros: cost.toString(), impressions, clicks, conversions });
    const campaign = campaigns.get(id) ?? { id, name: row.campaign?.name || `Campanha ${id}`,
      status: row.campaign?.status || 'UNKNOWN', channel_type: row.campaign?.advertisingChannelType || 'UNKNOWN',
      investment: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null,
      delivery_days: 0, last_delivery: null, micros: 0n };
    campaign.micros += cost; campaign.impressions += impressions; campaign.clicks += clicks; campaign.conversions += conversions;
    if (cost > 0 || impressions > 0 || clicks > 0) {
      campaign.delivery_days++; campaign.last_delivery = date;
    }
    campaigns.set(id, campaign);
    const day = daily.get(date) ?? { date, micros: 0n, clicks: 0, impressions: 0 };
    day.micros += cost; day.clicks += clicks; day.impressions += impressions;
    daily.set(date, day); totalMicros += cost;
  }
  if (options.includeDetails) {
    const inventory = await search<MetricRow>(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
      FROM campaign WHERE campaign.status IN ('ENABLED','PAUSED','REMOVED')${filter}`);
    for (const row of inventory) {
      const id = row.campaign?.id;
      if (!id || !/^\d+$/.test(id) || (config.scope === 'campaigns' && !config.campaignIds.includes(id))) throw new GoogleAdsError('invalid_response');
      if (!campaigns.has(id)) campaigns.set(id, { id, name: row.campaign?.name || `Campanha ${id}`,
        status: row.campaign?.status || 'UNKNOWN', channel_type: row.campaign?.advertisingChannelType || 'UNKNOWN',
        investment: 0, impressions: 0, clicks: 0, conversions: 0, ctr: null, cpc: null,
        delivery_days: 0, last_delivery: null, micros: 0n });
    }
  }
  const campaignRows = [...campaigns.values()].map(({ micros: cost, ...row }) => ({
    ...row, investment: money(cost), cpc: ratio(Number(cost) / 1e6, row.clicks), ctr: ratio(row.clicks, row.impressions, 100),
  })).sort((a, b) => b.investment - a.investment);
  const sum = (key: 'impressions' | 'clicks' | 'conversions') => campaignRows.reduce((n, row) => n + row[key], 0);
  return {
    account: { id: account.id, name: account.descriptiveName || `Conta ${account.id}`, currency: 'BRL', time_zone: account.timeZone, scope: config.scope },
    period: window, fetched_at: (options.now ?? new Date()).toISOString(), campaigns: campaignRows,
    totals: { investment: money(totalMicros), impressions: sum('impressions'), clicks: sum('clicks'), conversions: sum('conversions'),
      ctr: ratio(sum('clicks'), sum('impressions'), 100), cpc: ratio(Number(totalMicros) / 1e6, sum('clicks')) },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map(({ micros: cost, ...row }) => ({ ...row, investment: money(cost) })),
    ...(options.includeDetails ? { campaign_daily: campaignDaily,
      ads: await (await import('./google-ads-details.js')).loadGoogleAdDetails(search, config, window) } : {}),
  };
}
