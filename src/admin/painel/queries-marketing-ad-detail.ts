/** Tela do anúncio: compõe consultas existentes, sem interferir em atribuição ou envio. */
import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { MarketingPeriod } from './marketing-meta.js';
import { getMarketingCreatives } from './queries-marketing-creatives.js';
import { loadCreativeJourneys } from './queries-marketing-creatives-data.js';
import { loadCampaignConversions } from './queries-marketing-campaign-activity.js';
import { loadMarketingAdOrders } from './queries-marketing-ad-orders.js';

export interface AdDetailDependencies {
  db?: Pool;
  creativesProvider?: typeof getMarketingCreatives;
  ordersProvider?: typeof loadMarketingAdOrders;
  journeysProvider?: typeof loadCreativeJourneys;
  conversionsProvider?: typeof loadCampaignConversions;
}
export async function getMarketingAdDetail(adId: string, period: MarketingPeriod, deps: AdDetailDependencies = {}) {
  const db = deps.db ?? pool;
  const report = await (deps.creativesProvider ?? getMarketingCreatives)(period, { dbPool: db });
  if (!report.available) return { available: false };
  const ad = report.creatives.find(row => row.id === adId);
  if (!ad) return null;
  const commercial = ad.attribution_status === 'ready';
  const { since, until } = report.period;
  const [orders, journeys, conversions] = await Promise.all([
    commercial ? (deps.ordersProvider ?? loadMarketingAdOrders)(db, env.FAREJADOR_ENV,
      env.META_ADS_ACCOUNT_ID!, adId, since, until, env.MARKETING_SCOPE_ENFORCEMENT_ENABLED)
      : Promise.resolve({ available: false, total: null, product_cost: null, operation_cost: null, rows: [] }),
    (deps.journeysProvider ?? loadCreativeJourneys)(db, env.FAREJADOR_ENV, adId, since, until, commercial)
      .then(rows => ({ available: true, rows: rows.map(row => ({ ...row,
        sales: commercial ? row.sales : null, revenue: commercial ? row.revenue : null })) }))
      .catch(() => ({ available: false, rows: [] })),
    (deps.conversionsProvider ?? loadCampaignConversions)(ad.campaign_id, since, until, db, adId),
  ]);
  const peers = report.creatives.filter(row => row.campaign_id === ad.campaign_id
    && row.currency === ad.currency && row.scope === ad.scope);
  const spend = peers.reduce((sum, row) => sum + row.investment, 0);
  const conversations = peers.reduce((sum, row) => sum + row.conversations, 0);
  const costsMatch = orders.available && orders.total === ad.attributed_sales && ad.pending_margin_orders === 0;
  let chatwootBase: string | null = null;
  try {
    const base = new URL(env.CHATWOOT_API_BASE_URL || '');
    if (base.protocol === 'https:' && !base.username && !base.password) chatwootBase = base.origin;
  } catch { /* A conversa continua identificada mesmo sem link configurado. */ }
  return {
    available: true, environment: report.environment, generated_at: report.generated_at,
    period: report.period, ad, peers, orders, journeys, conversions, chatwoot_base: chatwootBase,
    campaign: { id: ad.campaign_id, name: ad.campaign_name,
      cost_per_conversation: conversations > 0 ? spend / conversations : null },
    financial: { product_cost: costsMatch ? orders.product_cost : null,
      operation_cost: costsMatch ? orders.operation_cost : null,
      roas: ad.currency === 'BRL' && ad.attributed_revenue != null && ad.investment > 0
        ? ad.attributed_revenue / ad.investment : null,
      cost_per_sale: ad.attributed_sales != null && ad.attributed_sales > 0
        ? ad.investment / ad.attributed_sales : null },
  };
}
