import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let getMarketingJourneys: typeof import('../../../src/admin/painel/queries-marketing-journeys.js').getMarketingJourneys;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
  ({ getMarketingJourneys } = await import('../../../src/admin/painel/queries-marketing-journeys.js'));
});

function poolWithJourney(row: Record<string, unknown>) {
  const query = vi.fn().mockResolvedValue({ rows: [row] });
  return { pool: { query } as unknown as Pool, query };
}

function metaSnapshot() {
  return {
    current: {
      spend: 120,
      conversations: 40,
      campaigns: 1,
      cost_per_conversation: 3,
      daily: [],
      campaign_rows: [{
        id: 'campaign-1',
        name: 'WhatsApp • Julho',
        spend: 120,
        conversations: 40,
        cost_per_conversation: 3,
        delivery_days: 7,
        last_delivery: '2026-07-25',
      }],
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
  };
}

describe('Marketing — Jornadas rastreáveis', () => {
  it('mostra CTWA, mas mantém venda e receita bloqueadas enquanto a atribuição está desligada', async () => {
    const secret = 'token-somente-no-servidor';
    const { pool, query } = poolWithJourney({
      referrals: 3,
      tracked: 3,
      ctwa: 2,
      qualified: 2,
      quotes: 1,
      order_intents: 1,
    });
    const metaProvider = vi.fn().mockResolvedValue(metaSnapshot());

    const payload = await getMarketingJourneys('30d', {
      dbPool: pool,
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

    expect(payload.metrics).toMatchObject({
      conversations: 40,
      ctwa: 2,
      tracked: 3,
      tracking_coverage_percent: 7.5,
      attributed_sales: null,
      attributed_revenue: null,
    });
    expect(payload.stages.find((row) => row.id === 'sale')).toMatchObject({
      value: null,
      status: 'blocked',
    });
    expect(payload.bottleneck.id).toBe('attribution_disabled');
    expect(payload.campaigns[0]).toMatchObject({
      ctwa: null,
      attributed_sales: null,
      bottleneck: 'campaign_mapping_pending',
    });
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(payload.environment);
    expect(query.mock.calls[0]?.[0]).not.toContain('AS attributed_sales');
    expect(query.mock.calls[0]?.[0]).not.toContain('o.source_conversation_id');
    expect(JSON.stringify(payload)).not.toContain(secret);
  });

  it('libera somente eventos posteriores ao CTWA quando a atribuição foi validada', async () => {
    const { pool } = poolWithJourney({
      referrals: 4,
      tracked: 4,
      ctwa: 4,
      qualified: 3,
      quotes: 2,
      order_intents: 2,
    });

    const payload = await getMarketingJourneys('7d', {
      dbPool: pool,
      now: new Date('2026-07-25T12:00:00.000Z'),
      config: {
        metaEnabled: true,
        attributionEnabled: true,
        accessToken: 'server-only',
        adAccountId: 'act_123',
        apiVersion: 'v21.0',
      },
      metaProvider: vi.fn().mockResolvedValue(metaSnapshot()),
      attributionProvider: vi.fn().mockResolvedValue({
        available: true,
        referrals: 4,
        total_realized_orders: 2,
        orders_with_conversation: 2,
        attributed_sales: 1,
        attributed_revenue: 320,
        gross_margin: 100,
        pending_margin_orders: 0,
        campaigns: [{
          campaign_id: 'campaign-1',
          attributed_sales: 1,
          attributed_revenue: 320,
          gross_margin: 100,
          pending_margin_orders: 0,
        }],
      }),
    });

    expect(payload.quality.attribution_reliable).toBe(true);
    expect(payload.metrics.attributed_sales).toBe(1);
    expect(payload.metrics.attributed_revenue).toBe(320);
    expect(payload.stages.map((row) => row.value)).toEqual([40, 4, 3, 2, 2, 1]);
    expect(payload.bottleneck.id).toBe('journey_active');
  });

  it('não distribui CTWA por campanha quando não existe chave de anúncio para conciliar', async () => {
    const { pool } = poolWithJourney({
      referrals: 0,
      tracked: 0,
      ctwa: 0,
      qualified: 0,
      quotes: 0,
      order_intents: 0,
    });

    const payload = await getMarketingJourneys('30d', {
      dbPool: pool,
      now: new Date('2026-07-25T12:00:00.000Z'),
      config: {
        metaEnabled: true,
        attributionEnabled: false,
        accessToken: 'server-only',
        adAccountId: 'act_123',
        apiVersion: 'v21.0',
      },
      metaProvider: vi.fn().mockResolvedValue(metaSnapshot()),
    });

    expect(payload.bottleneck.id).toBe('ctwa_missing');
    expect(payload.campaigns[0]?.ctwa).toBe(0);
    expect(payload.campaigns[0]?.attributed_sales).toBeNull();
  });
});
