/**
 * Marketing — saúde das integrações, owner-only e read-only.
 * Não expõe credenciais, não altera plataformas e não presume sincronizações.
 */
import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMarketingOverview, type MarketingOverview } from './queries-marketing.js';
import type { MarketingPeriod } from './marketing-meta.js';
import {
  getMarketingPipelineHealth,
  type MarketingPipelineHealth,
} from '../../marketing/reporting.js';

type PlatformStatus = 'connected' | 'disabled' | 'not_configured' | 'error' | 'not_connected' | 'planned';
type CheckStatus = 'ok' | 'pending' | 'blocked' | 'error';

export interface MarketingAuditEvent {
  id: string;
  event_type: string;
  actor_label: string;
  created_at: string;
}

export interface MarketingIntegrationsPayload {
  environment: 'prod' | 'test';
  generated_at: string;
  summary: {
    connected: number;
    total: number;
    last_sync_at: string | null;
    quality_percent: number;
    critical_pending: number;
  };
  platforms: Array<{
    id: 'meta' | 'google' | 'tiktok';
    label: string;
    status: PlatformStatus;
    account_masked: string | null;
    last_sync_at: string | null;
    imported: string[];
  }>;
  pipeline: Array<{ id: string; label: string; status: CheckStatus }>;
  collection: Array<{ id: string; label: string; status: CheckStatus; detail: string }>;
  quality: Array<{ id: string; label: string; status: CheckStatus }>;
  next_step: string;
  audit_events: MarketingAuditEvent[];
  sync: {
    available: boolean;
    status: 'running' | 'succeeded' | 'failed' | null;
    rows_upserted: number;
  };
  capi: MarketingPipelineHealth['capi'] & { enabled: boolean };
}

interface IntegrationConfig {
  adAccountId?: string;
}

export interface MarketingIntegrationDependencies {
  dbPool?: Pool;
  overviewProvider?: typeof getMarketingOverview;
  auditProvider?: (pool: Pool) => Promise<MarketingAuditEvent[]>;
  healthProvider?: typeof getMarketingPipelineHealth;
  config?: IntegrationConfig;
}

function maskAccount(value?: string): string | null {
  if (!value) return null;
  const suffix = value.replace(/\D/g, '').slice(-4);
  return suffix ? `act_••••${suffix}` : null;
}

async function loadAuditEvents(dbPool: Pool): Promise<MarketingAuditEvent[]> {
  try {
    const result = await dbPool.query<MarketingAuditEvent>(
      `SELECT id::text,event_type,COALESCE(actor_label,'Sistema') actor_label,created_at::text
       FROM audit.events
       WHERE environment=$1 AND domain='marketing'
       ORDER BY created_at DESC
       LIMIT 8`,
      [env.FAREJADOR_ENV],
    );
    return result.rows;
  } catch {
    return [];
  }
}

function check(id: string, label: string, status: CheckStatus) {
  return { id, label, status };
}

