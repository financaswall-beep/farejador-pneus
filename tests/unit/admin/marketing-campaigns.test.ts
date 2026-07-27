import { beforeAll, describe, expect, it, vi } from 'vitest';

let getMarketingCampaigns: typeof import('../../../src/admin/painel/queries-marketing-campaigns.js').getMarketingCampaigns;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
  ({ getMarketingCampaigns } = await import('../../../src/admin/painel/queries-marketing-campaigns.js'));
});

describe('Marketing — campanhas multicanal', () => {
  it('individualiza a Meta sem liberar venda, lucro ou estoque não conciliados', async () => {
    const secret = 'segredo-que-fica-no-servidor';
    const metaProvider = vi.fn().mockResolvedValue({
      current: {
        spend: 150,
        conversations: 10,
        campaigns: 2,
        cost_per_conversation: 15,
        daily: [],
        campaign_rows: [
          {
            id: 'camp-1',
            name: '205/55 R16 • Curitiba',
            spend: 100,
            conversations: 10,
            cost_per_conversation: 10,
            delivery_days: 4,
            last_delivery: '2026-07-25',
          },
          {
            id: 'camp-2',
            name: 'Remarketing • Carrinho',
            spend: 50,
            conversations: 0,
            cost_per_conversation: null,
            delivery_days: 2,
            last_delivery: '2026-07-24',
          },
        ],
      },
      previous: {
        spend: 0,
        conversations: 0,
        campaigns: 0,
        cost_per_conversation: null,
        daily: [],
        campaign_rows: [],
      },
      fetched_at: '2026-07-25T12:00:00.000Z',
    });

    const payload = await getMarketingCampaigns('30d', 'meta', {
      now: new Date('2026-07-25T12:00:00.000Z'),
      config: {
        metaEnabled: true,
        attributionEnabled: false,
        accessToken: secret,
        adAccountId: 'act_123',
        apiVersion: 'v21.0',
      },
      metaProvider,
    });

    expect(payload.selected_channel).toBe('meta');
    expect(payload.connected_channels).toEqual(['meta']);
    expect(payload.metrics).toMatchObject({
      investment: 150,
      campaigns: 2,
      conversations: 10,
      attributed_sales: null,
      profit: null,
    });
    expect(payload.campaigns[0]).toMatchObject({
      id: 'meta:camp-1',
      channel: 'meta',
      attributed_sales: null,
      profit: null,
      stock_status: 'not_reconciled',
      cost_status: 'disabled',
      attribution_status: 'disabled',
    });
    expect(payload.campaigns[1]?.decision.id).toBe('review');
    expect(JSON.stringify(payload)).not.toContain(secret);
  });

  it('não inventa consolidação para Google ou TikTok desconectados', async () => {
    const google = await getMarketingCampaigns('7d', 'google', {
      now: new Date('2026-07-25T12:00:00.000Z'),
      config: {
        metaEnabled: false,
        attributionEnabled: false,
        apiVersion: 'v21.0',
      },
    });
    const tiktok = await getMarketingCampaigns('7d', 'tiktok', {
      now: new Date('2026-07-25T12:00:00.000Z'),
      config: {
        metaEnabled: false,
        attributionEnabled: false,
        apiVersion: 'v21.0',
      },
    });

    expect(google.metrics.investment).toBeNull();
    expect(google.campaigns).toEqual([]);
    expect(google.alerts[0]?.id).toBe('google-not-connected');
    expect(tiktok.metrics.conversations).toBeNull();
    expect(tiktok.campaigns).toEqual([]);
    expect(tiktok.alerts[0]?.id).toBe('tiktok-planned');
  });
});
