/** Detalhe de uma campanha Meta: entrega real, eficiência e financeiro protegido por CTWA. */
import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { pool as defaultPool } from '../../persistence/db.js';
import { marketingDateWindow, type MarketingPeriod } from './marketing-meta.js';
import {
  getMarketingAttributionReport,
  type MarketingAttributionReport,
} from '../../marketing/reporting.js';

interface DetailConfig {
  attributionEnabled: boolean;
}

interface InsightRow {
  entity_level: 'campaign' | 'ad';
  entity_id: string;
  entity_name: string | null;
  campaign_id: string;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  metric_date: string;
  account_currency: string;
  spend: unknown;
  impressions: unknown;
  clicks: unknown;
  conversations: unknown;
  actions_raw: unknown;
}

interface Aggregate {
  spend: number;
  impressions: number;
  clicks: number;
  conversations: number;
  firstReplies: number;
  linkClicks: number;
  videoViews: number;
  postEngagements: number;
}

export interface MarketingCampaignDetailDependencies {
  now?: Date;
  dbPool?: Pool;
  config?: DetailConfig;
  attributionProvider?: typeof getMarketingAttributionReport;
}

const ACTIONS = {
  firstReplies: new Set([
    'onsite_conversion.messaging_first_reply',
    'messaging_first_reply',
  ]),
  linkClicks: new Set(['link_click']),
  videoViews: new Set(['video_view']),
  postEngagements: new Set(['post_engagement']),
};

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function parseActions(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row === 'object') : [];
  } catch {
    return [];
  }
}

function actionTotal(actions: unknown, accepted: Set<string>): number {
  return parseActions(actions).reduce((total, action) => (
    accepted.has(String(action.action_type ?? ''))
      ? total + numberValue(action.value)
      : total
  ), 0);
}

function aggregate(rows: InsightRow[]): Aggregate {
  return rows.reduce<Aggregate>((total, row) => ({
    spend: total.spend + numberValue(row.spend),
    impressions: total.impressions + numberValue(row.impressions),
    clicks: total.clicks + numberValue(row.clicks),
    conversations: total.conversations + numberValue(row.conversations),
    firstReplies: total.firstReplies + actionTotal(row.actions_raw, ACTIONS.firstReplies),
    linkClicks: total.linkClicks + actionTotal(row.actions_raw, ACTIONS.linkClicks),
    videoViews: total.videoViews + actionTotal(row.actions_raw, ACTIONS.videoViews),
    postEngagements: total.postEngagements
      + actionTotal(row.actions_raw, ACTIONS.postEngagements),
  }), {
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversations: 0,
    firstReplies: 0,
    linkClicks: 0,
    videoViews: 0,
    postEngagements: 0,
  });
}

function derivedMetrics(values: Aggregate) {
  const unanswered = Math.max(0, Math.round(values.conversations - values.firstReplies));
  return {
    investment: round(values.spend),
    impressions: Math.round(values.impressions),
    clicks: Math.round(values.clicks),
    link_clicks: Math.round(values.linkClicks),
    video_views: Math.round(values.videoViews),
    post_engagements: Math.round(values.postEngagements),
    conversations_started: Math.round(values.conversations),
    first_replies: Math.round(values.firstReplies),
    unanswered,
    ctr: values.impressions > 0 ? round((values.clicks / values.impressions) * 100) : null,
    cpc: values.clicks > 0 ? round(values.spend / values.clicks) : null,
    cpm: values.impressions > 0 ? round((values.spend / values.impressions) * 1_000) : null,
    response_rate: values.conversations > 0
      ? round((values.firstReplies / values.conversations) * 100, 1)
      : null,
    cost_per_started: values.conversations > 0
      ? round(values.spend / values.conversations)
      : null,
    cost_per_replied: values.firstReplies > 0
      ? round(values.spend / values.firstReplies)
      : null,
    unanswered_investment: values.conversations > 0
      ? round(values.spend * (unanswered / values.conversations))
      : null,
  };
}

function decision(metrics: ReturnType<typeof derivedMetrics>) {
  if (metrics.conversations_started > 0 && metrics.first_replies === 0) {
    return {
      tone: 'critical' as const,
      title: 'Conversas chegaram, mas nenhuma primeira resposta foi registrada',
      detail: 'Revise imediatamente fila, escala e automações de atendimento.',
    };
  }
  if (metrics.response_rate != null && metrics.response_rate < 70) {
    return {
      tone: 'critical' as const,
      title: 'Atendimento abaixo de 70%',
      detail: 'Antes de ampliar a verba, verifique fila, escala e horário de atendimento.',
    };
  }
  if (metrics.response_rate != null && metrics.response_rate < 85) {
    return {
      tone: 'attention' as const,
      title: 'Há espaço para recuperar conversas sem resposta',
      detail: 'A campanha entrega demanda; a prioridade é elevar a resposta registrada.',
    };
  }
  return {
    tone: 'positive' as const,
    title: 'Resposta registrada em nível saudável',
    detail: 'Mantenha a operação monitorada antes de qualquer aumento de verba.',
  };
}

