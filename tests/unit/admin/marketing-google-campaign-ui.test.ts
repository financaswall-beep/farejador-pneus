import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function app() {
  const window = { PAINEL_MODULES: {} as Record<string, () => any> };
  for (const file of ['paid','google','google.overview','google.ads','google.campaign']) {
    runInNewContext(readFileSync(`painel/public/app.marketing.${file}.js`,'utf8'),
      {window,URL,document:{querySelector:()=>null},lucide:{createIcons(){}}});
  }
  return Object.assign({},...Object.values(window.PAINEL_MODULES).map(factory=>factory()),{
    marketingPeriod:'30d',marketingCampaignChannel:'google',marketingIsMock:()=>false,
    formatCurrency:(value:number)=>`R$ ${value}`,$nextTick:(fn:()=>void)=>fn(),
    apiGet:vi.fn().mockResolvedValue({available:true}),renderMarketingSeries:vi.fn(),
    googleAdsReport:{status:'connected',data:{account:{id:'1234567890'},period:{since:'2026-09-29',until:'2026-10-01'},
      campaigns:[{id:'11',name:'Pneus moto',investment:480,clicks:320,impressions:16000,conversions:9,cpc:1.5,ctr:2},
        {id:'12',name:'Outra campanha',investment:1000}],
      daily:[{date:'2026-09-30',investment:9999,clicks:999}],
      campaign_daily:[{campaign_id:'11',date:'2026-09-30',cost_micros:'480000000',clicks:320},
        {campaign_id:'12',date:'2026-09-30',cost_micros:'1000000000',clicks:500}],
      ads:[{id:'22:33',ad_id:'33',campaign_id:'11',name:'Anúncio A',investment:200},
        {id:'22:34',ad_id:'34',campaign_id:'11',name:'Anúncio B',investment:280},
        {id:'22:35',ad_id:'35',campaign_id:'12',name:'Anúncio externo ao detalhe',investment:1000}]},
      results:{available:true,campaigns:[{id:'11',attributed_sales:6,attributed_revenue:1188,gross_margin:732,
        product_cost:456,partner_payout:0,pending_margin_orders:0,tracked_conversations:26}],
        pipeline:{available:true,sent:999},campaign_pipelines:{'11':{available:true,sent:5,pending:1,processing:0,
          accepted:1,failed:0,dead_letter:0,review:1,suppressed:0}},ads:[]}},
  });
}
describe('Google Ads — detalhe de campanha',()=>{
  it('abre o detalhe e permite comparar somente dois anúncios da campanha',()=>{
    const state=app();state.googleAdsSelected=['22:35'];state.googleOpenCampaign('11');
    expect(state.googleAdsView).toBe('campaign');expect(state.googleAdsSelected).toEqual([]);
    expect(state.googleCampaignAds().map((a:any)=>a.id)).toEqual(['22:34','22:33']);
    state.googleCampaignCompare();expect(state.googleCampaignTab).toBe('ads');
    state.googleToggleAd('22:33');state.googleToggleAd('22:34');state.googleCampaignCompare();
    expect(state.googleAdsView).toBe('compare');
    state.googleReturnCampaign();expect(state.googleAdsView).toBe('campaign');
    state.googleOpenAd('22:33');state.googleReturnCampaign();expect(state.googleCampaignId).toBe('11');
    state.googleSetView('campaigns');expect(state.googleCampaignReturnId).toBe('');
  });
  it('usa a campanha e sua série diária mesmo sem anúncios individuais ou com filtros antigos',()=>{
    const state=app();state.googleOpenCampaign('11');state.googleAdsCampaign='12';state.googleAdStatus='PAUSED';
    expect(state.googleCampaignAds()).toHaveLength(2);
    state.googleAdsReport.data.ads=[];
    expect(state.googleCampaignMetrics()).toMatchObject({investment:480,result:252,attributed_sales:6,conversions:9});
    expect(state.googleCampaignSeries()).toEqual([{date:'2026-09-29',spend:0,clicks:0},
      {date:'2026-09-30',spend:480,clicks:320},{date:'2026-10-01',spend:0,clicks:0}]);
    delete state.googleAdsReport.data.campaign_daily;
    expect(state.googleCampaignSeries()).toEqual([]);
  });
  it('mostra a composição e mantém custos ou apuração desconhecidos indisponíveis',()=>{
    const state=app();state.googleOpenCampaign('11');
    expect(state.googleCampaignFinancialRows().map((r:any)=>r.value)).toEqual([1188,-456,-0,-480,252]);
    expect(state.googleCampaignCostsLabel()).toBe('6 de 6');
    expect(state.googleCampaignRetained()).toBeCloseTo(21.2121);
    Object.assign(state.googleAdsReport.results.campaigns[0],{product_cost:null,gross_margin:null,pending_margin_orders:1});
    expect(state.googleCampaignMetrics().result).toBeNull();expect(state.googleCampaignFinancialRows()[1].value).toBeNull();
    expect(state.googleCampaignCostsLabel()).toBe('5 de 6');expect(state.googleCampaignRetained()).toBeNull();
    state.googleAdsReport.results.available=false;
    expect(state.googleCampaignMetrics()).toMatchObject({result:null,attributed_sales:null,product_cost:null,partner_payout:null});
    expect(state.googleCampaignCostsLabel()).toBe('Indisponível');
  });
  it('não utiliza os envios globais nem considera aceitação como confirmação',()=>{
    const state=app();state.googleOpenCampaign('11');
    expect(state.googleCampaignPipelineCount('sent')).toBe('5');expect(state.googleCampaignPipelineCount('queued')).toBe('2');
    expect(state.googleCampaignPipelineCount('review')).toBe('1');
    state.googleCampaignId='12';expect(state.googleCampaignPipelineCount('sent')).toBe('0');
    delete state.googleAdsReport.results.campaign_pipelines;
    expect(state.googleCampaignPipelineCount('sent')).toBe('—');
  });
  it('descarta uma consulta atrasada de outra campanha e mantém totais independentes da paginação',async()=>{
    const state=app();let finish!:(value:object)=>void;
    state.apiGet.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))
      .mockResolvedValueOnce({available:true,page_size:25,orders:{total:51,page:1,rows:[]},conversations:{total:30,page:1,rows:[]}});
    state.googleOpenCampaign('11');state.googleOpenCampaign('12');await Promise.resolve();await Promise.resolve();
    finish({available:true,orders:{total:999}});await Promise.resolve();await Promise.resolve();
    expect(state.googleCampaignActivity.orders.total).toBe(51);expect(state.googleCampaignActivityPages('orders')).toBe(3);
    expect(state.googleCampaignActivityPages('conversations')).toBe(2);
    expect(state.apiGet.mock.calls[1][0]).toContain('campaign_id=12');
  });
  it('troca o período mantendo a campanha e limpa a atividade anterior',async()=>{
    const state=app();state.googleOpenCampaign('11');await Promise.resolve();
    state.googleCampaignActivity={available:true,orders:{total:99}};
    const report=state.googleAdsReport;state.apiGet.mockResolvedValueOnce(report).mockResolvedValueOnce({available:true});
    state.marketingPeriod='7d';const loading=state.loadGoogleAds();
    expect(state.googleCampaignActivity).toBeNull();await loading;
    expect(state.googleAdsView).toBe('campaign');expect(state.googleCampaignId).toBe('11');
    expect(state.apiGet.mock.calls.at(-1)[0]).toContain('period=7d');
  });
  it('rejeita campanhas desconhecidas e URL de gerenciador com ID inválido',()=>{
    const state=app();state.googleOpenCampaign('99');expect(state.googleAdsView).toBe('campaigns');
    expect(state.apiGet).not.toHaveBeenCalled();state.googleCampaignId='11';
    expect(state.googleCampaignManagerUrl()).toContain('campaignId=11');
    state.googleAdsReport.data.account.id='javascript:alert(1)';expect(state.googleCampaignManagerUrl()).toBe('');
  });
  it('ao voltar da análise em outro período recarrega a atividade e trata campanha removida',async()=>{
    const state=app();state.googleOpenCampaign('11');await Promise.resolve();
    state.googleOpenAd('22:33');state.googleCampaignInvalidateActivity();state.apiGet.mockClear();
    state.googleReturnCampaign();expect(state.apiGet).toHaveBeenCalledOnce();
    state.googleAdsReport.data.campaigns=[];state.googleReturnCampaign();
    expect(state.googleAdsView).toBe('campaigns');expect(state.googleCampaignReturnId).toBe('');
  });
});
