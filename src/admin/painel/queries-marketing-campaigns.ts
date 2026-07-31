import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { pool as defaultPool } from '../../persistence/db.js';
import {
  marketingDateWindow,
  type MarketingPeriod,
  type MetaMarketingSnapshot,
} from './marketing-meta.js';
import { getPersistedOrLiveMetaSnapshot } from '../../marketing/meta-sync.js';
import {
  getMarketingAttributionReport,
  type MarketingAttributionReport,
} from '../../marketing/reporting.js';
import {
  campaignDecision,
  type ChannelStatus,
  type MarketingCampaignChannel,
  type MarketingCampaignsPayload,
} from './queries-marketing-campaigns-model.js';
export type {
  MarketingCampaignChannel,
  MarketingCampaignsPayload,
} from './queries-marketing-campaigns-model.js';
interface CampaignConfig {
  metaEnabled: boolean;
  attributionEnabled: boolean;
  accessToken?: string;
  adAccountId?: string;
  apiVersion: string;
}
export interface MarketingCampaignDependencies {
  now?: Date;
  dbPool?: Pool;
  config?: CampaignConfig;
  metaProvider?: (
    ...args: Parameters<typeof getPersistedOrLiveMetaSnapshot>
  ) => Promise<MetaMarketingSnapshot>;
  attributionProvider?: typeof getMarketingAttributionReport;
}
function defaultConfig(): CampaignConfig {
  return {
    metaEnabled: env.MARKETING_META_ENABLED,
    attributionEnabled: env.MARKETING_ATTRIBUTION,
    accessToken: env.META_ADS_ACCESS_TOKEN,
    adAccountId: env.META_ADS_ACCOUNT_ID,
    apiVersion: env.META_GRAPH_API_VERSION,
  };
}
export async function getMarketingCampaigns(
  period: MarketingPeriod = '30d',
  channel: MarketingCampaignChannel = 'all',
  dependencies: MarketingCampaignDependencies = {},
): Promise<MarketingCampaignsPayload> {
  const now = dependencies.now ?? new Date();
  const dbPool = dependencies.dbPool ?? defaultPool;
  const config = dependencies.config ?? defaultConfig();
  const metaProvider = dependencies.metaProvider;
  const window = marketingDateWindow(period, now);
  let meta: MetaMarketingSnapshot | null = null;
  let metaStatus: ChannelStatus = config.metaEnabled ? 'not_configured' : 'disabled';
  if (config.metaEnabled && config.accessToken && config.adAccountId) {
    try {
      const metaConfig = {
        accessToken: config.accessToken,
        adAccountId: config.adAccountId,
        apiVersion: config.apiVersion,
      };
      meta = metaProvider
        ? await metaProvider(metaConfig, period, { now })
        : await getPersistedOrLiveMetaSnapshot(metaConfig, period, { now, dbPool });
      metaStatus = 'connected';
    } catch {
      metaStatus = 'error';
    }
  }
  const includesMeta = channel === 'all' || channel === 'meta';
  const sourceRows = includesMeta ? meta?.current.campaign_rows ?? [] : [];
  const averageCost = includesMeta ? meta?.current.cost_per_conversation ?? null : null;
  let attribution: MarketingAttributionReport | null = null;
  if (config.attributionEnabled) {
    attribution = await (dependencies.attributionProvider ?? getMarketingAttributionReport)(
      window.since,
      window.until,
      dbPool,
    );
  }
  const campaignAttribution = new Map(
    (attribution?.campaigns ?? []).map((row) => [row.campaign_id, row]),
  );
  const campaigns = sourceRows.map((row) => {
    const attributed = campaignAttribution.get(row.id);
    const grossMargin = attributed?.gross_margin ?? null;
    return {
    id: `meta:${row.id}`,
    platform_id: row.id,
    ad_account_id: row.ad_account_id ?? config.adAccountId ?? '',
    channel: 'meta' as const,
    name: row.name,
    scope: row.scope ?? (env.MARKETING_SCOPE_ENFORCEMENT_ENABLED ? 'pending' : 'matrix'),
    status: 'with_delivery' as const,
    investment: row.spend,
    financial_investment: row.financial_spend ?? row.spend,
    conversations: row.conversations,
    impressions: row.impressions ?? 0,
    clicks: row.clicks ?? 0,
    ctr: row.ctr ?? null,
    cost_per_conversation: row.cost_per_conversation,
    attributed_sales: config.attributionEnabled ? attributed?.attributed_sales ?? 0 : null,
    attributed_revenue: config.attributionEnabled ? attributed?.attributed_revenue ?? 0 : null,
    gross_margin: config.attributionEnabled ? grossMargin : null,
    profit: config.attributionEnabled && grossMargin != null
      ? Math.round((grossMargin - (row.financial_spend ?? row.spend)) * 100) / 100
      : null,
    stock_status: 'not_reconciled' as const,
    cost_status: !config.attributionEnabled
      ? 'disabled' as const
      : attributed && grossMargin != null
        ? 'ready' as const
        : 'pending' as const,
    attribution_status: config.attributionEnabled
      ? attributed ? 'ready' as const : 'pending' as const
      : 'disabled' as const,
    delivery_days: row.delivery_days,
    last_delivery: row.last_delivery,
    decision: campaignDecision(row, averageCost),
  };
  });
  const alerts: MarketingCampaignsPayload['alerts'] = [];
  if (channel === 'google') {
    alerts.push({
      id: 'google-not-connected',
      severity: 'attention',
      title: 'Google Ads ainda não conectado',
      detail: 'Nenhuma campanha ou indicador do Google foi presumido.',
      target: 'integracoes',
    });
  } else if (channel === 'tiktok') {
    alerts.push({
      id: 'tiktok-planned',
      severity: 'info',
      title: 'TikTok Ads está planejado',
      detail: 'A coleta será liberada somente após a integração própria.',
      target: 'integracoes',
    });
  } else if (metaStatus !== 'connected') {
    alerts.push({
      id: 'meta-unavailable',
      severity: metaStatus === 'error' ? 'high' : 'attention',
      title: metaStatus === 'error' ? 'Coleta Meta indisponível' : 'Meta Ads ainda não conectada',
      detail: 'As campanhas permanecem vazias; nenhum valor foi estimado.',
      target: 'integracoes',
    });
  }
  const withoutConversation = campaigns.filter((row) => row.investment > 0 && row.conversations === 0).length;
  const highCost = campaigns.filter((row) => row.decision.label === 'Revisar custo').length;
  const pendingScope = campaigns.filter((row) => row.scope === 'pending' && row.investment > 0).length;
  if (pendingScope > 0) {
    alerts.push({
      id: 'campaign-scope-pending',
      severity: 'high',
      title: `${pendingScope} campanha(s) com gasto aguardando classificação`,
      detail: 'O fechamento permanece protegido até o dono definir Matriz ou Externa.',
      target: 'campanhas',
    });
  }
  if (withoutConversation > 0) {
    alerts.push({
      id: 'without-conversation',
      severity: 'high',
      title: `${withoutConversation} campanha(s) com investimento sem conversa`,
      detail: 'Revise entrega, público e destino antes de ampliar a verba.',
      target: 'campanhas',
    });
  }
  if (highCost > 0) {
    alerts.push({
      id: 'high-cost',
      severity: 'attention',
      title: `${highCost} campanha(s) acima do custo médio`,
      detail: 'A comparação usa somente campanhas do mesmo canal e período.',
      target: 'campanhas',
    });
  }
  if (campaigns.length > 0 && !config.attributionEnabled) {
    alerts.push({
      id: 'attribution-blocked',
      severity: 'info',
      title: 'Decisão de verba permanece protegida',
      detail: 'Vendas e lucro só serão liberados após atribuição determinística.',
      target: 'jornadas',
    });
  }
  const hasMeta = includesMeta && metaStatus === 'connected';
  const netAfterMedia = config.attributionEnabled && attribution?.available
    && attribution.gross_margin != null && meta
    ? Math.round((attribution.gross_margin - meta.current.spend) * 100) / 100
    : null;
  return {
    environment: env.FAREJADOR_ENV,
    generated_at: now.toISOString(),
    period: { id: period, ...window },
    selected_channel: channel,
    connected_channels: metaStatus === 'connected' ? ['meta'] : [],
    channels: [
      { id: 'meta', label: 'Meta', status: metaStatus },
      { id: 'google', label: 'Google', status: 'not_connected' },
      { id: 'tiktok', label: 'TikTok', status: 'planned' },
    ],
    metrics: {
      investment: hasMeta ? meta?.current.spend ?? 0 : null,
      campaigns: hasMeta ? meta?.current.campaigns ?? 0 : null,
      conversations: hasMeta ? meta?.current.conversations ?? 0 : null,
      impressions: hasMeta ? meta?.current.impressions ?? 0 : null,
      clicks: hasMeta ? meta?.current.clicks ?? 0 : null,
      ctr: hasMeta ? meta?.current.ctr ?? null : null,
      cost_per_conversation: hasMeta ? meta?.current.cost_per_conversation ?? null : null,
      attributed_sales: config.attributionEnabled && attribution?.available
        ? attribution.attributed_sales : null,
      attributed_revenue: config.attributionEnabled && attribution?.available
        ? attribution.attributed_revenue : null,
      gross_margin: config.attributionEnabled && attribution?.available
        ? attribution.gross_margin : null,
      net_after_media: netAfterMedia,
      profit: netAfterMedia,
    },
    campaigns,
    alerts,
  };
}