export async function getMarketingCampaignDetail(
  campaignId: string,
  period: MarketingPeriod = '30d',
  dependencies: MarketingCampaignDetailDependencies = {},
) {
  const now = dependencies.now ?? new Date();
  const dbPool = dependencies.dbPool ?? defaultPool;
  const window = marketingDateWindow(period, now);
  const config = dependencies.config ?? { attributionEnabled: env.MARKETING_ATTRIBUTION };
  const result = await dbPool.query<InsightRow>(
    `SELECT entity_level,entity_id,entity_name,campaign_id,campaign_name,
            adset_id,adset_name,metric_date::text,account_currency,
            spend,impressions,clicks,conversations,actions_raw
       FROM marketing.meta_insights_daily
      WHERE environment=$1 AND campaign_id=$2
        AND metric_date BETWEEN $3::date AND $4::date
      ORDER BY metric_date,entity_level,entity_id`,
    [env.FAREJADOR_ENV, campaignId, window.since, window.until],
  );
  const campaignRows = result.rows.filter((row) => row.entity_level === 'campaign');
  if (campaignRows.length === 0) return null;

  const summary = derivedMetrics(aggregate(campaignRows));
  const byDate = new Map<string, InsightRow[]>();
  for (const row of campaignRows) {
    const rows = byDate.get(row.metric_date) ?? [];
    rows.push(row);
    byDate.set(row.metric_date, rows);
  }
  const adGroups = new Map<string, InsightRow[]>();
  for (const row of result.rows.filter((item) => item.entity_level === 'ad')) {
    const rows = adGroups.get(row.entity_id) ?? [];
    rows.push(row);
    adGroups.set(row.entity_id, rows);
  }

  let attribution: MarketingAttributionReport | null = null;
  if (config.attributionEnabled) {
    attribution = await (dependencies.attributionProvider ?? getMarketingAttributionReport)(
      window.since,
      window.until,
      dbPool,
    );
  }
  const attributed = attribution?.campaigns.find((row) => row.campaign_id === campaignId);
  const attributionStatus = !config.attributionEnabled
    ? 'disabled' as const
    : !attribution?.available
      ? 'unavailable' as const
      : attributed
        ? 'ready' as const
        : 'pending' as const;
  const grossMargin = attributed?.gross_margin ?? null;
  const sales = attributed?.attributed_sales ?? null;
  const revenue = attributed?.attributed_revenue ?? null;

  const first = campaignRows[0]!;
  const deliveryDates = [...byDate.keys()].sort();
  return {
    environment: env.FAREJADOR_ENV,
    generated_at: now.toISOString(),
    period: { id: period, ...window },
    campaign: {
      id: campaignId,
      name: first.campaign_name || first.entity_name || campaignId,
      channel: 'meta' as const,
      status: 'with_delivery' as const,
      currency: first.account_currency,
      delivery_days: deliveryDates.length,
      last_delivery: deliveryDates.at(-1) ?? window.until,
    },
    summary,
    trend: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => ({
      date,
      ...derivedMetrics(aggregate(rows)),
    })),
    ads: [...adGroups.entries()].map(([id, rows]) => {
      const values = derivedMetrics(aggregate(rows));
      return {
        id,
        name: rows[0]?.entity_name || id,
        adset_id: rows[0]?.adset_id ?? null,
        adset_name: rows[0]?.adset_name ?? null,
        ...values,
      };
    }).sort((a, b) => b.investment - a.investment || a.name.localeCompare(b.name)),
    attribution: {
      status: attributionStatus,
      method: 'last_click_ctwa_7d' as const,
      attributed_sales: attributionStatus === 'ready' ? sales : null,
      attributed_revenue: attributionStatus === 'ready' ? revenue : null,
      gross_margin: attributionStatus === 'ready' ? grossMargin : null,
      pending_margin_orders: attributionStatus === 'ready'
        ? attributed?.pending_margin_orders ?? 0
        : null,
    },
    financial: {
      attributed_sales: attributionStatus === 'ready' ? sales : null,
      attributed_revenue: attributionStatus === 'ready' ? revenue : null,
      gross_margin: attributionStatus === 'ready' ? grossMargin : null,
      net_after_media: attributionStatus === 'ready' && grossMargin != null
        ? round(grossMargin - summary.investment)
        : null,
      roas: attributionStatus === 'ready' && revenue != null && summary.investment > 0
        ? round(revenue / summary.investment)
        : null,
      cac: attributionStatus === 'ready' && sales != null && sales > 0
        ? round(summary.investment / sales)
        : null,
    },
    decision: decision(summary),
  };
}
