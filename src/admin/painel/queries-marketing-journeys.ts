/**
 * Marketing — jornada read-only da Meta até a venda.
 *
 * A entrada vem dos Insights agregados da Meta. O restante só é liberado
 * quando existe ctwa_clid persistido em core.messages e a atribuição foi
 * explicitamente habilitada. Nenhuma correlação por telefone ou coincidência.
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
import { loadOperationalJourney } from './queries-marketing-journeys-data.js';
import { marketingJourneyBottleneck } from './queries-marketing-journeys-bottleneck.js';

type ConnectionStatus = 'connected' | 'disabled' | 'not_configured' | 'error';
type JourneyStageStatus = 'ready' | 'attention' | 'pending' | 'blocked';
type JourneySource = 'meta' | 'farejador' | 'analytics' | 'commerce';

interface JourneyConfig {
  metaEnabled: boolean;
  attributionEnabled: boolean;
  accessToken?: string;
  adAccountId?: string;
  apiVersion: string;
}

interface JourneyDependencies {
  dbPool?: Pool;
  now?: Date;
  config?: JourneyConfig;
  metaProvider?: (
    ...args: Parameters<typeof getPersistedOrLiveMetaSnapshot>
  ) => Promise<MetaMarketingSnapshot>;
  attributionProvider?: typeof getMarketingAttributionReport;
}

export interface MarketingJourneysPayload {
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
    conversations: number | null;
    ctwa: number | null;
    tracking_coverage_percent: number | null;
    attributed_sales: number | null;
    attributed_revenue: number | null;
    total_realized_orders: number | null;
    orders_with_conversation: number | null;
    order_conversation_coverage_percent: number | null;
  };
  stages: Array<{
    id: 'meta_conversations' | 'ctwa' | 'qualified' | 'quote' | 'order' | 'sale';
    label: string;
    value: number | null;
    source: JourneySource;
    status: JourneyStageStatus;
    detail: string;
  }>;
  bottleneck: {
    id: 'meta_connection' | 'no_conversations' | 'ctwa_missing' | 'attribution_disabled' | 'journey_active';
    severity: 'high' | 'attention' | 'info' | 'ok';
    title: string;
    detail: string;
    target: 'integracoes' | 'campanhas' | 'jornadas';
  };
  quality: {
    meta_percent: number | null;
    tracking_percent: number | null;
    commercial_status: 'ready' | 'blocked';
    attribution_reliable: boolean;
  };
  campaigns: Array<{
    id: string;
    name: string;
    investment: number;
    conversations: number;
    ctwa: number | null;
    attributed_sales: number | null;
    bottleneck: 'no_conversations' | 'ctwa_missing' | 'campaign_mapping_pending';
  }>;
}

function defaultConfig(): JourneyConfig {
  return {
    metaEnabled: env.MARKETING_META_ENABLED,
    attributionEnabled: env.MARKETING_ATTRIBUTION,
    accessToken: env.META_ADS_ACCESS_TOKEN,
    adAccountId: env.META_ADS_ACCOUNT_ID,
    apiVersion: env.META_GRAPH_API_VERSION,
  };
}

function trackingCoverage(conversations: number | null, ctwa: number | null): number | null {
  if (conversations == null || ctwa == null || conversations <= 0) return null;
  return Math.min(100, Math.round((ctwa / conversations) * 1000) / 10);
}

function stage(
  id: MarketingJourneysPayload['stages'][number]['id'],
  label: string,
  value: number | null,
  source: JourneySource,
  status: JourneyStageStatus,
  detail: string,
): MarketingJourneysPayload['stages'][number] {
  return { id, label, value, source, status, detail };
}

export async function getMarketingJourneys(
  period: MarketingPeriod = '30d',
  dependencies: JourneyDependencies = {},
): Promise<MarketingJourneysPayload> {
  const now = dependencies.now ?? new Date();
  const config = dependencies.config ?? defaultConfig();
  const dbPool = dependencies.dbPool ?? defaultPool;
  const metaProvider = dependencies.metaProvider;
  const window = marketingDateWindow(period, now);

  const operationalPromise = loadOperationalJourney(
    env.FAREJADOR_ENV,
    window.since,
    window.until,
    dbPool,
  );

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

  const operational = await operationalPromise;
  const attributionReport = await (
    dependencies.attributionProvider ?? getMarketingAttributionReport
  )(window.since, window.until, dbPool);
  const conversations = meta?.current.conversations ?? null;
  const ctwa = operational.available ? operational.ctwa : null;
  const coverage = trackingCoverage(conversations, ctwa);
  const attributionReliable = Boolean(
    config.attributionEnabled
      && operational.available
      && operational.ctwa > 0
      && attributionReport.available,
  );
  const downstreamStatus: JourneyStageStatus = attributionReliable ? 'ready' : 'blocked';

  const bottleneck = marketingJourneyBottleneck({
    metaStatus,
    conversations,
    operationalAvailable: operational.available,
    ctwa: operational.ctwa,
    attributionEnabled: config.attributionEnabled,
    ledgerAvailable: attributionReport.available,
  });

  const campaigns = (meta?.current.campaign_rows ?? []).map((row) => {
    const noConversations = row.conversations === 0;
    const noCtwaAnywhere = operational.available && operational.ctwa === 0;
    const campaignAttribution = attributionReport?.campaigns
      .find((item) => item.campaign_id === row.id);
    return {
      id: `meta:${row.id}`,
      name: row.name,
      investment: row.spend,
      conversations: row.conversations,
      ctwa: noCtwaAnywhere ? 0 : null,
      attributed_sales: attributionReliable
        ? campaignAttribution?.attributed_sales ?? 0
        : null,
      bottleneck: noConversations
        ? 'no_conversations' as const
        : noCtwaAnywhere
          ? 'ctwa_missing' as const
          : 'campaign_mapping_pending' as const,
    };
  });

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
      conversations,
      ctwa,
      tracking_coverage_percent: coverage,
      attributed_sales: attributionReliable ? attributionReport?.attributed_sales ?? 0 : null,
      attributed_revenue: attributionReliable ? attributionReport?.attributed_revenue ?? 0 : null,
      total_realized_orders: attributionReport?.available
        ? attributionReport.total_realized_orders : null,
      orders_with_conversation: attributionReport?.available
        ? attributionReport.orders_with_conversation : null,
      order_conversation_coverage_percent: attributionReport?.available
        && attributionReport.total_realized_orders > 0
        ? Math.round(
          (attributionReport.orders_with_conversation
            / attributionReport.total_realized_orders) * 1000,
        ) / 10
        : null,
    },
    stages: [
      stage(
        'meta_conversations',
        'Conversa Meta',
        conversations,
        'meta',
        metaStatus === 'connected' ? 'ready' : 'pending',
        'Ação canônica registrada nos Insights.',
      ),
      stage(
        'ctwa',
        'CTWA identificado',
        ctwa,
        'farejador',
        ctwa == null ? 'pending' : ctwa > 0 ? 'ready' : 'attention',
        'referral.ctwa_clid persistido no webhook.',
      ),
      stage(
        'qualified',
        'Avançou após cotação',
        attributionReliable ? operational.qualified : null,
        'analytics',
        downstreamStatus,
        'Classificação real quote_sent ou purchase_intent.',
      ),
      stage(
        'quote',
        'Orçamento',
        attributionReliable ? operational.quotes : null,
        'analytics',
        downstreamStatus,
        'Fato price_quoted posterior ao CTWA.',
      ),
      stage(
        'order',
        'Pedido',
        attributionReliable ? operational.order_intents : null,
        'analytics',
        downstreamStatus,
        'Fato pedido_criado posterior ao CTWA.',
      ),
      stage(
        'sale',
        'Venda realizada',
        attributionReliable ? attributionReport?.attributed_sales ?? 0 : null,
        'commerce',
        downstreamStatus,
        'Entrega ou retirada realizada e ligada à conversa.',
      ),
    ],
    bottleneck,
    quality: {
      meta_percent: metaStatus === 'connected' ? 100 : null,
      tracking_percent: coverage,
      commercial_status: attributionReliable ? 'ready' : 'blocked',
      attribution_reliable: attributionReliable,
    },
    campaigns,
  };
}
