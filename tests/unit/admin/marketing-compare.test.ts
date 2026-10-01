import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const period = { id: '30d', since: '2026-09-01', until: '2026-09-03' };
const ad = (id: string, scope = 'matrix') => ({ id, scope, name: `Anúncio ${id}`, campaign_name: '2W',
  currency: 'BRL', investment: 100, conversations: 10, cost_per_conversation: 10, impressions: 1000,
  clicks: 20, attributed_sales: 2, attributed_revenue: 400, net_after_media: 160, tracked: 8,
  series: [{ date: period.since, spend: 20, conversations: 2 }, { date: period.until, spend: 80, conversations: 0 }] });
const report = (ads = [ad('a'), ad('b')], dates = period) => ({ available: true, period: dates, creatives: ads });
const detail = (item = ad('a'), dates = period) => ({ available: true, period: dates, ad: item,
  financial: { product_cost: 120, operation_cost: 20 } });
function app() {
  const window = { PAINEL_MODULES: {} as Record<string, () => any>, _paidComparisonChart: null as any };
  const link = { href: '', download: '', click: vi.fn() };
  const urls = { createObjectURL: vi.fn((_blob: Blob) => 'blob:comparison'), revokeObjectURL: vi.fn() };
  const document = { activeElement: { focus: vi.fn() }, querySelector: () => null,
    getElementById: () => ({ focus: vi.fn() }), createElement: () => link };
  const charts: any[] = [];
  for (const module of ['compare', 'compare.view']) runInNewContext(
    readFileSync(`painel/public/app.marketing.${module}.js`, 'utf8'), {
      window, document, lucide: { createIcons: vi.fn() }, Blob, URL: urls, setTimeout: (fn: () => void) => fn(),
      Chart: class { constructor(_el: unknown, config: unknown) { charts.push(config); } destroy() {} },
    });
  const state: any = { ...window.PAINEL_MODULES.marketingCompare(), ...window.PAINEL_MODULES.marketingCompareView(),
    marketingTab: 'criativos', marketingCreativeScope: 'matrix', paidScope: 'matrix', marketingPeriod: '30d',
    marketingIsMock: () => false, marketingDateLabel: (date: string) => date, $nextTick: (fn: () => void) => fn(),
    marketingCreativeMoney: (value: number | null, currency = 'BRL') => value == null ? '—' : `${currency} ${value}`,
    apiGet: vi.fn(async (url: string) => url.includes('/detail?') ? detail(ad(url.includes('/a/') ? 'a' : 'b')) : report()),
    loadMarketing: vi.fn(), loadMarketingCampaignDetail: vi.fn(), loadMarketingCreatives: vi.fn(),
    madClose: vi.fn(function (this: any) { this.madId = null; }), madOpen: vi.fn(),
  };
  return { state, charts, window, link, urls };
}

