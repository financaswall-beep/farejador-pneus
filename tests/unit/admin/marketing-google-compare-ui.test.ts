import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it,vi} from 'vitest';

function app() {
  const window:any={PAINEL_MODULES:{}}, focus=vi.fn();
  const Chart=vi.fn(function(this:any,_canvas:any,config:any){this.config=config;this.destroy=vi.fn();});
  for(const file of ['paid','google','google.overview','google.ads','google.campaign','google.detail','google.compare']) {
    runInNewContext(readFileSync('painel/public/app.marketing.'+file+'.js','utf8'),
      {window,URL,Chart,document:{querySelector:()=>null,getElementById:()=>({focus})},lucide:{createIcons(){}}});
  }
  const ad=(id:string,campaign:string,investment:number,clicks:number)=>({
    id,ad_id:'33',ad_group_id:id.split(':')[0],campaign_id:campaign,campaign_name:'Campanha '+campaign,
    name:'Anúncio '+id,status:'ENABLED',format:'RESPONSIVE_SEARCH_AD',headlines:['Pneus | 2W'],
    investment,clicks,impressions:7600,conversions:5,conversion_value:990,cpc:999,cpm:26.32,ctr:2.57,
    daily:[{date:'2026-09-29',cost_micros:'3000000',clicks:3},
      {date:'2026-09-30',cost_micros:'1000000',clicks:0}],
  });
  return Object.assign({},...Object.values(window.PAINEL_MODULES).map((factory:any)=>factory()),{
    window,Chart,focus,marketingPeriod:'30d',marketingCampaignChannel:'google',marketingIsMock:()=>false,
    currentPage:'marketing',marketingTab:'visao',formatCurrency:(value:number)=>'R$ '+value,
    $nextTick:(fn:()=>void)=>fn(),apiGet:vi.fn().mockResolvedValue({available:true}),googleExportCells:vi.fn(),
    renderMarketingSeries:vi.fn(),
    googleAdsReport:{status:'connected',data:{account:{id:'1234567890'},period:{since:'2026-09-29',until:'2026-10-01'},
      campaigns:[{id:'11',investment:300,clicks:250},{id:'12',investment:210,clicks:185}],
      ads:[ad('22:33','11',200,195),ad('23:33','12',210,185),ad('24:33','11',0,0)],
    },results:{available:true,ads:[
      {id:'22:33',attributed_sales:3,attributed_revenue:594,gross_margin:366,product_cost:228,partner_payout:0,
        tracked_conversations:20,pending_margin_orders:0},
      {id:'23:33',attributed_sales:3,attributed_revenue:594,gross_margin:343.5,product_cost:250.5,partner_payout:0,
        tracked_conversations:14,pending_margin_orders:0},
    ]}},
  });
}
function open(state:any) {state.googleAdsSelected=['22:33','23:33'];state.googleShowCompare();}

