export interface InsightRow {
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
  financial_spend: unknown;
  campaign_scope: 'pending' | 'matrix' | 'external';
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

const ACTIONS = {
  firstReplies: new Set([
    'onsite_conversion.messaging_first_reply',
    'messaging_first_reply',
  ]),
  linkClicks: new Set(['link_click']),
  videoViews: new Set(['video_view']),
  postEngagements: new Set(['post_engagement']),
};

export function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function round(value: number, decimals = 2): number {
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

export function aggregate(rows: InsightRow[]): Aggregate {
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

export function derivedMetrics(values: Aggregate) {
  const conversations = Math.max(0, Math.round(values.conversations));
  const firstReplies = Math.min(conversations, Math.max(0, Math.round(values.firstReplies)));
  const unanswered = conversations - firstReplies;
  return {
    investment: round(values.spend),
    impressions: Math.round(values.impressions),
    clicks: Math.round(values.clicks),
    link_clicks: Math.round(values.linkClicks),
    video_views: Math.round(values.videoViews),
    post_engagements: Math.round(values.postEngagements),
    conversations_started: conversations,
    first_replies: firstReplies,
    unanswered,
    ctr: values.impressions > 0 ? round((values.clicks / values.impressions) * 100) : null,
    cpc: values.clicks > 0 ? round(values.spend / values.clicks) : null,
    cpm: values.impressions > 0 ? round((values.spend / values.impressions) * 1_000) : null,
    response_rate: conversations > 0
      ? round((firstReplies / conversations) * 100, 1)
      : null,
    cost_per_started: conversations > 0
      ? round(values.spend / conversations)
      : null,
    cost_per_replied: firstReplies > 0
      ? round(values.spend / firstReplies)
      : null,
    unanswered_investment: conversations > 0
      ? round(values.spend * (unanswered / conversations))
      : null,
  };
}

export function decision(metrics: ReturnType<typeof derivedMetrics>) {
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