describe('Comparação A/B de anúncios', () => {
  it('abre usando os mesmos endpoints de leitura, conserva a ordem selecionada e permite trocar A/B', async () => {
    const { state } = app();
    await state.paidCompare(['b', 'a', 'missing']);
    expect(state.paidCompareIds).toEqual(['b', 'a']);
    expect(state.apiGet.mock.calls.map(([url]: [string]) => url)).toEqual([
      '/admin/api/marketing/creatives?period=30d',
      '/admin/api/marketing/creatives/b/detail?period=30d', '/admin/api/marketing/creatives/a/detail?period=30d',
    ]);
    state.pcSwap();
    expect(state.paidCompared().map((row: any) => row.id)).toEqual(['a', 'b']);
    expect(state.apiGet).toHaveBeenCalledTimes(3);
    state.pcSelect(0, 'b');
    expect(state.paidCompareIds).toEqual(['b', 'a']);
  });
  it('não usa dados de uma campanha anterior ao abrir pela visão geral', async () => {
    const { state } = app(); state.marketingTab = 'visao';
    state.marketingCampaignDetail = { campaign: { scope: 'external' } };
    await state.paidCompare();
    expect(state.pcScope).toBe('matrix'); expect(state.paidCompareIds).toEqual(['a', 'b']);
  });
  it('escopo sem anúncios fica vazio e externo não inventa vendas ou financeiro da Matriz', async () => {
    const { state } = app(); await state.paidCompare();
    state.pcScope = 'external'; await state.pcScopeChanged();
    expect(state.paidCompared()).toEqual([]);
    expect(state.pcEmptyMessage()).toContain('externo');
    const external = { ...ad('e', 'external'), attributed_sales: null, attributed_revenue: null, net_after_media: null };
    state.paidCompareData.creatives.push(external); state.pcReconcile();
    expect(state.paidCompareIds).toEqual(['e']);
    expect(state.pcRows().find((r: any) => r.result).values).toEqual(['—', '—']);
    state.pcSelect(1, 'not-available'); expect(state.paidCompareIds).toEqual(['e']);
  });
  it('preserva resultado do motor, incluindo repasses, e não transforma custo indisponível em zero', async () => {
    const { state } = app(); await state.paidCompare();
    const row = (label: string) => state.pcRows().find((r: any) => r.label === label);
    expect(row('Custo dos pneus').values).toEqual(['BRL -120', 'BRL -120']);
    expect(row('Repasses e operação').values).toEqual(['BRL -20', 'BRL -20']);
    expect(row('Resultado após mídia').values).toEqual(['BRL 160', 'BRL 160']);
    state.pcDetails.a.financial.product_cost = null;
    state.pcDetails.a.ad.net_after_media = null;
    state.pcDetails.b.ad.net_after_media = 0;
    expect(row('Custo dos pneus').values[0]).toBe('—');
    expect(row('Resultado após mídia').values).toEqual(['—', 'BRL 0']);
    expect(state.pcHighlight(1)).toBe(false);
    expect(state.pcObservations().some((r: any) => r.text.includes('a mais de resultado'))).toBe(false);
  });
  it('mantém a leitura do outro anúncio quando uma composição falha e permite tentar de novo', async () => {
    const { state } = app();
    state.apiGet = vi.fn(async (url: string) => {
      if (url.includes('/a/detail')) throw Error('unavailable');
      return url.includes('/b/detail') ? detail(ad('b')) : report();
    });
    await state.paidCompare();
    expect(Object.keys(state.pcDetailErrors)).toEqual(['a']);
    expect(state.pcCost(0, 'product_cost')).toBeNull(); expect(state.pcCost(1, 'product_cost')).toBe(120);
    state.apiGet = vi.fn(async (url: string) => detail(ad(url.includes('/a/') ? 'a' : 'b')));
    await state.pcLoadDetails(); expect(state.pcDetailErrors).toEqual({});
  });
  it('não mistura composição de outro anúncio ou intervalo mesmo com resposta HTTP válida', async () => {
    const { state } = app();
    state.apiGet = vi.fn(async (url: string) => url.includes('/detail')
      ? detail(ad('other'), { ...period, until: '2026-09-04' }) : report());
    await state.paidCompare();
    expect(Object.keys(state.pcDetailErrors)).toEqual(['a', 'b']); expect(state.pcDetails).toEqual({});
  });
  it('descarta resposta atrasada ao fechar a tela', async () => {
    const { state } = app(); let finish!: (value: unknown) => void;
    state.apiGet = () => new Promise(resolve => { finish = resolve; });
    const loading = state.paidCompare(); state.paidCloseCompare(false); finish(report()); await loading;
    expect(state.paidCompareOpen).toBe(false); expect(state.paidCompareData).toBeNull();
    expect(state.pcLoading).toBe(false); expect(state.madOpen).not.toHaveBeenCalled();
  });
  it('descarta custos atrasados quando a seleção muda', async () => {
    const { state } = app(); await state.paidCompare();
    const finishes: ((value: unknown) => void)[] = [];
    state.apiGet = () => new Promise(resolve => finishes.push(resolve));
    const loading = state.pcLoadDetails(); state.pcScope = 'pending'; await state.pcScopeChanged();
    finishes.forEach(finish => finish(detail())); await loading;
    expect(state.pcDetails).toEqual({}); expect(state.pcDetailsLoading).toBe(false);
  });
  it('atualiza o período sem reutilizar a resposta anterior ou perder a seleção ainda disponível', async () => {
    const { state } = app(); await state.paidCompare(['b', 'a']);
    state.marketingPeriod = '7d';
    const next = { ...period, id: '7d', since: '2026-09-02' };
    state.apiGet = vi.fn(async (url: string) => url.includes('/detail') ? detail(ad(url.includes('/a/') ? 'a' : 'b'), next) : report(undefined, next));
    await state.pcPeriodChanged();
    expect(state.loadMarketing).toHaveBeenCalledOnce(); expect(state.paidCompareIds).toEqual(['b', 'a']);
    expect(state.paidCompareData.period.id).toBe('7d'); expect(state.pcDetailErrors).toEqual({});
  });
  it('mostra falha ao carregar a lista sem exibir comparação antiga', async () => {
    const { state } = app(); await state.paidCompare();
    state.apiGet = vi.fn(async () => { throw Error('offline'); }); await state.pcLoad();
    expect(state.pcError).toContain('Não foi possível'); expect(state.paidCompared()).toEqual([]);
    expect(state.pcDetails).toEqual({});
  });
  it('volta à análise de origem ou abre uma análise mantendo a comparação', async () => {
    const { state } = app(); state.madId = 'b'; state.madOrigin = 'campaign'; state.madData = detail(ad('b'));
    await state.paidCompare(['b', 'a']); expect(state.madClose).toHaveBeenCalledWith(false);
    state.pcViewAd(0); expect(state.madOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 'compare');
    expect(state.paidCompareOpen).toBe(true);
    state.paidCloseCompare(); expect(state.madOpen).toHaveBeenLastCalledWith({ id: 'b' }, 'campaign');
  });
  it('usa série diária real com lacunas e média ponderada e não desenha moedas incompatíveis', async () => {
    const { state, charts, window } = app(); await state.paidCompare();
    const config = charts.at(-1);
    expect(config.data.labels).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(config.data.datasets[0].data).toEqual([10, null, null]);
    expect(config.data.datasets[0].label).toContain('BRL 10');
    expect(config.data.datasets[0].spanGaps).toBe(false);
    state.pcDetails.b.ad.currency = 'USD'; state.pcRenderChart();
    expect(window._paidComparisonChart).toBeNull(); expect(state.pcChartComparable()).toBe(false);
    expect(state.pcRows().find((r: any) => r.label === 'ROAS').values[1]).toBe('—');
    expect(state.pcObservations().some((r: any) => r.text.includes('Moedas diferentes'))).toBe(true);
    expect(state.pcHighlight(0)).toBe(false);
  });
  it('calcula diferenças só com dados disponíveis e exporta CSV sem fórmulas executáveis', async () => {
    const { state } = app(); await state.paidCompare();
    state.pcDetails.a.ad.net_after_media = 192.5;
    state.pcDetails.a.ad.name = ' =HYPERLINK("bad")';
    expect(state.pcObservations().map((r: any) => r.text)).toContain('A tem BRL 32.5 a mais de resultado após mídia.');
    expect(state.pcHighlight(0)).toBe(true);
    const csv = state.pcCsv();
    expect(csv).toContain("\"' =HYPERLINK(\"\"bad\"\")\"");
    expect(csv).toContain('"Repasses e operação"'); expect(csv).toContain('2026-09-01');
    expect(csv).toContain('"BRL 192.5"'); expect(csv.charCodeAt(0)).toBe(0xfeff);
  });
  it('exporta o arquivo do período apenas com dois anúncios carregados e libera a URL temporária', async () => {
    const { state, link, urls } = app();
    state.pcExport(); expect(link.click).not.toHaveBeenCalled();
    await state.paidCompare(); state.pcDetailsLoading = true;
    state.pcExport(); expect(link.click).not.toHaveBeenCalled();
    state.pcDetailsLoading = false; state.pcExport();
    expect(link.download).toBe('comparacao-anuncios-2026-09-01-2026-09-03.csv');
    expect(link.click).toHaveBeenCalledOnce(); expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:comparison');
    const blob = urls.createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('text/csv;charset=utf-8');
    expect(await blob.text()).toContain('"Anúncio a";"Anúncio b"');
  });
});
