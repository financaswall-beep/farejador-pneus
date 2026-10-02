import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function app() {
  const window = { PAINEL_MODULES: {} as Record<string, () => any> };
  for (const file of ['paid', 'google', 'google.overview', 'google.ads']) {
    runInNewContext(readFileSync(`painel/public/app.marketing.${file}.js`, 'utf8'),
      { window, URL, document: { querySelector: () => null }, lucide: { createIcons() {} } });
  }
  const ads = [
    ['1', 200, 200, 1, 'ENABLED', 'RESPONSIVE_SEARCH_AD', '11', 7],
    ['2', 210, 100, 2.1, 'ENABLED', 'RESPONSIVE_SEARCH_AD', '12', 4.5],
    ['3', 160, 100, 1.6, 'ENABLED', 'IMAGE_AD', '11', 2],
    ['4', 0, 0, null, 'PAUSED', 'RESPONSIVE_SEARCH_AD', '12', 0],
    ['5', 100, 20, 5, 'ENABLED', 'RESPONSIVE_DISPLAY_AD', '12', 1],
  ].map(([id, investment, clicks, cpc, status, format, campaign_id, conversions]) => ({ id: String(id), ad_id: String(id),
    ad_group_id: '22', campaign_id, investment, clicks, cpc, status, format, conversions, impressions: Number(clicks) * 50,
    name: `Pneu ${id}`, campaign_name: `Campanha ${campaign_id}`, headlines: ['Promoção de pneus'],
    descriptions: ['Consulte a medida'], final_url: 'https://2w.example/', image_url: 'https://example.com/tire.jpg' }));
  const financial = [
    { id: '1', attributed_sales: 3, attributed_revenue: 594, gross_margin: 366, tracked_conversations: 20 },
    { id: '2', attributed_sales: 3, attributed_revenue: 594, gross_margin: 343.5, tracked_conversations: 14 },
    { id: '3', attributed_sales: 2, attributed_revenue: 396, gross_margin: 244, tracked_conversations: 10 },
    { id: '5', attributed_sales: 1, attributed_revenue: 198, gross_margin: 150, tracked_conversations: 8 },
  ];
  return Object.assign({}, ...Object.values(window.PAINEL_MODULES).map(factory => factory()), {
    googleAdsReport: { status: 'connected', data: { ads, campaigns: [], account: { name: '2W Pneus' } },
      results: { available: true, ads: financial } }, formatCurrency: (value: number) => `R$ ${value}`,
    $nextTick: (fn: () => void) => fn(), googleExportCells: vi.fn(), renderGoogleOverviewChart: vi.fn(),
  });
}
describe('Google Ads — galeria de anúncios', () => {
  it('totaliza todo o filtro e calcula CPC ponderado, sem converter conversões em vendas', () => {
    const state = app();
    expect(state.googleAdPageRows()).toHaveLength(3);
    expect(state.googleAdSummary()).toMatchObject({ count: 5, investment: 670, clicks: 420, cpc: 1.6,
      sales: 9, conversions: 14.5, revenue: 1782, result: 433.5, ctr: 2 });
    state.googleAdPage = 2;
    expect(state.googleAdPageRows()).toHaveLength(2);
    expect(state.googleAdSummary().investment).toBe(670);
  });
  it('combina busca por texto, campanha, status e formato', () => {
    const state = app();
    state.googleAdsCampaign = '11'; state.googleAdFormat = 'IMAGE_AD'; state.googleAdStatus = 'ENABLED';
    state.googleAdsSearch = 'CONSULTE A MEDIDA';
    expect(state.googleAdRows().map((ad: any) => ad.id)).toEqual(['3']);
    expect(state.googleAdSummary()).toMatchObject({ investment: 160, sales: 2, result: 84 });
    state.googleAdStatus = 'PAUSED'; expect(state.googleAdRows()).toHaveLength(0);
    expect(state.googleAdSummary()).toMatchObject({ count: 0, investment: 0, cpc: null, sales: 0, result: 0 });
  });
  it('mantém custos e apuração indisponíveis como desconhecidos', () => {
    const state = app(); state.googleAdsReport.results.ads[0].gross_margin = null;
    expect(state.googleAdSummary()).toMatchObject({ sales: 9, revenue: 1782, result: null });
    state.googleAdsSearch = 'Pneu 3'; expect(state.googleAdSummary().result).toBe(84);
    state.googleAdsReport.results.available = false;
    expect(state.googleAdSummary()).toMatchObject({ investment: 160, sales: null, revenue: null, result: null, roas: null });
  });
  it('ordena menor CPC e maior resultado com dados ausentes por último', () => {
    const state = app(); expect(state.googleAdRows().map((ad: any) => ad.id)).toEqual(['1', '3', '2', '5', '4']);
    state.googleAdSort = 'result'; state.googleAdsReport.results.ads[0].gross_margin = null;
    expect(state.googleAdRows().map((ad: any) => ad.id)).toEqual(['2', '3', '5', '4', '1']);
  });
  it('pagina além de 90 anúncios e ajusta uma página inválida depois de um filtro', () => {
    const state = app(), template = state.googleAdsReport.data.ads[0];
    state.googleAdsReport.data.ads = Array.from({ length: 98 }, (_, id) => ({ ...template, id: String(id), name: `Pneu ${id}` }));
    state.googleAdPage = 33; expect(state.googleAdPageRows()).toHaveLength(2);
    expect(state.googleAdPages()).toBe(33);
    state.googleAdsSearch = 'Pneu 97'; expect(state.googleAdCurrentPage()).toBe(1);
    expect(state.googleAdPageRows()[0].id).toBe('97');
  });
  it('compara dois anúncios selecionados em filtros e páginas diferentes', () => {
    const state = app(); state.googleToggleAd('1'); state.googleAdPage = 2; state.googleToggleAd('5');
    state.googleAdsSearch = 'Pneu 3'; state.googleToggleAd('3');
    expect(state.googleAdsSelected).toEqual(['1', '5']);
    expect(state.googleAdSelectedRows().map((ad: any) => ad.id)).toEqual(['1', '5']);
    state.googleShowCompare(); expect(state.googleAdsView).toBe('compare');
    expect([state.googleCompareA, state.googleCompareB]).toEqual(['1', '5']);
    expect(state.googleCompareRows().find((row: any) => row.label === 'Resultado após mídia')).toMatchObject({ a: 'R$ 166', b: 'R$ 50' });
  });
  it('exporta todos os anúncios do filtro, e não a página ou campanhas', () => {
    const state = app(); state.googleAdsView = 'ads'; state.googleAdPage = 2; state.googleAdsExport();
    expect(state.googleExportCells.mock.calls[0][0]).toHaveLength(6);
    state.googleAdsCampaign = '11'; state.googleAdsExport();
    expect(state.googleExportCells.mock.calls[1][0]).toHaveLength(3);
  });
  it('mostra Pesquisa em texto e só aceita imagens HTTPS sem credenciais', () => {
    const state = app(), [search, , image] = state.googleAdsReport.data.ads;
    expect(state.googleAdImage(search)).toBe('');
    expect(state.googleAdImage(image)).toBe('https://example.com/tire.jpg');
    for (const url of ['javascript:alert(1)', 'http://example.com/tire.jpg', 'https://key@example.com/tire.jpg']) {
      expect(state.googleAdImage({ ...image, image_url: url })).toBe('');
    }
    state.googleAdImageFailed(image); expect(state.googleAdImage(image)).toBe('');
    image.image_url = 'https://example.com/other.jpg'; expect(state.googleAdImage(image)).toBe(image.image_url);
  });
  it('compara CPC com a média ponderada do filtro e evita divisão por zero', () => {
    const state = app(); expect(state.googleAdCostBadge(state.googleAdsReport.data.ads[0])).toMatchObject({ best: true });
    state.googleAdsSearch = 'Pneu 1'; expect(state.googleAdCostBadge(state.googleAdsReport.data.ads[0]).text).toContain('Sem comparação');
    state.googleAdsSearch = 'Pneu 4'; expect(state.googleAdCostBadge(state.googleAdsReport.data.ads[3]).text).toContain('Sem cliques');
  });
});
