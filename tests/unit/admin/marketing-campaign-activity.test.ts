import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
let load: typeof import('../../../src/admin/painel/queries-marketing-campaign-activity.js').loadCampaignConversions;
let enrich: typeof import('../../../src/admin/painel/queries-marketing-campaign-detail-enrichment.js').buildCampaignDetailEnrichment;
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-only', ADMIN_AUTH_TOKEN: 'test-only', META_ADS_ACCOUNT_ID: 'act_123' });
  ({ loadCampaignConversions: load } = await import('../../../src/admin/painel/queries-marketing-campaign-activity.js'));
  ({ buildCampaignDetailEnrichment: enrich } = await import('../../../src/admin/painel/queries-marketing-campaign-detail-enrichment.js'));
});
describe('Detalhe da campanha: consultas de apoio', () => {
  it('isola ambiente, conta, campanha e período, sem retornar payloads de conversão', async () => {
    const query = vi.fn(async () => ({ rows: [{ sent: 3, pending: 1, failed: 0, suppressed: 0, events: [] }] }));
    expect(await load('42', '2026-09-01', '2026-09-30', { query } as unknown as Pool)).toMatchObject({
      available: true, sent: 3, pending: 1, failed: 0,
    });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(['test', '42', '2026-09-01', '2026-09-30', 'act_123', null]);
    expect(sql).not.toMatch(/c\.payload|last_error_summary|INSERT|UPDATE|DELETE/);
    expect(sql).toContain('mi.campaign_id=$2');
    expect(sql).toContain('c.environment=$1');
  });
  it('não inventa contagens quando o banco falha', async () => {
    const query = vi.fn(async () => { throw new Error('database unavailable'); });
    expect(await load('42', '2026-09-01', '2026-09-30', { query } as unknown as Pool)).toMatchObject({
      available: false, sent: null, pending: null, failed: null, events: [],
    });
  });
  it('mantém valores de anúncios indisponíveis se a leitura dos pedidos falha', async () => {
    const result = await enrich({ campaignId: '42', since: '2026-09-01', until: '2026-09-30',
      dbPool: {} as Pool, attributionStatus: 'ready', investment: 20, conversations: 4,
      attributed: { campaign_id: '42', attributed_sales: 1, attributed_revenue: 100, gross_margin: 40, pending_margin_orders: 0 },
      ads: [{ id: '1', name: 'Anúncio', investment: 20 }],
      dataProvider: async () => ({ available: false, referrals: 0, orders: [] }),
    });
    expect(result.ads[0]).toMatchObject({ attributed_sales: null, gross_margin: null, net_after_media: null });
    expect(result.quality.complete_cost_orders).toBeNull();
    expect(result.financial.net_after_media).toBe(20);
  });
});
