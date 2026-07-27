/** Cruza o detalhe Meta com CTWA, pedidos e margem sem liberar números sem prova. */
import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import type { CampaignAttribution } from '../../marketing/reporting.js';
import {
  loadCampaignAttributionDetailData,
  type CampaignAttributedOrder,
} from './queries-marketing-campaign-detail-data.js';

type AttributionStatus = 'disabled' | 'unavailable' | 'pending' | 'ready';

interface DeliveryAd {
  id: string;
  name: string;
  investment: number;
  [key: string]: unknown;
}

interface EnrichmentInput {
  campaignId: string;
  since: string;
  until: string;
  dbPool: Pool;
  attributionStatus: AttributionStatus;
  attributed?: CampaignAttribution;
  investment: number;
  conversations: number;
  ads: DeliveryAd[];
  dataProvider?: typeof loadCampaignAttributionDetailData;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sum(orders: CampaignAttributedOrder[], field: 'revenue' | 'product_cost' | 'operation_cost' | 'gross_margin') {
  return round(orders.reduce((total, order) => total + Number(order[field] ?? 0), 0));
}

function managerUrl(campaignId: string): string | null {
  const accountId = env.META_ADS_ACCOUNT_ID?.replace(/^act_/, '');
  if (!accountId || !/^\d+$/.test(accountId) || !/^\d+$/.test(campaignId)) return null;
  const url = new URL('https://adsmanager.facebook.com/adsmanager/manage/campaigns');
  url.searchParams.set('act', accountId);
  url.searchParams.set('selected_campaign_ids', campaignId);
  return url.toString();
}

export async function buildCampaignDetailEnrichment(input: EnrichmentInput) {
  const provider = input.dataProvider ?? loadCampaignAttributionDetailData;
  const detail = await provider(input.campaignId, input.since, input.until, input.dbPool);
  const ready = input.attributionStatus === 'ready';
  const visibleOrders = ready ? detail.orders : [];
  const sales = ready ? input.attributed?.attributed_sales ?? 0 : null;
  const revenue = ready ? input.attributed?.attributed_revenue ?? 0 : null;
  const grossMargin = ready ? input.attributed?.gross_margin ?? null : null;
  const pendingMargin = ready ? input.attributed?.pending_margin_orders ?? 0 : null;
  const allCostsMapped = ready
    && detail.available
    && visibleOrders.length === sales
    && visibleOrders.every((order) => order.cost_complete);
  const productCost = allCostsMapped ? sum(visibleOrders, 'product_cost') : null;
  const operationCost = allCostsMapped ? sum(visibleOrders, 'operation_cost') : null;
  const result = grossMargin == null ? null : round(grossMargin - input.investment);
  const adOrders = new Map<string, CampaignAttributedOrder[]>();
  for (const order of visibleOrders) {
    if (!order.ad_id) continue;
    const rows = adOrders.get(order.ad_id) ?? [];
    rows.push(order);
    adOrders.set(order.ad_id, rows);
  }
  const ads = input.ads.map((ad) => {
    if (!ready) {
      return {
        ...ad, attributed_sales: null, attributed_revenue: null,
        gross_margin: null, net_after_media: null, roas: null,
      };
    }
    const orders = adOrders.get(ad.id) ?? [];
    const adRevenue = sum(orders, 'revenue');
    const complete = orders.every((order) => order.cost_complete);
    const adMargin = complete ? sum(orders, 'gross_margin') : null;
    return {
      ...ad,
      attributed_sales: orders.length,
      attributed_revenue: adRevenue,
      gross_margin: adMargin,
      net_after_media: adMargin == null ? null : round(adMargin - ad.investment),
      roas: ad.investment > 0 ? round(adRevenue / ad.investment) : null,
    };
  });
  const completeOrders = ready
    ? visibleOrders.filter((order) => order.cost_complete).length
    : null;
  return {
    manager_url: managerUrl(input.campaignId),
    tracking: {
      available: detail.available,
      ctwa_referrals: detail.available ? detail.referrals : null,
    },
    orders: ready ? visibleOrders.slice(0, 5) : [],
    orders_total: sales,
    quality: {
      conversations_meta: input.conversations,
      ctwa_referrals: detail.available ? detail.referrals : null,
      attributed_sales: sales,
      complete_cost_orders: completeOrders,
      conversion_rate: ready && detail.referrals > 0 && sales != null
        ? round((sales / detail.referrals) * 100, 1)
        : null,
    },
    financial: {
      attributed_sales: sales,
      attributed_revenue: revenue,
      product_cost: productCost,
      operation_cost: operationCost,
      gross_margin: grossMargin,
      pending_margin_orders: pendingMargin,
      net_after_media: result,
      retained_percent: result != null && revenue
        ? round((result / revenue) * 100, 1)
        : null,
      roas: ready && revenue != null && input.investment > 0
        ? round(revenue / input.investment)
        : null,
      cac: ready && sales != null && sales > 0
        ? round(input.investment / sales)
        : null,
    },
    ads,
  };
}
