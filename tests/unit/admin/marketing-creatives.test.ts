import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
let getMarketingCreatives: typeof import('../../../src/admin/painel/queries-marketing-creatives.js').getMarketingCreatives;
beforeAll(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres', CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token' });
  ({ getMarketingCreatives } = await import('../../../src/admin/painel/queries-marketing-creatives.js'));
});
const config = { adAccountId: 'act_123', accessToken: 'private', apiVersion: 'v21.0' };
const insight = { entity_id: '456', entity_name: 'Pneu', campaign_id: '789', campaign_name: 'Campanha', campaign_scope: 'matrix',
  metric_date: '2026-09-12', account_currency: 'BRL', spend: '60', conversations: '10', impressions: 100, clicks: 20, collected_at: '2026-09-12T12:00:00Z' };
function db(scope = 'matrix', tracking = 8, rejectAttribution = false) {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes('WITH ads AS')) {
      if (rejectAttribution) throw Error('unavailable');
      return { rows: [{ ad_id: '456', tracked: tracking, channels: ['whatsapp'], sales: 0, revenue: 0 }] };
    }
    return { rows: [{ ...insight, campaign_scope: scope }, { ...insight, campaign_scope: scope, metric_date: '2026-09-13', conversations: 0, spend: 20 }] };
  }) } as unknown as Pool;
}
describe('Criativos: indicadores e atribuição', () => {
  const common = { now: new Date('2026-09-14T12:00:00Z'), config, attributionEnabled: true,
    enforceScope: true, mediaProvider: async () => ({ ads: [], unavailable: 1 }) };
  it('soma dias somente no anúncio e calcula custo pela razão dos totais', async () => {
    const result = await getMarketingCreatives('7d', { ...common, dbPool: db() });
    expect(result.creatives).toHaveLength(1);
    expect(result.creatives[0]).toMatchObject({ investment: 80, conversations: 10, cost_per_conversation: 8, tracked: 8, attributed_sales: 0, attribution_status: 'ready', media: null });
    expect(result.media_status).toBe('partial');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('mantém ausência de rastreamento diferente de zero vendas', async () => {
    const result = await getMarketingCreatives('7d', { ...common, dbPool: db('matrix', 0) });
    expect(result.creatives[0]).toMatchObject({ attributed_sales: null, attributed_revenue: null, attribution_status: 'pending' });
  });
  it('respeita escopo pendente e flag de atribuição', async () => {
    expect((await getMarketingCreatives('7d', { ...common, dbPool: db('pending') })).creatives[0])
      .toMatchObject({ investment: 80, attributed_sales: null, attribution_status: 'scope_pending' });
    expect((await getMarketingCreatives('7d', { ...common, dbPool: db(), attributionEnabled: false })).creatives[0])
      .toMatchObject({ attributed_sales: null, attribution_status: 'disabled' });
  });
  it('não converte falha da consulta em zero conversas identificadas', async () => {
    expect((await getMarketingCreatives('7d', { ...common, dbPool: db('matrix', 8, true) })).creatives[0])
      .toMatchObject({ tracked: null, attributed_sales: null, attribution_status: 'unavailable' });
  });
});
function front() {
  const context = vm.createContext({ window: { PAINEL_MODULES: {} }, URLSearchParams, location: { search: '' }, document: {}, setTimeout });
  vm.runInContext(readFileSync('painel/public/app.marketing.creatives.js', 'utf8'), context);
  return Object.assign(context.window.PAINEL_MODULES.marketingCreatives(), {
    $nextTick: () => {}, marketingIsMock: () => false, marketingPeriod: '30d',
  });
}
const row = (id: string, cost: number | null, campaign = '1', format = 'image') => ({ id, name: `Pneu ${id}`, cost_per_conversation: cost, campaign_id: campaign, campaign_name: campaign, media: { format }, currency: 'BRL', investment: 20, conversations: 4 });
describe('Criativos: seleção, filtros e carregamento', () => {
  it('coloca custos sem denominador no fim e atualiza seleção ao filtrar/paginar', () => {
    const app = front();
    app.marketingCreativesData = { creatives: [row('1', null), row('2', 4), row('3', 6), row('4', 2, '2', 'video')] };
    app.marketingCreativeReconcile(); expect(app.marketingCreativeSelectedId).toBe('4');
    app.marketingCreativeSetPage(2); expect(app.marketingCreativeSelectedId).toBe('1');
    app.marketingCreativeFormat = 'video'; app.marketingCreativeFiltersChanged();
    expect(app.marketingCreativeSelectedId).toBe('4'); expect(app.marketingCreativePage).toBe(1);
    app.marketingCreativeSearch = 'inexistente'; app.marketingCreativeFiltersChanged();
    expect(app.marketingCreativeSelected()).toBeNull();
  });
  it('não deixa uma resposta antiga substituir o período novo', async () => {
    const app = front(); const resolvers: Array<(data: unknown) => void> = [];
    app.apiGet = () => new Promise((resolve) => resolvers.push(resolve));
    const old = app.loadMarketingCreatives(); app.marketingPeriod = '7d'; const latest = app.loadMarketingCreatives();
    resolvers[1]!({ marker: 'new', creatives: [] }); await latest;
    resolvers[0]!({ marker: 'old', creatives: [] }); await old;
    expect(app.marketingCreativesData.marker).toBe('new');
  });
  it('não mistura investimento de moedas diferentes', () => {
    const app = front(); app.marketingCreativesData = { creatives: [row('1', 5), { ...row('2', 5), currency: 'USD' }] };
    expect(app.marketingCreativeMetrics()).toMatchObject({ investment: null, cost: null, conversations: 8 });
  });
});
