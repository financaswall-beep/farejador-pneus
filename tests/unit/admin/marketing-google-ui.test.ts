import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function app() {
  const window = { PAINEL_MODULES: {} as Record<string, () => any> };
  for (const file of ['paid', 'google', 'google.overview', 'google.ads']) runInNewContext(readFileSync(`painel/public/app.marketing.${file}.js`, 'utf8'),
    { window, document: {querySelector: () => null}, lucide: { createIcons() {} } });
  return { ...window.PAINEL_MODULES.marketingPaid(), ...window.PAINEL_MODULES.marketingGoogle(), ...window.PAINEL_MODULES.marketingGoogleOverview(),
    ...window.PAINEL_MODULES.marketingGoogleAds(),
    marketingPeriod: '30d', marketingCampaignChannel: 'all', marketingIsMock: () => false,
    formatCurrency: (value: number) => `R$ ${value}`, $nextTick: (fn: () => void) => fn(),
    apiGet: vi.fn(), marketingSetTab: vi.fn(), loadMarketing: vi.fn(), marketingCampaignSetChannel: vi.fn(), renderMarketingSeries: vi.fn() };
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
    expect(state.googleOverviewKpis()[0].value).toBe('R$ 200');
    expect(state.googleOverviewKpis().find((kpi: any) => kpi.id === 'sales').value).toBe('—');
    expect(state.googleOverviewIndicators().find((item: any) => item.label === 'Conversões Google').value).toBe('1,5');
  });
  it('separa conversões do Google de vendas realizadas e mantém margem pendente indisponível', () => {
    const state = app();
    state.googleAdsReport = { status: 'connected', data: { totals: { investment: 600, conversions: 12 } },
      results: { available: true, totals: { attributed_sales: 8, attributed_revenue: 2400, gross_margin: 1400,
        pending_margin_orders: 0, tracked_conversations: 40 } } };
    expect(state.googleOverviewMetrics()).toMatchObject({ attributed_sales: 8, conversions: 12, result: 800, roas: 4, tracked_conversations: 40 });
    state.googleAdsReport.results.totals.gross_margin = null;
    state.googleAdsReport.results.totals.pending_margin_orders = 1;
    expect(state.googleOverviewKpis().find((row: any) => row.id === 'result')).toMatchObject({value:'—',detail:'1 venda(s) sem custo completo'});
    state.googleAdsReport.results.available = false;
    expect(state.googleOverviewKpis().find((row: any) => row.id === 'sales').value).toBe('—');
    expect(state.googleCostStatus()).toBe('Indisponível');
  });
  it('não considera um envio aceito como confirmado e mantém falhas e revisão visíveis', () => {
    const state = app();
    expect(state.googlePipelineCount('sent')).toBe('—');
    state.googleAdsReport = { results: { available: true, conversions_enabled: true, conversion_action_configured: true,
      conversion_destination: {state:'ready'}, pipeline: {available:true,pending:1,processing:1,accepted:2,sent:3,
        failed:1,dead_letter:2,review:1,suppressed:0},totals:{} } };
    expect(state.googlePipelineStatus()).toBe('Automático');
    expect(state.googlePipelineCount('sent')).toBe('3');
    expect(state.googlePipelineCount('queued')).toBe('4');
    expect(state.googlePipelineCount('errors')).toBe('3');
    expect(state.googleOverviewAlerts().map((row: any) => row.id)).toEqual(['failed','review','queue']);
  });
  it('ordena e filtra sem modificar totais, mantendo resultados desconhecidos depois dos conhecidos', () => {
    const state = app();
    state.googleAdsReport = {data:{totals:{investment:600}, campaigns:[
      {id:'a',name:'Carro',status:'ENABLED',investment:240,delivery_days:2},
      {id:'b',name:'Moto',status:'PAUSED',investment:360,delivery_days:4},
    ]},results:{available:true,campaigns:[{id:'a',gross_margin:500,attributed_sales:3},
      {id:'b',gross_margin:null,pending_margin_orders:1,attributed_sales:5}]}};
    state.googleCampaignOrder('result');
    expect(state.googleAdsRows().map((row: any) => row.id)).toEqual(['a','b']);
    state.googleCampaignDecision='review';
    expect(state.googleAdsRows().map((row: any) => row.id)).toEqual(['b']);
    state.googleCampaignReset(); state.googleCampaignStatus='ENABLED';
    expect(state.googleAdsRows().map((row: any) => row.id)).toEqual(['a']);
    expect(state.googleOverviewMetrics().investment).toBe(600);
  });
  it('preenche o gráfico por dia do período usando cliques e investimento do Google', () => {
    const state = app(); state.marketingCampaignChannel='google';
    state.googleAdsReport={data:{period:{since:'2026-09-29',until:'2026-10-01'},
      daily:[{date:'2026-09-30',investment:20,clicks:10}]}};
    expect(state.googleOverviewSeries()).toEqual([
      {date:'2026-09-29',spend:0,clicks:0},{date:'2026-09-30',spend:20,clicks:10},{date:'2026-10-01',spend:0,clicks:0},
    ]);
    state.googleSetView('campaigns');
    expect(state.renderMarketingSeries).toHaveBeenCalledWith(expect.objectContaining({canvasId:'chartGoogleOverview',seriesKey:'clicks'}));
  });
  it('mantém o gráfico da Meta separado dos cliques do Google e destrói somente a instância substituída', () => {
    const instances: any[] = [];
    const window: any = { PAINEL_MODULES: {} };
    class Chart {
      destroy = vi.fn();
      constructor(public canvas: string, public config: any) { instances.push(this); }
    }
    runInNewContext(readFileSync('painel/public/app.marketing.chart.js', 'utf8'), {
      window, Chart, document: {getElementById: (id: string) => id},
    });
    const state = { ...window.PAINEL_MODULES.marketingChart(), marketingDateLabel: (date: string) => date,
      paidChartRows: () => [{date:'2026-09-30',spend:20,conversations:3,clicks:7}],
    };
    state.renderMarketingChart();
    state.renderMarketingSeries({canvasId:'chartGoogleOverview',chartKey:'_googleOverviewChart',
      rows:state.paidChartRows(),seriesKey:'clicks',seriesLabel:'Cliques'});
    expect(instances[0].config.data.datasets[1]).toMatchObject({label:'Conversas na Meta',data:[3]});
    expect(instances[1].config.data.datasets[1]).toMatchObject({label:'Cliques',data:[7]});
    state.renderMarketingChart();
    expect(instances[0].destroy).toHaveBeenCalledOnce();
    expect(instances[1].destroy).not.toHaveBeenCalled();
  });
});
