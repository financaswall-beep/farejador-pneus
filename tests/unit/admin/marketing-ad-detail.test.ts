import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AdDetailDependencies } from '../../../src/admin/painel/queries-marketing-ad-detail.js';
import type { MarketingCreativeRow } from '../../../src/admin/painel/queries-marketing-creatives.js';
let read: typeof import('../../../src/admin/painel/queries-marketing-ad-detail.js').getMarketingAdDetail;
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-only', ADMIN_AUTH_TOKEN: 'test-only', META_ADS_ACCOUNT_ID: 'act_123' });
  ({ getMarketingAdDetail: read } = await import('../../../src/admin/painel/queries-marketing-ad-detail.js'));
});
function ad(id: string, campaign = '10', overrides = {}): MarketingCreativeRow {
  return { id, campaign_id: campaign, campaign_name: campaign, name: id, scope: 'matrix', currency: 'BRL',
    media: null, meta_url: '', preview_url: '', investment: 20, conversations: 4, impressions: 100, clicks: 10,
    cost_per_conversation: 5, tracked: 1, channels: ['whatsapp'], attributed_sales: 1, attributed_revenue: 100,
    gross_margin: 40, net_after_media: 20, pending_margin_orders: 0, attribution_status: 'ready', series: [], ...overrides };
}
function deps(rows = [ad('1')]): AdDetailDependencies {
  return { db: {} as Pool,
    creativesProvider: vi.fn(async () => ({ environment: 'test', generated_at: '', period: { id: '30d', since: '2026-09-01', until: '2026-09-30' },
      available: true, media_status: 'ready', attribution_enabled: true, last_collected: null, creatives: rows })),
    ordersProvider: vi.fn(async () => ({ available: true, total: 1, product_cost: 60, operation_cost: 0, rows: [] })),
    journeysProvider: vi.fn(async () => []),
    conversionsProvider: vi.fn(async () => ({ enabled: true, available: true, sent: 1, pending: 0, failed: 0, suppressed: 0, events: [] })),
  };
}
describe('Detalhe do anúncio usa a atribuição existente', () => {
  it('compara com a razão dos totais da própria campanha, sem campanhas ou moedas estranhas', async () => {
    const providers = deps([ad('1'), ad('2', '10', { investment: 180, conversations: 6 }),
      ad('3', '20', { investment: 99999 }), ad('4', '10', { currency: 'USD', investment: 99999 })]);
    const result = await read('1', '30d', providers);
    expect(result).toMatchObject({ campaign: { id: '10', cost_per_conversation: 20 },
      ad: { gross_margin: 40, net_after_media: 20 }, financial: { product_cost: 60, operation_cost: 0, roas: 5, cost_per_sale: 20 } });
    expect(providers.conversionsProvider).toHaveBeenCalledWith('10', '2026-09-01', '2026-09-30', providers.db, '1');
    expect(providers.ordersProvider).toHaveBeenCalledWith(providers.db, 'test', 'act_123', '1', '2026-09-01', '2026-09-30', expect.any(Boolean));
  });
  it('não consulta dados financeiros de um anúncio inelegível nem transforma ausência em lucro zero', async () => {
    const providers = deps([ad('1', '10', { attribution_status: 'scope_pending', attributed_sales: null, attributed_revenue: null, net_after_media: null })]);
    expect(await read('1', '30d', providers)).toMatchObject({ financial: { product_cost: null, operation_cost: null, roas: null }, orders: { available: false } });
    expect(providers.ordersProvider).not.toHaveBeenCalled();
    expect(providers.journeysProvider).toHaveBeenCalledWith(providers.db, 'test', '1', '2026-09-01', '2026-09-30', false);
  });
  it('omite composição se custo está pendente ou as consultas leram quantidades diferentes', async () => {
    expect(await read('1', '30d', deps([ad('1', '10', { pending_margin_orders: 1 })])))
      .toMatchObject({ financial: { product_cost: null, operation_cost: null } });
    expect(await read('1', '30d', deps([ad('1', '10', { attributed_sales: 2 })])))
      .toMatchObject({ financial: { product_cost: null, operation_cost: null } });
  });
  it('mantém resultado conhecido mesmo quando a consulta das conversas falha', async () => {
    const providers = deps();
    providers.journeysProvider = vi.fn(async () => { throw Error('offline'); });
    expect(await read('1', '30d', providers)).toMatchObject({ ad: { net_after_media: 20 }, journeys: { available: false, rows: [] } });
  });
  it('não inventa anúncio ausente nem divisão quando não há conversas ou investimento', async () => {
    expect(await read('99', '30d', deps())).toBeNull();
    expect(await read('1', '30d', deps([ad('1', '10', { investment: 0, conversations: 0 })])))
      .toMatchObject({ campaign: { cost_per_conversation: null }, financial: { roas: null } });
  });
});
