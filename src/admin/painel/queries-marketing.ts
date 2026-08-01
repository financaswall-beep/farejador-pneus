/**
 * Marketing — visão executiva read-only da matriz.
 * Une Meta agregada + referências de anúncio dos canais de mensagem.
 * Nunca lê telefone, nome ou conteúdo da conversa; sempre filtra environment.
 */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
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

type ConnectionStatus = 'connected' | 'disabled' | 'not_configured' | 'error';

interface AttributionHealth {
  available: boolean;
  referrals: number;
  tracked: number;
  ctwa: number;
  messenger: number;
  instagram: number;
}

export interface MarketingOverview {
  environment: 'prod' | 'test';
  generated_at: string;
  period: ReturnType<typeof marketingDateWindow> & { id: MarketingPeriod };
  connection: {
    meta: ConnectionStatus;
    meta_synced_at: string | null;
    attribution: 'enabled' | 'disabled';
    capi: 'enabled' | 'disabled';
  };
  metrics: {
    investment: number | null;
    campaigns: number | null;
    conversations: number | null;
    impressions: number | null;
    clicks: number | null;
    ctr: number | null;
    cost_per_conversation: number | null;
    attributed_sales: number | null;
    attributed_revenue: number | null;
    gross_margin: number | null;
    net_after_media: number | null;
    /** Compatibilidade com a primeira versão da tela: equivale a net_after_media. */
    profit: number | null;
    pending_margin_orders: number | null;
  };
  series: Array<{ date: string; spend: number; conversations: number }>;
  comparison: {
    available: boolean;
    previous: { spend: number; conversations: number } | null;
    spend_delta_percent: number | null;
    conversations_delta_percent: number | null;
    reason: string | null;
  };
  attribution: AttributionHealth;
  alerts: Array<{ id: string; severity: 'high' | 'attention' | 'info'; title: string; detail: string; target: string }>;
  channels: Array<{ id: string; label: string; status: string }>;
  quality: Array<{ id: string; label: string; status: 'ok' | 'pending' | 'blocked' }>;
}

interface MarketingConfig {
  metaEnabled: boolean;
  attributionEnabled: boolean;
  accessToken?: string;
  adAccountId?: string;
  apiVersion: string;
}

interface MarketingDependencies {
  dbPool?: Pool;
  now?: Date;
  config?: MarketingConfig;
  metaProvider?: (
    ...args: Parameters<typeof getPersistedOrLiveMetaSnapshot>
  ) => Promise<MetaMarketingSnapshot>;
  attributionProvider?: typeof getMarketingAttributionReport;
}

function deltaPercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function attributionHealth(
  environment: 'prod' | 'test',
  since: string,
  until: string,
  dbPool: Pool,
): Promise<AttributionHealth> {
  try {
    const result = await dbPool.query<{
      referrals: number; tracked: number; ctwa: number; messenger: number; instagram: number;
    }>(
      `SELECT
         count(DISTINCT conversation_id)::int AS referrals,
         count(DISTINCT conversation_id)::int AS tracked,
         count(DISTINCT conversation_id) FILTER (WHERE channel='whatsapp')::int AS ctwa,
         count(DISTINCT conversation_id) FILTER (WHERE channel='messenger')::int AS messenger,
         count(DISTINCT conversation_id) FILTER (WHERE channel='instagram')::int AS instagram
       FROM marketing.ad_referrals
       WHERE environment = $1
         AND captured_at >= $2::date
         AND captured_at < ($3::date + 1)`,
      [environment, since, until],
    );
    return {
      available: true,
      referrals: Number(result.rows[0]?.referrals ?? 0),
      tracked: Number(result.rows[0]?.tracked ?? result.rows[0]?.referrals ?? 0),
      ctwa: Number(result.rows[0]?.ctwa ?? 0),
      messenger: Number(result.rows[0]?.messenger ?? 0),
      instagram: Number(result.rows[0]?.instagram ?? 0),
    };
  } catch {
    return { available: false, referrals: 0, tracked: 0, ctwa: 0, messenger: 0, instagram: 0 };
  }
}

function defaultConfig(): MarketingConfig {
  return {
    metaEnabled: env.MARKETING_META_ENABLED,
    attributionEnabled: env.MARKETING_ATTRIBUTION,
    accessToken: env.META_ADS_ACCESS_TOKEN,
    adAccountId: env.META_ADS_ACCOUNT_ID,
    apiVersion: env.META_GRAPH_API_VERSION,
  };
}

