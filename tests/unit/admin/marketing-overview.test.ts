import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let getMarketingOverview: typeof import('../../../src/admin/painel/queries-marketing.js').getMarketingOverview;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
  ({ getMarketingOverview } = await import('../../../src/admin/painel/queries-marketing.js'));
});

function poolWithAttribution(referrals: number, ctwa: number) {
  const query = vi.fn().mockResolvedValue({ rows: [{ referrals, ctwa }] });
  return { pool: { query } as unknown as Pool, query };
}

describe('Marketing overview da matriz', () => {
  it('sobe dormente e não inventa indicadores quando a Meta está desligada', async () => {
    const { pool, query } = poolWithAttribution(3, 1);
    const overview = await getMarketingOverview('30d', {
      dbPool: pool,
      now: new Date('2026-07-25T12:00:00.000Z'),
      config: {
        metaEnabled: false,
        attributionEnabled: false,
        apiVersion: 'v21.0',
      },
    });

    expect(overview.connection).toEqual({
      meta: 'disabled',
      meta_synced_at: null,
      attribution: 'disabled',
      capi: 'disabled',
    });
    expect(overview.metrics).toMatchObject({
      investment: null,
      campaigns: null,
      conversations: null,
      impressions: null,
      clicks: null,
      ctr: null,
      cost_per_conversation: null,
      attributed_sales: null,
      attributed_revenue: null,
      gross_margin: null,
      net_after_media: null,
      profit: null,
    });
    expect(overview.attribution).toEqual({ available: true, referrals: 3, ctwa: 1 });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(overview.environment);
  });

  it('expõe apenas agregados e nunca devolve o token da Meta ao front', async () => {
    const secret = 'token-que-nao-pode-sair-do-servidor';
    const { pool } = poolWithAttribution(4, 2);
    const metaProvider = vi.fn().mockResolvedValue({
      current: {
        spend: 120,
        conversations: 40,
        campaigns: 3,
        cost_per_conversation: 3,
        daily: [{ date: '2026-07-25', spend: 120, conversations: 40 }],
      },
      previous: {
        spend: 100,
        conversations: 20,
        campaigns: 2,
        cost_per_conversation: 5,
        daily: [],
      },
      fetched_at: '2026-07-25T12:00:00.000Z',
    });

    const overview = await getMarketingOverview('7d', {
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

    expect(metaProvider).toHaveBeenCalledOnce();
    expect(overview.connection.meta).toBe('connected');
    expect(overview.connection.meta_synced_at).toBe('2026-07-25T12:00:00.000Z');
    expect(overview.metrics).toMatchObject({
      investment: 120,
      campaigns: 3,
      conversations: 40,
      cost_per_conversation: 3,
      attributed_sales: null,
      profit: null,
    });
    expect(overview.comparison).toMatchObject({
      available: true,
      spend_delta_percent: 20,
      conversations_delta_percent: 100,
    });
    expect(JSON.stringify(overview)).not.toContain(secret);
  });
});
