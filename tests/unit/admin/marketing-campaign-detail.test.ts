import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { derivedMetrics } from '../../../src/admin/painel/queries-marketing-campaign-detail-metrics.js';

let getMarketingCampaignDetail:
  typeof import('../../../src/admin/painel/queries-marketing-campaign-detail.js').getMarketingCampaignDetail;
let loadCampaignAttributionDetailData:
  typeof import('../../../src/admin/painel/queries-marketing-campaign-detail-data.js').loadCampaignAttributionDetailData;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
  ({ getMarketingCampaignDetail } = await import(
    '../../../src/admin/painel/queries-marketing-campaign-detail.js'
  ));
  ({ loadCampaignAttributionDetailData } = await import(
    '../../../src/admin/painel/queries-marketing-campaign-detail-data.js'
  ));
});

function action(action_type: string, value: number) {
  return { action_type, value: String(value) };
}

describe('Marketing — detalhe da campanha', () => {
  it('nunca exibe taxa de resposta acima de 100% quando a Meta duplica ações', () => {
    expect(derivedMetrics({
      spend: 100, impressions: 1000, clicks: 20, conversations: 4,
      firstReplies: 7, linkClicks: 10, videoViews: 0, postEngagements: 0,
    })).toMatchObject({
      conversations_started: 4,
      first_replies: 4,
      unanswered: 0,
      response_rate: 100,
      cost_per_replied: 25,
    });
  });

  it('carrega referências multicanal e pedidos atribuídos da campanha, sem dados do cliente', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('count(*)::int AS referrals')) {
        return { rows: [{ referrals: 4 }] };
      }
      return {
        rows: [{
          order_number: 'PED-10482',
          realized_at: '2026-07-25T10:00:00.000Z',
          referral_captured_at: '2026-07-25T08:00:00.000Z',
          source_id: 'ad-1',
          ad_id: 'ad-1',
          revenue: '890',
          product_cost: '520',
          operation_cost: '50',
          gross_margin: '320',
          cost_complete: true,
          time_to_sale_minutes: '120',
        }],
      };
    });

    const payload = await loadCampaignAttributionDetailData(
      'camp-1',
      '2026-07-01',
      '2026-07-25',
      { query } as unknown as Pool,
    );

    expect(payload).toEqual({
      available: true,
      referrals: 4,
      orders: [{
        order_number: 'PED-10482',
        realized_at: '2026-07-25T10:00:00.000Z',
        origin: 'WhatsApp',
        ad_id: 'ad-1',
        revenue: 890,
        product_cost: 520,
        operation_cost: 50,
        gross_margin: 320,
        cost_complete: true,
        time_to_sale_minutes: 120,
        status: 'confirmed',
      }],
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(payload)).not.toMatch(/contact|phone|email|name/i);
  });

  it('cruza entrega, resposta Meta e financeiro atribuído sem inventar valores', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          entity_level: 'campaign', entity_id: 'camp-1', entity_name: 'WhatsApp',
          campaign_id: 'camp-1', campaign_name: 'WhatsApp', adset_id: null, adset_name: null,
          metric_date: '2026-07-24', account_currency: 'BRL', spend: '40',
          impressions: '4000', clicks: '100', conversations: '12',
          actions_raw: [
            action('onsite_conversion.messaging_first_reply', 8),
            action('link_click', 40), action('video_view', 800),
          ],
        },
        {
          entity_level: 'campaign', entity_id: 'camp-1', entity_name: 'WhatsApp',
          campaign_id: 'camp-1', campaign_name: 'WhatsApp', adset_id: null, adset_name: null,
          metric_date: '2026-07-25', account_currency: 'BRL', spend: '60',
          impressions: '6000', clicks: '200', conversations: '18',
          actions_raw: [
            action('onsite_conversion.messaging_first_reply', 13),
            action('link_click', 70), action('post_engagement', 500),
          ],
        },
        {
          entity_level: 'ad', entity_id: 'ad-1', entity_name: 'Criativo 01',
          campaign_id: 'camp-1', campaign_name: 'WhatsApp', adset_id: 'set-1',
          adset_name: 'Público local', metric_date: '2026-07-25',
          account_currency: 'BRL', spend: '60', impressions: '6000', clicks: '200',
          conversations: '18',
          actions_raw: [action('onsite_conversion.messaging_first_reply', 13)],
        },
      ],
    });
    const attributionProvider = vi.fn().mockResolvedValue({
      available: true,
      referrals: 3,
      total_realized_orders: 2,
      orders_with_conversation: 2,
      attributed_sales: 2,
      attributed_revenue: 500,
      gross_margin: 200,
      pending_margin_orders: 0,
      campaigns: [{
        campaign_id: 'camp-1',
        attributed_sales: 2,
        attributed_revenue: 500,
        gross_margin: 200,
        pending_margin_orders: 0,
      }],
    });
    const attributionDetailProvider = vi.fn().mockResolvedValue({
      available: true,
      referrals: 3,
      orders: [
        {
          order_number: 'PED-1', realized_at: '2026-07-25T10:00:00.000Z',
          origin: 'WhatsApp', ad_id: 'ad-1', revenue: 300, product_cost: 150,
          operation_cost: 30, gross_margin: 120, cost_complete: true,
          time_to_sale_minutes: 120, status: 'confirmed',
        },
        {
          order_number: 'PED-2', realized_at: '2026-07-24T10:00:00.000Z',
          origin: 'WhatsApp', ad_id: 'ad-1', revenue: 200, product_cost: 100,
          operation_cost: 20, gross_margin: 80, cost_complete: true,
          time_to_sale_minutes: 60, status: 'confirmed',
        },
      ],
    });

    const payload = await getMarketingCampaignDetail('camp-1', '30d', {
      now: new Date('2026-07-25T12:00:00.000Z'),
      dbPool: { query } as unknown as Pool,
      config: { attributionEnabled: true },
      attributionProvider,
      attributionDetailProvider,
    });

    expect(payload?.campaign).toMatchObject({ id: 'camp-1', name: 'WhatsApp' });
    expect(payload?.summary).toMatchObject({
      investment: 100,
      impressions: 10_000,
      clicks: 300,
      link_clicks: 110,
      conversations_started: 30,
      first_replies: 21,
      unanswered: 9,
      response_rate: 70,
      cost_per_started: 3.33,
      cost_per_replied: 4.76,
      unanswered_investment: 30,
    });
    expect(payload?.financial).toEqual({
      attributed_sales: 2,
      attributed_revenue: 500,
      product_cost: 250,
      operation_cost: 50,
      gross_margin: 200,
      pending_margin_orders: 0,
      net_after_media: 100,
      retained_percent: 20,
      roas: 5,
      cac: 50,
    });
    expect(payload?.ads[0]).toMatchObject({
      id: 'ad-1',
      name: 'Criativo 01',
      conversations_started: 18,
      first_replies: 13,
      attributed_sales: 2,
      attributed_revenue: 500,
      gross_margin: 200,
      net_after_media: 140,
      roas: 8.33,
    });
    expect(payload?.quality).toEqual({
      conversations_meta: 30,
      ctwa_referrals: 3,
      attributed_sales: 2,
      complete_cost_orders: 2,
      conversion_rate: 66.7,
    });
    expect(payload?.orders).toHaveLength(2);
  });

  it('mantém vendas e lucro nulos quando a atribuição está desligada', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        entity_level: 'campaign', entity_id: 'camp-1', entity_name: 'WhatsApp',
        campaign_id: 'camp-1', campaign_name: 'WhatsApp', adset_id: null, adset_name: null,
        metric_date: '2026-07-25', account_currency: 'BRL', spend: '10',
        impressions: '100', clicks: '5', conversations: '2', actions_raw: [],
      }],
    });

    const payload = await getMarketingCampaignDetail('camp-1', '7d', {
      now: new Date('2026-07-25T12:00:00.000Z'),
      dbPool: { query } as unknown as Pool,
      config: { attributionEnabled: false },
      attributionDetailProvider: vi.fn().mockResolvedValue({
        available: true,
        referrals: 0,
        orders: [],
      }),
    });

    expect(payload?.attribution.status).toBe('disabled');
    expect(payload?.financial).toEqual({
      attributed_sales: null,
      attributed_revenue: null,
      product_cost: null,
      operation_cost: null,
      gross_margin: null,
      pending_margin_orders: null,
      net_after_media: null,
      retained_percent: null,
      roas: null,
      cac: null,
    });
  });

  it('retorna nulo quando a campanha não tem entrega no período', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const payload = await getMarketingCampaignDetail('missing', '7d', {
      now: new Date('2026-07-25T12:00:00.000Z'),
      dbPool: { query } as unknown as Pool,
      config: { attributionEnabled: false },
    });
    expect(payload).toBeNull();
  });
});
