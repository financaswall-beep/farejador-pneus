/** Detalhe de campanha Meta com financeiro protegido por atribuição determinística. */
import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { pool as defaultPool } from '../../persistence/db.js';
import { marketingDateWindow, type MarketingPeriod } from './marketing-meta.js';
import {
  getMarketingAttributionReport,
  type MarketingAttributionReport,
} from '../../marketing/reporting.js';
import { loadCampaignAttributionDetailData } from './queries-marketing-campaign-detail-data.js';
import { buildCampaignDetailEnrichment } from './queries-marketing-campaign-detail-enrichment.js';
import {
  aggregate,
  decision,
  derivedMetrics,
  numberValue,
  round,
  type InsightRow,
} from './queries-marketing-campaign-detail-metrics.js';

interface DetailConfig {
  attributionEnabled: boolean;
}

export interface MarketingCampaignDetailDependencies {
  now?: Date;
  dbPool?: Pool;
  config?: DetailConfig;
  attributionProvider?: typeof getMarketingAttributionReport;
  attributionDetailProvider?: typeof loadCampaignAttributionDetailData;
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
            spend,
            CASE WHEN $5::boolean THEN financial_spend ELSE spend END
              AS financial_spend,
            campaign_scope,impressions,clicks,conversations,actions_raw
       FROM marketing.meta_insights_daily_scoped
      WHERE environment=$1 AND campaign_id=$2
        AND metric_date BETWEEN $3::date AND $4::date
      ORDER BY metric_date,entity_level,entity_id`,
    [
      env.FAREJADOR_ENV,
      campaignId,
      window.since,
      window.until,
      env.MARKETING_SCOPE_ENFORCEMENT_ENABLED,
    ],
  );
  const campaignRows = result.rows.filter((row) => row.entity_level === 'campaign');
  if (campaignRows.length === 0) return null;

  const summary = derivedMetrics(aggregate(campaignRows));
  const financialInvestment = round(campaignRows.reduce(
    (total, row) => total + numberValue(row.financial_spend ?? row.spend),
    0,
  ));
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
  const ads = [...adGroups.entries()].map(([id, rows]) => {
    const values = derivedMetrics(aggregate(rows));
    return {
      id,
      name: rows[0]?.entity_name || id,
      adset_id: rows[0]?.adset_id ?? null,
      adset_name: rows[0]?.adset_name ?? null,
      ...values,
    };
  }).sort((a, b) => b.investment - a.investment || a.name.localeCompare(b.name));
  const enrichment = await buildCampaignDetailEnrichment({
    campaignId,
    since: window.since,
    until: window.until,
    dbPool,
    attributionStatus,
    attributed,
    investment: financialInvestment,
    conversations: summary.conversations_started,
    ads,
    dataProvider: dependencies.attributionDetailProvider,
  });
  return {
    environment: env.FAREJADOR_ENV,
    generated_at: now.toISOString(),
    period: { id: period, ...window },
    campaign: {
      id: campaignId,
      name: first.campaign_name || first.entity_name || campaignId,
      channel: 'meta' as const,
      scope: first.campaign_scope,
      status: 'with_delivery' as const,
      currency: first.account_currency,
      delivery_days: deliveryDates.length,
      last_delivery: deliveryDates.at(-1) ?? window.until,
    },
    summary: { ...summary, financial_investment: financialInvestment },
    trend: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => ({
      date,
      ...derivedMetrics(aggregate(rows)),
    })),
    ads: enrichment.ads,
    attribution: {
      status: attributionStatus,
      method: 'last_click_messaging_7d' as const,
      attributed_sales: attributionStatus === 'ready' ? sales : null,
      attributed_revenue: attributionStatus === 'ready' ? revenue : null,
      gross_margin: attributionStatus === 'ready' ? grossMargin : null,
      pending_margin_orders: attributionStatus === 'ready'
        ? attributed?.pending_margin_orders ?? 0
        : null,
    },
    manager_url: enrichment.manager_url,
    tracking: enrichment.tracking,
    orders: enrichment.orders,
    orders_total: enrichment.orders_total,
    quality: enrichment.quality,
    financial: enrichment.financial,
    decision: decision(summary),
  };
}
