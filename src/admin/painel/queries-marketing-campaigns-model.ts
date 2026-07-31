import {
  marketingDateWindow,
  type MarketingPeriod,
  type MetaCampaignMetric,
} from './marketing-meta.js';

export type MarketingCampaignChannel = 'all' | 'meta' | 'google' | 'tiktok';
export type ChannelStatus =
  | 'connected'
  | 'disabled'
  | 'not_configured'
  | 'error'
  | 'not_connected'
  | 'planned';

export interface MarketingCampaignsPayload {
  environment: 'prod' | 'test';
  generated_at: string;
  period: ReturnType<typeof marketingDateWindow> & { id: MarketingPeriod };
  selected_channel: MarketingCampaignChannel;
  connected_channels: MarketingCampaignChannel[];
  channels: Array<{
    id: Exclude<MarketingCampaignChannel, 'all'>;
    label: string;
    status: ChannelStatus;
  }>;
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
  };
  campaigns: Array<{
    id: string;
    platform_id: string;
    ad_account_id: string;
    channel: 'meta';
    name: string;
    scope: 'pending' | 'matrix' | 'external';
    status: 'with_delivery';
    investment: number;
    financial_investment: number;
    conversations: number;
    impressions: number;
    clicks: number;
    ctr: number | null;
    cost_per_conversation: number | null;
    attributed_sales: number | null;
    attributed_revenue: number | null;
    gross_margin: number | null;
    profit: number | null;
    stock_status: 'not_reconciled';
    cost_status: 'ready' | 'pending' | 'disabled';
    attribution_status: 'ready' | 'pending' | 'disabled';
    delivery_days: number;
    last_delivery: string;
    decision: {
      id: 'review' | 'monitor';
      label: string;
      detail: string;
      tone: 'attention' | 'safe';
    };
  }>;
  alerts: Array<{
    id: string;
    severity: 'high' | 'attention' | 'info';
    title: string;
    detail: string;
    target: string;
  }>;
}

export function campaignDecision(row: MetaCampaignMetric, averageCost: number | null) {
  if (row.scope === 'pending' && row.spend > 0) {
    return {
      id: 'review' as const,
      label: 'Classificar campanha',
      detail: 'Há investimento sem definição de quem assume o gasto.',
      tone: 'attention' as const,
    };
  }
  if (row.scope === 'external') {
    return {
      id: 'monitor' as const,
      label: 'Fora da matriz',
      detail: 'Entrega visível, sem efeito no Financeiro da matriz.',
      tone: 'safe' as const,
    };
  }
  if (row.spend > 0 && row.conversations === 0) {
    return {
      id: 'review' as const,
      label: 'Revisar entrega',
      detail: 'Houve investimento sem conversa registrada.',
      tone: 'attention' as const,
    };
  }
  if (row.cost_per_conversation != null && averageCost != null
      && row.cost_per_conversation > averageCost * 1.35) {
    return {
      id: 'review' as const,
      label: 'Revisar custo',
      detail: 'Custo por conversa acima da média do canal.',
      tone: 'attention' as const,
    };
  }
  return {
    id: 'monitor' as const,
    label: 'Monitorar',
    detail: 'Entrega confirmada; decisão de verba aguarda atribuição.',
    tone: 'safe' as const,
  };
}
