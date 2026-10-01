import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function app() {
  const window = { PAINEL_MODULES: {} as Record<string, () => any> };
  for (const file of ['paid', 'google']) runInNewContext(readFileSync(`painel/public/app.marketing.${file}.js`, 'utf8'),
    { window, document: {}, lucide: { createIcons() {} } });
  return { ...window.PAINEL_MODULES.marketingPaid(), ...window.PAINEL_MODULES.marketingGoogle(),
    marketingPeriod: '30d', marketingCampaignChannel: 'all', marketingIsMock: () => false,
    formatCurrency: (value: number) => `R$ ${value}`, $nextTick: (fn: () => void) => fn(),
    apiGet: vi.fn(), marketingSetTab: vi.fn(), loadMarketing: vi.fn(), marketingCampaignSetChannel: vi.fn() };
}
describe('Google Ads — navegação e estado', () => {
  it('consolida mídia e vendas exclusivas, mantendo custo por conversa somente da Meta',()=>{
    const state=app(),period={since:'2026-09-25',until:'2026-10-01'};
    state.marketingVisao={period,metrics:{investment:100,impressions:1000,clicks:10,conversations:5,cost_per_conversation:20,attributed_sales:1,attributed_revenue:200,gross_margin:120,pending_margin_orders:0}};
    state.googleAdsReport={status:'connected',data:{period,totals:{investment:50,impressions:500,clicks:20}},results:{available:true,totals:{attributed_sales:2,attributed_revenue:300,gross_margin:180,pending_margin_orders:0}}};
    expect(state.paidMetrics()).toMatchObject({investment:150,attributed_sales:3,attributed_revenue:500,net_after_media:150,cost_per_conversation:20,conversations:5,ctr:2});
    state.googleAdsReport.results.totals.gross_margin=null;
    expect(state.paidMetrics().net_after_media).toBeNull();
    state.googleAdsReport.data.period={since:'2026-09-24',until:'2026-09-30'};
    expect(state.paidMetrics().investment).toBeNull();
    state.marketingCampaignChannel='meta';expect(state.paidMetrics().investment).toBe(100);
  });
  it('abre Google dentro de conteúdo pago e mantém a navegação da Meta', () => {
    const state = app(); state.paidChannel('google');
    expect(state.marketingCampaignChannel).toBe('google'); expect(state.marketingSetTab).toHaveBeenCalledWith('visao');
    expect(state.marketingCampaignSetChannel).not.toHaveBeenCalled();
    state.paidChannel('meta'); expect(state.marketingCampaignSetChannel).toHaveBeenCalledWith('meta');
    expect(state.loadMarketing).toHaveBeenCalled();
  });
  it('descarta resposta atrasada de outro período e limpa dados antigos durante consulta', async () => {
    const state = app();
    let resolveOld!: (data: object) => void;
    state.googleAdsReport = { status: 'connected', data: { totals: { investment: 999 } } };
    state.apiGet.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ status: 'connected', data: { totals: { investment: 20 } } });
    const old = state.loadGoogleAds(); expect(state.googleAdsReport).toBeNull();
    state.marketingPeriod = '7d'; await state.loadGoogleAds();
    resolveOld({ status: 'connected', data: { totals: { investment: 999 } } }); await old;
    expect(state.googleAdsReport.data.totals.investment).toBe(20);
    expect(state.googleAdsLoading).toBe(false);
  });
  it('filtra e pagina campanhas sem alterar os totais e não apresenta conversão como venda', () => {
    const state = app(); state.googleAdsReport = { status: 'connected', data: {
      totals: { investment: 200, conversions: 1.5 }, campaigns: Array.from({ length: 20 }, (_, id) => ({ id: String(id), name: `Pneu ${id}` })),
    } };
    expect(state.googleAdsPageRows()).toHaveLength(15); expect(state.googleAdsPages()).toBe(2);
    state.googleAdsSearch = 'Pneu 19'; expect(state.googleAdsRows()).toHaveLength(1);
    expect(state.googleAdsKpis()[0].value).toBe('R$ 200');
    expect(state.googleAdsKpis().some((kpi: any) => /venda|lucro/i.test(kpi.label))).toBe(false);
  });
});
