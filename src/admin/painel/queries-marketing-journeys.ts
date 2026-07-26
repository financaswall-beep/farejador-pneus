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
  getMetaMarketingSnapshot,
  marketingDateWindow,
  type MarketingPeriod,
  type MetaMarketingSnapshot,
} from './marketing-meta.js';

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
  metaProvider?: typeof getMetaMarketingSnapshot;
}

interface OperationalJourney {
  available: boolean;
  referrals: number;
  ctwa: number;
  qualified: number;
  quotes: number;
  order_intents: number;
  attributed_sales: number;
  attributed_revenue: number;
}

interface OperationalJourneyRow {
  referrals: unknown;
  ctwa: unknown;
  qualified: unknown;
  quotes: unknown;
  order_intents: unknown;
  attributed_sales: unknown;
  attributed_revenue: unknown;
}

export interface MarketingJourneysPayload {
  environment: 'prod' | 'test';
  generated_at: string;
  period: ReturnType<typeof marketingDateWindow> & { id: MarketingPeriod };
  connection: {
    meta: ConnectionStatus;
    meta_synced_at: string | null;
    attribution: 'enabled' | 'disabled';
    capi: 'not_implemented';
  };
  metrics: {
    conversations: number | null;
    ctwa: number | null;
    tracking_coverage_percent: number | null;
    attributed_sales: number | null;
    attributed_revenue: number | null;
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

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

async function loadOperationalJourney(
  environment: 'prod' | 'test',
  since: string,
  until: string,
  dbPool: Pool,
): Promise<OperationalJourney> {
  try {
    const result = await dbPool.query<OperationalJourneyRow>(
      `WITH tracked AS (
         SELECT conversation_id, min(sent_at) AS attributed_at
         FROM core.messages
         WHERE environment = $1
           AND sender_type = 'contact'
           AND is_private = false
           AND sent_at >= $2::date
           AND sent_at < ($3::date + 1)
           AND COALESCE(content_attributes #>> '{referral,ctwa_clid}', '') <> ''
         GROUP BY conversation_id
       ),
       referrals AS (
         SELECT DISTINCT conversation_id
         FROM core.messages
         WHERE environment = $1
           AND sender_type = 'contact'
           AND is_private = false
           AND sent_at >= $2::date
           AND sent_at < ($3::date + 1)
           AND content_attributes ? 'referral'
       )
       SELECT
         (SELECT count(*) FROM referrals)::int AS referrals,
         (SELECT count(*) FROM tracked)::int AS ctwa,
         (SELECT count(DISTINCT cc.conversation_id)
            FROM analytics.conversation_classifications cc
            JOIN tracked t ON t.conversation_id = cc.conversation_id
           WHERE cc.environment = $1
             AND cc.dimension = 'stage_reached'
             AND cc.value IN ('quote_sent', 'purchase_intent')
             AND cc.created_at >= t.attributed_at)::int AS qualified,
         (SELECT count(DISTINCT cf.conversation_id)
            FROM analytics.conversation_facts cf
            JOIN tracked t ON t.conversation_id = cf.conversation_id
           WHERE cf.environment = $1
             AND cf.fact_key = 'price_quoted'
             AND cf.superseded_by IS NULL
             AND COALESCE(cf.observed_at, cf.created_at) >= t.attributed_at)::int AS quotes,
         (SELECT count(DISTINCT cf.conversation_id)
            FROM analytics.conversation_facts cf
            JOIN tracked t ON t.conversation_id = cf.conversation_id
           WHERE cf.environment = $1
             AND cf.fact_key = 'pedido_criado'
             AND cf.superseded_by IS NULL
             AND COALESCE(cf.observed_at, cf.created_at) >= t.attributed_at)::int AS order_intents,
         (SELECT count(o.id)
            FROM commerce.orders o
            JOIN tracked t ON t.conversation_id = o.source_conversation_id
           WHERE o.environment = $1
             AND o.status <> 'cancelled'
             AND o.created_at >= t.attributed_at
             AND o.created_at < ($3::date + 1))::int AS attributed_sales,
         (SELECT COALESCE(sum(o.total_amount), 0)
            FROM commerce.orders o
            JOIN tracked t ON t.conversation_id = o.source_conversation_id
           WHERE o.environment = $1
             AND o.status <> 'cancelled'
             AND o.created_at >= t.attributed_at
             AND o.created_at < ($3::date + 1)) AS attributed_revenue`,
      [environment, since, until],
    );
    const row = result.rows[0];
    return {
      available: true,
      referrals: numberValue(row?.referrals),
      ctwa: numberValue(row?.ctwa),
      qualified: numberValue(row?.qualified),
      quotes: numberValue(row?.quotes),
      order_intents: numberValue(row?.order_intents),
      attributed_sales: numberValue(row?.attributed_sales),
      attributed_revenue: Math.round(numberValue(row?.attributed_revenue) * 100) / 100,
    };
  } catch {
    return {
      available: false,
      referrals: 0,
      ctwa: 0,
      qualified: 0,
      quotes: 0,
      order_intents: 0,
      attributed_sales: 0,
      attributed_revenue: 0,
    };
  }
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
  const metaProvider = dependencies.metaProvider ?? getMetaMarketingSnapshot;
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

  const operational = await operationalPromise;
  const conversations = meta?.current.conversations ?? null;
  const ctwa = operational.available ? operational.ctwa : null;
  const coverage = trackingCoverage(conversations, ctwa);
  const attributionReliable = Boolean(
    config.attributionEnabled
      && operational.available
      && operational.ctwa > 0,
  );
  const downstreamStatus: JourneyStageStatus = attributionReliable ? 'ready' : 'blocked';

  let bottleneck: MarketingJourneysPayload['bottleneck'];
  if (metaStatus !== 'connected') {
    bottleneck = {
      id: 'meta_connection',
      severity: 'high',
      title: 'A coleta da Meta precisa ser conectada',
      detail: 'Sem Insights não existe uma entrada confiável para a jornada.',
      target: 'integracoes',
    };
  } else if ((conversations ?? 0) === 0) {
    bottleneck = {
      id: 'no_conversations',
      severity: 'info',
      title: 'Nenhuma conversa de anúncio no período',
      detail: 'A jornada será preenchida quando houver entrega com conversa registrada pela Meta.',
      target: 'campanhas',
    };
  } else if (operational.available && operational.ctwa === 0) {
    bottleneck = {
      id: 'ctwa_missing',
      severity: 'high',
      title: 'Rastreio interrompido antes do Farejador',
      detail: `${conversations ?? 0} conversa(s) na Meta e nenhum referral com ctwa_clid persistido.`,
      target: 'integracoes',
    };
  } else if (!config.attributionEnabled) {
    bottleneck = {
      id: 'attribution_disabled',
      severity: 'attention',
      title: 'CTWA encontrado; validação da atribuição ainda está desligada',
      detail: 'Ative MARKETING_ATTRIBUTION somente depois de conferir o vínculo em produção.',
      target: 'integracoes',
    };
  } else {
    bottleneck = {
      id: 'journey_active',
      severity: 'ok',
      title: 'Jornada rastreável ativa',
      detail: 'As etapas comerciais usam somente conversas com CTWA e eventos posteriores ao clique.',
      target: 'jornadas',
    };
  }

  const campaigns = (meta?.current.campaign_rows ?? []).map((row) => {
    const noConversations = row.conversations === 0;
    const noCtwaAnywhere = operational.available && operational.ctwa === 0;
    return {
      id: `meta:${row.id}`,
      name: row.name,
      investment: row.spend,
      conversations: row.conversations,
      ctwa: noCtwaAnywhere ? 0 : null,
      attributed_sales: null,
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
      capi: 'not_implemented',
    },
    metrics: {
      conversations,
      ctwa,
      tracking_coverage_percent: coverage,
      attributed_sales: attributionReliable ? operational.attributed_sales : null,
      attributed_revenue: attributionReliable ? operational.attributed_revenue : null,
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
        'Lead qualificado',
        attributionReliable ? operational.qualified : null,
        'analytics',
        downstreamStatus,
        'Classificação stage_reached com proveniência.',
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
        attributionReliable ? operational.attributed_sales : null,
        'commerce',
        downstreamStatus,
        'Pedido não cancelado ligado à conversa.',
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
