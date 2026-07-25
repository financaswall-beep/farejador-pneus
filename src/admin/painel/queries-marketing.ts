/**
 * Marketing — visão executiva read-only da matriz.
 * Une Meta agregada + presença do carimbo CTWA já normalizado em core.messages.
 * Nunca lê telefone, nome ou conteúdo da conversa; sempre filtra environment.
 */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  getMetaMarketingSnapshot,
  marketingDateWindow,
  type MarketingPeriod,
  type MetaMarketingSnapshot,
} from './marketing-meta.js';

type ConnectionStatus = 'connected' | 'disabled' | 'not_configured' | 'error';

interface AttributionHealth {
  available: boolean;
  referrals: number;
  ctwa: number;
}

export interface MarketingOverview {
  environment: 'prod' | 'test';
  generated_at: string;
  period: ReturnType<typeof marketingDateWindow> & { id: MarketingPeriod };
  connection: {
    meta: ConnectionStatus;
    attribution: 'enabled' | 'disabled';
    capi: 'not_implemented';
  };
  metrics: {
    investment: number | null;
    campaigns: number | null;
    conversations: number | null;
    cost_per_conversation: number | null;
    attributed_sales: null;
    profit: null;
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
  metaProvider?: typeof getMetaMarketingSnapshot;
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
    const result = await dbPool.query<{ referrals: number; ctwa: number }>(
      `SELECT
         count(DISTINCT conversation_id)
           FILTER (WHERE content_attributes ? 'referral')::int AS referrals,
         count(DISTINCT conversation_id)
           FILTER (WHERE COALESCE(content_attributes #>> '{referral,ctwa_clid}', '') <> '')::int AS ctwa
       FROM core.messages
       WHERE environment = $1
         AND sender_type = 'contact'
         AND is_private = false
         AND sent_at >= $2::date
         AND sent_at < ($3::date + 1)`,
      [environment, since, until],
    );
    return {
      available: true,
      referrals: Number(result.rows[0]?.referrals ?? 0),
      ctwa: Number(result.rows[0]?.ctwa ?? 0),
    };
  } catch {
    return { available: false, referrals: 0, ctwa: 0 };
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
  const metaProvider = dependencies.metaProvider ?? getMetaMarketingSnapshot;
  const window = marketingDateWindow(period, now);
  const attribution = await attributionHealth(env.FAREJADOR_ENV, window.since, window.until, dbPool);

  let meta: MetaMarketingSnapshot | null = null;
  let metaStatus: ConnectionStatus = config.metaEnabled ? 'not_configured' : 'disabled';
  if (config.metaEnabled && config.accessToken && config.adAccountId) {
    try {
      meta = await metaProvider({
        accessToken: config.accessToken,
        adAccountId: config.adAccountId,
        apiVersion: config.apiVersion,
      }, period, { now });
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
  if ((meta?.current.conversations ?? 0) > 0 && attribution.ctwa === 0) {
    alerts.push({
      id: 'ctwa-missing', severity: 'high', title: 'Referência CTWA ausente',
      detail: `${meta?.current.conversations ?? 0} conversas de anúncio e nenhum ctwa_clid capturado`,
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
  alerts.push({
    id: 'capi-pending', severity: 'info', title: 'CAPI ainda não implementada',
    detail: 'O retorno às plataformas só entra depois da atribuição comprovada',
    target: 'integracoes',
  });

  const previous = meta?.previous ?? null;
  const comparisonAvailable = Boolean(previous && (previous.spend > 0 || previous.conversations > 0));
  return {
    environment: env.FAREJADOR_ENV,
    generated_at: now.toISOString(),
    period: { id: period, ...window },
    connection: {
      meta: metaStatus,
      attribution: config.attributionEnabled ? 'enabled' : 'disabled',
      capi: 'not_implemented',
    },
    metrics: {
      investment: meta?.current.spend ?? null,
      campaigns: meta?.current.campaigns ?? null,
      conversations: meta?.current.conversations ?? null,
      cost_per_conversation: meta?.current.cost_per_conversation ?? null,
      attributed_sales: null,
      profit: null,
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
      { id: 'campaigns', label: 'Campanhas', status: meta ? 'ok' : 'pending' },
      { id: 'investment', label: 'Investimento', status: meta ? 'ok' : 'pending' },
      { id: 'conversations', label: 'Conversas', status: meta ? 'ok' : 'pending' },
      { id: 'attribution', label: 'Atribuição', status: attribution.ctwa > 0 ? 'ok' : 'pending' },
      { id: 'profit', label: 'Lucro', status: 'blocked' },
    ],
  };
}
