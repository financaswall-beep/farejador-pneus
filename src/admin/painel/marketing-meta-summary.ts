import type {
  MetaInsightRow,
  MetaPeriodSummary,
} from './marketing-meta.js';

const LEAD_ACTION_PRIORITY = [
  'onsite_conversion.messaging_conversation_started_7d',
  'onsite_conversion.lead_grouped',
  'lead',
] as const;
const LEAD_ACTION_TYPES = new Set<string>(LEAD_ACTION_PRIORITY);

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function canonicalConversationAction(actions: unknown): {
  value: number;
  actionType: string | null;
} {
  if (!Array.isArray(actions)) return { value: 0, actionType: null };
  const totals = new Map<string, number>();
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const row = action as Record<string, unknown>;
    const actionType = String(row.action_type ?? '');
    if (!LEAD_ACTION_TYPES.has(actionType)) continue;
    totals.set(actionType, (totals.get(actionType) ?? 0) + numberValue(row.value));
  }
  for (const actionType of LEAD_ACTION_PRIORITY) {
    if (totals.has(actionType)) {
      return { value: totals.get(actionType) ?? 0, actionType };
    }
  }
  return { value: 0, actionType: null };
}

export function summarizeMetaRows(
  rows: MetaInsightRow[],
  since: string,
  until: string,
): MetaPeriodSummary {
  const campaigns = new Set<string>();
  const byDate = new Map<string, MetaPeriodSummary['daily'][number]>();
  const byCampaign = new Map<string, {
    id: string;
    name: string;
    spend: number;
    conversations: number;
    impressions: number;
    clicks: number;
    deliveryDates: Set<string>;
  }>();
  let spend = 0;
  let conversations = 0;
  let impressions = 0;
  let clicks = 0;

  for (const row of rows) {
    const date = String(row.date_start ?? '');
    if (date < since || date > until) continue;
    const rowSpend = numberValue(row.spend);
    const rowConversations = canonicalConversationAction(row.actions).value;
    const rowImpressions = numberValue(row.impressions);
    const rowClicks = numberValue(row.clicks);
    spend += rowSpend;
    conversations += rowConversations;
    impressions += rowImpressions;
    clicks += rowClicks;
    if (row.campaign_id) {
      const id = String(row.campaign_id);
      campaigns.add(id);
      const current = byCampaign.get(id) ?? {
        id,
        name: String(row.campaign_name || id),
        spend: 0,
        conversations: 0,
        impressions: 0,
        clicks: 0,
        deliveryDates: new Set<string>(),
      };
      current.spend += rowSpend;
      current.conversations += rowConversations;
      current.impressions += rowImpressions;
      current.clicks += rowClicks;
      if (date) current.deliveryDates.add(date);
      byCampaign.set(id, current);
    }
    const daily = byDate.get(date) ?? {
      date,
      spend: 0,
      conversations: 0,
      impressions: 0,
      clicks: 0,
    };
    daily.spend += rowSpend;
    daily.conversations += rowConversations;
    daily.impressions += rowImpressions;
    daily.clicks += rowClicks;
    byDate.set(date, daily);
  }

  const roundedSpend = Math.round(spend * 100) / 100;
  return {
    spend: roundedSpend,
    conversations: Math.round(conversations),
    campaigns: campaigns.size,
    impressions: Math.round(impressions),
    clicks: Math.round(clicks),
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 10_000) / 100 : null,
    cost_per_conversation: conversations > 0
      ? Math.round((roundedSpend / conversations) * 100) / 100
      : null,
    daily: [...byDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((row) => ({
        ...row,
        spend: Math.round(row.spend * 100) / 100,
        impressions: Math.round(row.impressions),
        clicks: Math.round(row.clicks),
      })),
    campaign_rows: [...byCampaign.values()]
      .map((row) => {
        const rounded = Math.round(row.spend * 100) / 100;
        const dates = [...row.deliveryDates].sort();
        return {
          id: row.id,
          name: row.name,
          spend: rounded,
          conversations: Math.round(row.conversations),
          impressions: Math.round(row.impressions),
          clicks: Math.round(row.clicks),
          ctr: row.impressions > 0
            ? Math.round((row.clicks / row.impressions) * 10_000) / 100
            : null,
          cost_per_conversation: row.conversations > 0
            ? Math.round((rounded / row.conversations) * 100) / 100
            : null,
          delivery_days: dates.length,
          last_delivery: dates.at(-1) ?? until,
        };
      })
      .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name)),
  };
}