export async function getMarketingOverview(
  period: MarketingPeriod = '30d',
  dependencies: MarketingDependencies = {},
): Promise<MarketingOverview> {
  const now = dependencies.now ?? new Date();
  const config = dependencies.config ?? defaultConfig();
  const dbPool = dependencies.dbPool ?? defaultPool;
  const metaProvider = dependencies.metaProvider;
  const window = marketingDateWindow(period, now);
  const attribution = await attributionHealth(env.FAREJADOR_ENV, window.since, window.until, dbPool);

  let meta: MetaMarketingSnapshot | null = null;
  let metaStatus: ConnectionStatus = config.metaEnabled ? 'not_configured' : 'disabled';
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

  const alerts: MarketingOverview['alerts'] = [];
  if (metaStatus !== 'connected') {
    alerts.push({
      id: 'meta-connection',
      severity: metaStatus === 'error' ? 'high' : 'attention',
      title: metaStatus === 'error' ? 'Sincronização Meta indisponível' : 'Meta Ads não conectada',
      detail: metaStatus === 'disabled'
        ? 'Integração dormente até receber credenciais próprias no Coolify'
        : 'Revise a configuração segura da conta de anúncios',
      target: 'integracoes',
    });
  }
  if ((meta?.current.conversations ?? 0) > 0 && attribution.tracked === 0) {
    alerts.push({
      id: 'ctwa-missing', severity: 'high', title: 'Referência de anúncio ausente',
      detail: `${meta?.current.conversations ?? 0} conversas e nenhuma referência rastreável de WhatsApp, Messenger ou Instagram`,
      target: 'jornadas',
    });
  }
  if (!config.attributionEnabled) {
    alerts.push({
      id: 'attribution-disabled', severity: 'attention', title: 'Atribuição ainda dormente',
      detail: 'Vendas e lucro permanecem bloqueados até a correlação ser validada',
      target: 'jornadas',
    });
  }
  if (!env.MARKETING_CAPI_ENABLED) {
    alerts.push({
      id: 'capi-pending', severity: 'info', title: 'CAPI pronta e desligada',
      detail: 'Ative somente depois de validar um Purchase em Test Events',
      target: 'integracoes',
    });
  }
  const pendingScopeCampaigns = (meta?.current.campaign_rows ?? [])
    .filter((row) => row.scope === 'pending' && row.spend > 0).length;
  if (pendingScopeCampaigns > 0) {
    alerts.push({
      id: 'campaign-scope-pending', severity: 'high',
      title: `${pendingScopeCampaigns} campanha(s) aguardando classificação`,
      detail: 'Esses gastos não entram no Financeiro e bloqueiam o fechamento.',
      target: 'campanhas',
    });
  }

  let attributed: MarketingAttributionReport | null = null;
  if (config.attributionEnabled) {
    attributed = await (dependencies.attributionProvider ?? getMarketingAttributionReport)(
      window.since,
      window.until,
      dbPool,
    );
  }
  const attributionReady = Boolean(config.attributionEnabled && attributed?.available);
  const grossMargin = attributionReady ? attributed?.gross_margin ?? null : null;
  const investment = meta?.current.spend ?? null;
  const netAfterMedia = grossMargin != null && investment != null
    ? Math.round((grossMargin - investment) * 100) / 100
    : null;
  const previous = meta?.previous ?? null;
  const comparisonAvailable = Boolean(previous && (previous.spend > 0 || previous.conversations > 0));
  return {
    environment: env.FAREJADOR_ENV,
    generated_at: now.toISOString(),
    period: { id: period, ...window },
    connection: {
      meta: metaStatus,
      meta_synced_at: meta?.fetched_at ?? null,
      attribution: config.attributionEnabled ? 'enabled' : 'disabled',
      capi: env.MARKETING_CAPI_ENABLED ? 'enabled' : 'disabled',
    },
    metrics: {
      investment,
      campaigns: meta?.current.campaigns ?? null,
      conversations: meta?.current.conversations ?? null,
      impressions: meta?.current.impressions ?? null,
      clicks: meta?.current.clicks ?? null,
      ctr: meta?.current.ctr ?? null,
      cost_per_conversation: meta?.current.cost_per_conversation ?? null,
      attributed_sales: attributionReady ? attributed?.attributed_sales ?? 0 : null,
      attributed_revenue: attributionReady ? attributed?.attributed_revenue ?? 0 : null,
      gross_margin: grossMargin,
      net_after_media: netAfterMedia,
      profit: netAfterMedia,
      pending_margin_orders: attributionReady ? attributed?.pending_margin_orders ?? 0 : null,
    },
    series: meta?.current.daily ?? [],
    comparison: {
      available: comparisonAvailable,
      previous: previous ? { spend: previous.spend, conversations: previous.conversations } : null,
      spend_delta_percent: comparisonAvailable && previous
        ? deltaPercent(meta?.current.spend ?? 0, previous.spend) : null,
      conversations_delta_percent: comparisonAvailable && previous
        ? deltaPercent(meta?.current.conversations ?? 0, previous.conversations) : null,
      reason: comparisonAvailable ? null : 'historico_anterior_insuficiente',
    },
    attribution,
    alerts,
    channels: [
      { id: 'meta', label: 'Meta', status: metaStatus },
      { id: 'google', label: 'Google', status: 'not_connected' },
      { id: 'tiktok', label: 'TikTok', status: 'planned' },
    ],
    quality: [
      {
        id: 'campaign_scope',
        label: 'Escopo das campanhas',
        status: pendingScopeCampaigns > 0 ? 'blocked' : 'ok',
      },
      { id: 'campaigns', label: 'Campanhas', status: meta ? 'ok' : 'pending' },
      { id: 'investment', label: 'Investimento', status: meta ? 'ok' : 'pending' },
      { id: 'conversations', label: 'Conversas', status: meta ? 'ok' : 'pending' },
      { id: 'attribution', label: 'Atribuição', status: attribution.tracked > 0 ? 'ok' : 'pending' },
      {
        id: 'profit',
        label: 'Lucro',
        status: grossMargin != null ? 'ok' : attributionReady ? 'pending' : 'blocked',
      },
    ],
  };
}
