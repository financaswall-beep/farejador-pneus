import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let getMarketingIntegrations: typeof import('../../../src/admin/painel/queries-marketing-integrations.js').getMarketingIntegrations;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
  ({ getMarketingIntegrations } = await import('../../../src/admin/painel/queries-marketing-integrations.js'));
});

function overview(meta: 'connected' | 'disabled', ctwa: number) {
  return {
    environment: 'test',
    generated_at: '2026-07-26T12:00:00.000Z',
    period: { id: '30d', days: 30, since: '2026-06-27', until: '2026-07-26' },
    connection: {
      meta,
      meta_synced_at: meta === 'connected' ? '2026-07-26T11:35:00.000Z' : null,
      attribution: 'disabled',
      capi: 'disabled',
    },
    metrics: {
      investment: meta === 'connected' ? 100 : null,
      campaigns: meta === 'connected' ? 2 : null,
      conversations: meta === 'connected' ? 12 : null,
      cost_per_conversation: meta === 'connected' ? 8.33 : null,
      attributed_sales: null,
      profit: null,
    },
    series: [],
    comparison: {
      available: false, previous: null, spend_delta_percent: null,
      conversations_delta_percent: null, reason: 'historico_anterior_insuficiente',
    },
    attribution: {
      available: true, referrals: ctwa, tracked: ctwa,
      ctwa, messenger: 0, instagram: 0,
    },
    alerts: [],
    channels: [],
    quality: [],
  };
}

describe('Marketing — integrações read-only', () => {
  it('mascara a conta, expõe sincronização real e mantém resultado bloqueado', async () => {
    const overviewProvider = vi.fn().mockResolvedValue(overview('connected', 0));
    const auditProvider = vi.fn().mockResolvedValue([
      { id: 'evt-1', event_type: 'marketing_sync', actor_label: 'Sistema', created_at: '2026-07-26T11:35:00.000Z' },
    ]);
    const payload = await getMarketingIntegrations('30d', {
      dbPool: {} as Pool,
      overviewProvider,
      auditProvider,
      healthProvider: vi.fn().mockResolvedValue({
        available: true,
        last_sync_at: '2026-07-26T11:35:00.000Z',
        last_sync_status: 'succeeded',
        rows_upserted: 12,
        capi: { pending: 0, sent: 0, failed: 0, dead_letter: 0, suppressed: 0 },
      }),
      config: { adAccountId: 'act_123456789' },
    });

    expect(payload.summary).toMatchObject({
      connected: 1,
      total: 3,
      last_sync_at: '2026-07-26T11:35:00.000Z',
      critical_pending: 1,
    });
    expect(payload.platforms[0]).toMatchObject({
      id: 'meta',
      status: 'connected',
      account_masked: 'act_••••6789',
    });
    expect(payload.platforms[1]?.status).toBe('not_connected');
    expect(payload.platforms[2]?.status).toBe('planned');
    expect(payload.pipeline.at(-1)).toMatchObject({ id: 'profit', status: 'blocked' });
    expect(payload.audit_events).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain('123456789');
  });

  it('não inventa sincronização ou auditoria quando a integração está desligada', async () => {
    const payload = await getMarketingIntegrations('7d', {
      dbPool: {} as Pool,
      overviewProvider: vi.fn().mockResolvedValue(overview('disabled', 0)),
      auditProvider: vi.fn().mockResolvedValue([]),
      config: {},
    });

    expect(payload.summary.connected).toBe(0);
    expect(payload.summary.last_sync_at).toBeNull();
    expect(payload.platforms[0]?.account_masked).toBeNull();
    expect(payload.platforms[0]?.imported).toEqual([]);
    expect(payload.audit_events).toEqual([]);
  });

  it('não pinta atribuição, lucro ou coleta de verde só porque há referral', async () => {
    const withReferral = overview('connected', 2);
    withReferral.connection.attribution = 'enabled';
    const payload = await getMarketingIntegrations('30d', {
      dbPool: {} as Pool,
      overviewProvider: vi.fn().mockResolvedValue(withReferral),
      auditProvider: vi.fn().mockResolvedValue([]),
      healthProvider: vi.fn().mockResolvedValue({
        available: true,
        last_sync_at: '2026-07-26T11:35:00.000Z',
        last_sync_status: 'failed',
        rows_upserted: 0,
        capi: { pending: 0, sent: 0, failed: 0, dead_letter: 0, suppressed: 0 },
      }),
      config: { adAccountId: 'act_1' },
    });

    expect(payload.pipeline.find((row) => row.id === 'collection')?.status).toBe('pending');
    expect(payload.pipeline.find((row) => row.id === 'attribution')?.status).toBe('pending');
    expect(payload.pipeline.find((row) => row.id === 'profit')?.status).toBe('blocked');
    expect(payload.quality.find((row) => row.id === 'sync')?.status).toBe('error');
    expect(payload.summary.critical_pending).toBeGreaterThan(0);
  });
});