describe('Google Ads — comparação completa de anúncios',()=>{
  it('separa conversões Google, vendas confirmadas e custos usando a identidade grupo/anúncio',()=>{
    const state=app();open(state);
    expect(state.googleCompareAd(0)).toMatchObject({conversions:5,attributed_sales:3,result:166});
    expect(state.googleCompareAd(1)).toMatchObject({result:133.5,product_cost:250.5});
    expect(state.googleCompareGroups().map((g:any)=>g.group)).toEqual(['Entrega no Google','Vendas e resultado no Farejador']);
    expect(state.googleCompareRows().find((r:any)=>r.label==='Resultado após mídia')).toMatchObject({a:'R$ 166',b:'R$ 133.5'});
    expect(state.googleCompareRows().find((r:any)=>r.label==='Custo dos pneus / produtos').values).toEqual(['R$ -228','R$ -250.5']);
    expect(state.googleCompareRows().find((r:any)=>r.label==='Repasses aos parceiros').values).toEqual(['R$ 0','R$ 0']);
    expect(state.googleCompareObservations()[1].text).toContain('R$ 32.5');
    expect(state.googleCompareHighlight(0)).toBe(true);expect(state.googleCompareHighlight(1)).toBe(false);
  });
  it('inclui repasses no resultado, mantém prejuízo negativo e não inventa custos pendentes',()=>{
    const state=app();open(state);const a=state.googleAdsReport.results.ads[0];
    Object.assign(a,{product_cost:0,partner_payout:500,gross_margin:94});
    expect(state.googleCompareAd(0).result).toBe(-106);
    expect(state.googleCompareRows().find((r:any)=>r.label==='Repasses aos parceiros').a).toBe('R$ -500');
    Object.assign(a,{gross_margin:null,partner_payout:null,pending_margin_orders:1});
    expect(state.googleCompareAd(0).result).toBeNull();expect(state.googleCompareHighlight(1)).toBe(false);
    expect(state.googleCompareObservations().some((n:any)=>n.text.includes('a mais de resultado'))).toBe(false);
    state.googleAdsReport.results.available=false;
    expect(state.googleCompareRows().find((r:any)=>r.label==='Vendas atribuídas').values).toEqual(['—','—']);
    expect(state.googleCompareRows().find((r:any)=>r.label==='Investimento').a).toBe('R$ 200');
  });
  it('mantém período comum, CPC ponderado e lacunas reais, incluindo cliques de custo zero',()=>{
    const state=app();open(state);
    expect(state.googleCompareAverage(0)).toBeCloseTo(200/195); // Não usa o CPC 999 da fixture.
    expect(state.googleCompareSeries()).toEqual([
      {date:'2026-09-29',values:[1,1]},{date:'2026-09-30',values:[null,null]},{date:'2026-10-01',values:[null,null]},
    ]);
    state.googleAdsReport.data.ads[1].daily[0].cost_micros='0';
    expect(state.googleCompareSeries()[0].values).toEqual([1,0]);
    state.googleAdsReport.data.ads[0].daily[0].cost_micros=undefined;
    expect(state.googleCompareSeries()[0].values).toEqual([null,0]);
    state.googleCompareSelect(0,'24:33');expect(state.googleCompareAverage(0)).toBeNull();
  });
  it('substitui e destrói somente seu gráfico, sem unir dias sem cliques',()=>{
    const state=app();open(state);const old=state.window._googleComparisonChart;
    expect(old.config.data.datasets[0]).toMatchObject({spanGaps:false,data:[1,null,null]});
    expect(old.config.data.datasets).toHaveLength(2);
    state.googleCompareSwap();expect(old.destroy).toHaveBeenCalledOnce();
    const latest=state.window._googleComparisonChart;state.googleCompareBack();
    expect(latest.destroy).toHaveBeenCalledOnce();expect(state.window._googleComparisonChart).toBeNull();
    state.googleAdsView='compare';state.currentPage='financeiro';state.renderGoogleCompareChart();
    expect(state.window._googleComparisonChart).toBeNull();state.currentPage='marketing';
    for(const ad of state.googleAdsReport.data.ads) ad.daily=[];
    state.googleAdsView='compare';state.renderGoogleCompareChart();expect(state.window._googleComparisonChart).toBeNull();
  });
  it('troca posições ao escolher o mesmo anúncio e preserva IDs compostos e seleção',()=>{
    const state=app();open(state);state.googleCompareSelect(0,'23:33');
    expect([state.googleCompareA,state.googleCompareB]).toEqual(['23:33','22:33']);
    expect(state.googleAdsSelected).toEqual(['23:33','22:33']);expect(state.googleCompareNotice).toContain('trocada');
    state.googleCompareSwap();expect(state.googleAdsSelected).toEqual(['22:33','23:33']);
    state.googleCompareSelect(1,'unknown');expect(state.googleCompareB).toBe('23:33');
    state.googleAdsSelected=['22:33','22:33'];state.googleAdsView='ads';state.googleShowCompare();expect(state.googleAdsView).toBe('ads');
  });
  it('volta da análise à comparação e depois à galeria mantendo filtros e página',()=>{
    const state=app();state.googleAdPage=3;state.googleAdsSearch='aro 14';state.googleAdStatus='PAUSED';open(state);
    state.googleCompareViewAd(1);expect(state.googleAdsView).toBe('detail');
    expect(state.googleAdsDetailId).toBe('23:33');expect(state.googleDetailReturnView).toBe('compare');
    state.googleDetailBack();expect(state.googleAdsView).toBe('compare');expect(state.googleCompareB).toBe('23:33');
    state.googleCompareBack();expect(state.googleAdsView).toBe('ads');
    expect(state.googleAdPage).toBe(3);expect(state.googleAdsSearch).toBe('aro 14');expect(state.googleAdStatus).toBe('PAUSED');
  });
  it('retorna à campanha de origem e recarrega seu detalhe pelo motor existente',()=>{
    const state=app();state.googleCampaignReturnId='11';open(state);state.googleCompareBack();
    expect(state.googleAdsView).toBe('campaign');expect(state.googleCampaignId).toBe('11');
    expect(state.apiGet).toHaveBeenCalledWith(expect.stringContaining('/google-ads/campaign?campaign_id=11'));
  });
  it('preserva anúncios ao mudar o período, mas avisa quando um deixa de estar disponível',async()=>{
    const state=app();open(state);const old=state.window._googleComparisonChart;
    const report=state.googleAdsReport;report.data.period.since='2026-09-30';
    state.apiGet.mockResolvedValueOnce(report);state.marketingPeriod='7d';await state.loadGoogleAds();
    expect(old.destroy).toHaveBeenCalledOnce();expect(state.googleAdsView).toBe('compare');
    expect(state.googleCompareSeries()).toHaveLength(2);
    const next={...report,data:{...report.data,ads:[report.data.ads[0]]}};
    state.apiGet.mockResolvedValueOnce(next);await state.loadGoogleAds();
    expect(state.googleAdsView).toBe('ads');expect(state.googleAdsSelected).toEqual(['22:33']);
    expect(state.googleCompareNotice).toContain('Selecione outro');expect(state.window._googleComparisonChart).toBeNull();
  });
  it('exporta nomes, IDs, período e a mesma composição exibida, mesmo com filtros da galeria',()=>{
    const state=app();open(state);state.googleAdsSearch='não encontrado';state.googleAdsExport();
    const rows=state.googleExportCells.mock.calls[0][0];
    expect(rows.find((r:any)=>r[0]==='ID grupo')).toEqual(['ID grupo','22','23']);
    expect(rows.find((r:any)=>r[0]==='Período')).toEqual(['Período','2026-09-29','2026-10-01']);
    expect(rows.find((r:any)=>r[0]==='Resultado após mídia')).toEqual(['Resultado após mídia','R$ 166','R$ 133.5']);
    expect(rows.find((r:any)=>r[0]==='Valor de conversão Google')).toEqual(['Valor de conversão Google','R$ 990','R$ 990']);
    state.googleExportCells.mockClear();state.googleAdsLoading=true;state.googleCompareExport();
    expect(state.googleExportCells).not.toHaveBeenCalled();
  });
});
