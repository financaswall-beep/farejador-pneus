import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it,vi} from 'vitest';

function app() {
  const window={PAINEL_MODULES:{} as Record<string,()=>any>};
  const chart=vi.fn(function(this:any,_canvas:any,config:any){this.config=config;this.destroy=vi.fn();});
  for(const file of ['paid','google','google.overview','google.ads','google.campaign','google.detail']) {
    runInNewContext(readFileSync('painel/public/app.marketing.'+file+'.js','utf8'),
      {window,URL,document:{querySelector:()=>null,getElementById:()=>({})},lucide:{createIcons(){}},Chart:chart});
  }
  return Object.assign({},...Object.values(window.PAINEL_MODULES).map(factory=>factory()),{
    marketingPeriod:'30d',marketingCampaignChannel:'google',marketingIsMock:()=>false,
    formatCurrency:(value:number)=>'R$ '+value,$nextTick:(fn:()=>void)=>fn(),
    apiGet:vi.fn().mockResolvedValue({available:true,page_size:25,orders:{total:0,rows:[]},conversations:{total:0,rows:[]},events:[]}),
    chart,renderMarketingSeries:vi.fn(),
    googleAdsReport:{status:'connected',data:{account:{id:'1234567890'},period:{since:'2026-09-29',until:'2026-10-01'},
      campaigns:[{id:'11',investment:300,clicks:250},{id:'12',investment:10000,clicks:10}],
      ads:[{id:'22:33',ad_id:'33',ad_group_id:'22',campaign_id:'11',name:'Pesquisa',format:'RESPONSIVE_SEARCH_AD',
        investment:200,clicks:195,impressions:7600,conversions:5,conversion_value:990,cpc:1.03,cpm:26.32,ctr:2.57,
        final_url:'https://2w.example/',daily:[{date:'2026-09-29',cost_micros:'3000000',clicks:3},
          {date:'2026-09-30',cost_micros:'2000000',clicks:0}]},
        {id:'22:34',ad_id:'34',ad_group_id:'22',campaign_id:'11',investment:100},
        {id:'23:33',ad_id:'33',ad_group_id:'23',campaign_id:'12',investment:10000}],
    },results:{available:true,ads:[{id:'22:33',attributed_sales:3,attributed_revenue:594,gross_margin:366,
      product_cost:228,partner_payout:0,pending_margin_orders:0,tracked_conversations:20}],
      pipeline:{sent:999},campaign_pipelines:{'11':{sent:99}},ad_pipelines:{'22:33':{available:true,sent:2,
        pending:1,accepted:1,processing:0,failed:0,dead_letter:0,review:1,suppressed:0}}}},
  });
}
describe('Google — análise de anúncio individual',()=>{
  it('mantém vendas e conversões distintas e inclui repasses no cálculo',()=>{
    const state=app();state.googleOpenAd('22:33');
    expect(state.googleDetailMetrics()).toMatchObject({conversions:5,attributed_sales:3,result:166,roas:2.97});
    expect(state.googleDetailDelivery().at(-1).value).toBe('R$ 990');
    expect(state.googleDetailFinancial().map((r:any)=>r.value)).toEqual([594,-228,-0,-200,166]);
    const r=state.googleAdsReport.results.ads[0];Object.assign(r,{product_cost:0,partner_payout:500,gross_margin:94});
    expect(state.googleDetailFormula()).toContain('R$ 500');expect(state.googleDetailMetrics().result).toBe(-106);
    Object.assign(r,{partner_payout:null,gross_margin:null,pending_margin_orders:1});
    expect(state.googleDetailMetrics().result).toBeNull();expect(state.googleDetailFormula()).toContain('aguardando');
    state.googleAdsReport.results.available=false;expect(state.googleDetailMetrics().attributed_sales).toBeNull();
  });
  it('usa média ponderada da campanha e deixa dias sem cliques sem ponto',()=>{
    const state=app();state.googleOpenAd('22:33');
    expect(state.googleDetailCampaignCpc()).toBe(1.2);expect(state.googleDetailBenchmark().text).toContain('14,5% abaixo');
    expect(state.googleDetailSeries()).toEqual([{date:'2026-09-29',cpc:1},{date:'2026-09-30',cpc:null},{date:'2026-10-01',cpc:null}]);
    expect(state._googleAdDetailChart.config.data.datasets[0].spanGaps).toBe(false);
    expect(state._googleAdDetailChart.config.data.datasets[1].data).toEqual([1.2,1.2,1.2]);
    const old=state._googleAdDetailChart;state.renderGoogleDetailChart();expect(old.destroy).toHaveBeenCalledOnce();
    state.googleAdsReport.data.campaigns[0].clicks=0;expect(state.googleDetailCampaignCpc()).toBeNull();
  });
  it('conta somente envios do anúncio, sem confundir aceitação e confirmação',()=>{
    const state=app();state.googleOpenAd('22:33');
    expect(state.googleDetailPipelineCount('sent')).toBe('2');expect(state.googleDetailPipelineCount('queued')).toBe('2');
    expect(state.googleDetailPipelineCount('review')).toBe('1');
    state.googleAdsDetailId='23:33';expect(state.googleDetailPipelineCount('sent')).toBe('0');
    delete state.googleAdsReport.results.ad_pipelines;expect(state.googleDetailPipelineCount('sent')).toBe('—');
  });
  it('descarta resposta atrasada ao trocar de anúncio e conserva totais paginados',async()=>{
    const state=app();let finish!:(value:object)=>void;
    state.apiGet.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({
      available:true,page_size:25,orders:{total:51,rows:[]},conversations:{total:26,rows:[]}});
    state.googleOpenAd('22:33');state.googleOpenAd('22:34');await Promise.resolve();await Promise.resolve();
    finish({available:true,orders:{total:999}});await Promise.resolve();await Promise.resolve();
    expect(state.googleDetailActivity.orders.total).toBe(51);expect(state.googleDetailPages('orders')).toBe(3);
    expect(state.googleDetailPages('conversations')).toBe(2);expect(state.apiGet.mock.calls[1][0]).toContain('ad_id=22%3A34');
    state.googleDetailNavigate('orders',1);expect(state.apiGet.mock.calls.at(-1)[0]).toContain('order_page=2');
  });
  it('preserva anúncio na troca de período e volta à galeria sem perder filtros',async()=>{
    const state=app();state.googleOpenAd('22:33');await Promise.resolve();
    state.googleDetailOrderPage=2;const report=state.googleAdsReport;
    state.apiGet.mockResolvedValueOnce(report).mockResolvedValueOnce({available:true});
    state.marketingPeriod='7d';const loading=state.loadGoogleAds();expect(state.googleDetailActivity).toBeNull();await loading;
    expect(state.googleAdsDetailId).toBe('22:33');expect(state.googleDetailOrderPage).toBe(1);
    expect(state.apiGet.mock.calls.at(-1)[0]).toContain('period=7d');
    state.googleAdStatus='PAUSED';state.googleAdsSearch='teste';state.googleAdPage=4;state.googleDetailBack();
    expect(state.googleAdsView).toBe('ads');expect(state.googleAdPage).toBe(4);expect(state.googleAdsSearch).toBe('teste');
  });
  it('mantém o retorno à campanha e compara com outro anúncio da mesma campanha',()=>{
    const state=app();state.googleCampaignReturnId='11';state.googleOpenAd('22:33');
    state.googleDetailCompare();expect(state.googleAdsSelected).toEqual(['22:33','22:34']);
    state.googleOpenAd('22:33');state.googleDetailBack();expect(state.googleAdsView).toBe('campaign');
    state.googleOpenAd('unknown');expect(state.googleAdsView).toBe('campaign');
  });
  it('não oferece URLs perigosas ou gerenciador com IDs inválidos',()=>{
    const state=app();state.googleOpenAd('22:33');expect(state.googleDetailManagerUrl()).toContain('adGroupId=22&adId=33');
    for(const url of ['javascript:alert(1)','http://2w.example/','https://key@2w.example/']) {
      state.googleAdsReport.data.ads[0].final_url=url;expect(state.googleDetailDestination()).toBe('');
    }
    state.googleAdsReport.data.account.id='bad';expect(state.googleDetailManagerUrl()).toBe('');
  });
});