export async function getMarketingIntegrations(
  period: MarketingPeriod = '30d',
  dependencies: MarketingIntegrationDependencies = {},
): Promise<MarketingIntegrationsPayload> {
  const overviewProvider = dependencies.overviewProvider ?? getMarketingOverview;
  const dbPool = dependencies.dbPool ?? defaultPool;
  const overview: MarketingOverview = await overviewProvider(period);
  const auditProvider = dependencies.auditProvider ?? loadAuditEvents;
  const [auditEvents, health] = await Promise.all([
    auditProvider(dbPool),
    (dependencies.healthProvider ?? getMarketingPipelineHealth)(dbPool),
  ]);
  const accountId = dependencies.config?.adAccountId ?? env.META_ADS_ACCOUNT_ID;

  const metaStatus = overview.connection.meta;
  const metaConnected = metaStatus === 'connected';
  const hasReferral = overview.attribution.available && overview.attribution.tracked > 0;
  const attributionReady = overview.connection.attribution === 'enabled' && hasReferral;
  const syncedAt = health.last_sync_at ?? overview.connection.meta_synced_at;
  const capiEnabled = overview.connection.capi === 'enabled';
  const capiHealthy = capiEnabled && health.available && health.capi.dead_letter === 0;

  const quality = [
    check('credential', 'Credencial protegida', metaConnected ? 'ok' : metaStatus === 'error' ? 'error' : 'pending'),
    check('account', 'Conta de anúncios', accountId ? 'ok' : 'pending'),
    check('sync', 'Sincronização', metaConnected ? 'ok' : metaStatus === 'error' ? 'error' : 'pending'),
    check('ctwa', 'Atribuição por mensagem', hasReferral ? 'ok' : 'pending'),
    check('capi', 'Retorno CAPI', capiHealthy ? 'ok' : capiEnabled ? 'error' : 'pending'),
  ];
  const ready = quality.filter((row) => row.status === 'ok').length;
  const criticalPending = Number(!metaConnected)
    + Number((overview.metrics.conversations ?? 0) > 0 && !hasReferral);

  return {
    environment: overview.environment,
    generated_at: overview.generated_at,
    summary: {
      connected: metaConnected ? 1 : 0,
      total: 3,
      last_sync_at: syncedAt,
      quality_percent: Math.round((ready / quality.length) * 100),
      critical_pending: criticalPending,
    },
    platforms: [
      {
        id: 'meta',
        label: 'Meta Ads',
        status: metaStatus,
        account_masked: maskAccount(accountId),
        last_sync_at: syncedAt,
        imported: metaConnected ? ['Campanhas', 'Investimento', 'Conversas'] : [],
      },
      {
        id: 'google',
        label: 'Google Ads',
        status: 'not_connected',
        account_masked: null,
        last_sync_at: null,
        imported: [],
      },
      {
        id: 'tiktok',
        label: 'TikTok Ads',
        status: 'planned',
        account_masked: null,
        last_sync_at: null,
        imported: [],
      },
    ],
    pipeline: [
      check('platform', 'Plataforma', metaConnected ? 'ok' : 'pending'),
      check('collection', 'Coleta', metaConnected ? 'ok' : 'pending'),
      check('normalization', 'Normalização', metaConnected ? 'ok' : 'pending'),
      check('attribution', 'Atribuição', attributionReady ? 'ok' : 'pending'),
      check('profit', 'Vendas e lucro', attributionReady ? 'ok' : 'blocked'),
    ],
    collection: [
      { ...check('campaigns', 'Campanhas e investimento', metaConnected ? 'ok' : 'pending'),
        detail: metaConnected ? 'recebendo' : 'sem coleta' },
      { ...check('conversations', 'Conversas por anúncio', metaConnected ? 'ok' : 'pending'),
        detail: metaConnected ? 'recebendo' : 'sem coleta' },
      { ...check('ctwa', 'Referências de anúncio', hasReferral ? 'ok' : 'pending'),
        detail: hasReferral
          ? `${overview.attribution.tracked} referência(s): ${overview.attribution.ctwa} WhatsApp, ${overview.attribution.messenger} Messenger, ${overview.attribution.instagram} Instagram`
          : 'ausente; exige campanha de Mensagens com referral entregue ao Farejador' },
      {
        ...check('capi', 'CAPI', capiHealthy ? 'ok' : capiEnabled ? 'error' : 'pending'),
        detail: capiEnabled
          ? `${health.capi.sent} enviado(s), ${health.capi.dead_letter} em dead-letter`
          : 'implementada e desligada até passar no Test Events',
      },
    ],
    quality,
    next_step: !metaConnected
      ? 'Conectar a Meta usando credenciais protegidas'
      : !hasReferral
        ? 'Validar o vínculo entre conversa e venda'
        : overview.connection.attribution !== 'enabled'
          ? 'Habilitar a atribuição depois da prova ponta a ponta'
          : !capiEnabled
            ? 'Validar Purchase no Test Events e ativar a CAPI'
            : health.capi.dead_letter > 0
              ? 'Revisar eventos CAPI em dead-letter'
              : 'Pipeline Meta e CAPI operacionais',
    audit_events: auditEvents,
    sync: {
      available: health.available,
      status: health.last_sync_status,
      rows_upserted: health.rows_upserted,
    },
    capi: {
      enabled: capiEnabled,
      ...health.capi,
    },
  };
}
