import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function screen() {
  const context=vm.createContext({window:{PAINEL_MODULES:{}},Date,Intl,URL,document:{activeElement:{focus:vi.fn()}},lucide:{createIcons:vi.fn()}});
  const modules=['organic','organic.summary','organic.compare','organic.compare-charts','organic.results','organic.mock'];
  for(const name of modules)vm.runInContext(readFileSync(`painel/public/app.marketing.${name}.js`,'utf8'),context);
  const s=Object.assign({},...Object.values(context.window.PAINEL_MODULES).map((factory:any)=>factory()),{
    marketingIsMock:()=>true,$nextTick:(fn:()=>void)=>fn(),
    $refs:{moDialog:{open:true,close:vi.fn()},moPickerDialog:{close:vi.fn()},moJourneyDialog:{showModal:vi.fn(),close:vi.fn()}}
  });
  const post={id:'6',platform:'instagram',title:'Pneu NMAX',caption:'130/70-13',published_at:'2026-09-12T12:00:00Z'};
  s.moSelected=post;s.moDetail=context.marketingOrganicMockDetail(post);s.moData={rows:[post]};
  return {s,post,mock:context.marketingOrganicMockDetail};
}

describe('Vendas vinculadas e métricas da publicação',()=>{
  it('não mistura resposta antiga de insights nem dados reais no modo ilustrativo',async()=>{
    const {s}=screen();s.marketingIsMock=()=>false;
    const pending:Array<(v:any)=>void>=[];s.apiGet=vi.fn(()=>new Promise(resolve=>pending.push(resolve)));
    const first=s.moLoadInsights(),second=s.moLoadInsights(true);
    expect(s.apiGet.mock.calls[0][0]).toBe('/admin/api/marketing/organic/publications/instagram/6/insights');
    expect(s.apiGet.mock.calls[1][0]).toBe('/admin/api/marketing/organic/publications/instagram/6/insights?refresh=true');
    pending[1]!({rows:[{metric:'views',value:2}]});await second;
    pending[0]!({rows:[{metric:'views',value:1}]});await first;
    expect(s.moInsights.rows[0].value).toBe(2);
    s.marketingIsMock=()=>true;await s.moLoadInsights();expect(s.moInsights).toBeNull();
  });
  it('apresenta os oito pedidos concluídos e exclui cancelamentos dos totais',()=>{
    const {s}=screen();expect(s.moSalesRows()).toHaveLength(8);expect(s.moSalesTotal()).toEqual({count:8,amount:1424});
    s.moSalesStatus='all';expect(s.moSalesFiltered()).toHaveLength(9);expect(s.moSalesTotal()).toEqual({count:8,amount:1424});
    s.moSalesStatus='cancelled';expect(s.moSalesFiltered()).toHaveLength(1);expect(s.moSalesTotal()).toEqual({count:0,amount:0});
  });
  it('deduplica por pedido e o cancelamento prevalece mesmo registrado depois da janela',()=>{
    const {s}=screen(), rows=s.moDetail.attribution.sales_rows, first=rows[0];
    rows.push({...first});expect(s.moSalesTotal().count).toBe(8);
    rows.push({...first,status:'cancelled',cancelled_at:'2026-10-01T12:00:00Z'});
    expect(s.moSalesTotal()).toEqual({count:7,amount:1246});
  });
  it('recusa registros sem origem confirmada, fora da janela e com valores inválidos',()=>{
    const {s}=screen(), rows=s.moDetail.attribution.sales_rows;
    rows[0].source_confirmed=false;rows[1].completed_at='2026-09-19T15:00:00Z';rows[2].amount=-178;
    expect(s.moSalesTotal()).toEqual({count:5,amount:890});
    s.moDetail.attribution.sales_rows_complete=false;expect(s.moSalesReady()).toBe(false);expect(s.moSalesRows()).toEqual([]);
  });
  it('filtra nome com acento e número, pagina e preserva os totais gerais',()=>{
    const {s}=screen();s.moSalesSearch='julia';expect(s.moSalesRows()[0].customer_name).toBe('Júlia R.');
    s.moSalesSearch='1045';expect(s.moSalesRows()[0].customer_name).toBe('Marina C.');
    s.moSalesSearch='';s.moSalesStatus='all';s.moSalesPageChange(1);expect(s.moSalesRows()).toHaveLength(1);
    s.moSalesFilterChanged();expect(s.moSalesPage).toBe(1);expect(s.moResultCount('sales')).toBe(8);
  });
  it('não converte indisponibilidade em zero, gráfico ou taxa',()=>{
    const {s}=screen();s.moDetail.attribution.status='not_implemented';
    expect(s.moSalesReady()).toBe(false);expect(s.moSalesRows()).toEqual([]);expect(s.moResponseSplit()).toBeNull();
    expect(s.moSendingSplit()).toBeNull();expect(s.moConversationSplit()).toBeNull();expect(s.moTimeBuckets()).toBeNull();
    expect(s.moMetricCards().every((c:any)=>c.value==='—')).toBe(true);
  });
  it('calcula resposta por envio, conversão por conversa e mediana separadamente',()=>{
    const {s}=screen();expect(s.moResponseSplit()).toMatchObject({sent:48,replied:30,pending:18,rate:62.5});
    expect(s.moSendingSplit()).toMatchObject({sent:48,failed:2,total:50,rate:96});
    expect(s.moConversationSplit()).toMatchObject({total:30,converted:8,pending:22});
    expect(s.moMedianTime()).toBe('11h 20min');expect(s.moTimeBuckets().map((r:any)=>r.value)).toEqual([2,3,2,1]);
    expect(s.moAverageSale()).toBe(178);
    s.moDetail.attribution.sales=10;expect(s.moMetricPercent(s.moConversationSplit().rate)).toBe('26,7%');
  });
  it('não divide por zero e recusa respostas maiores que os envios ou tempos inconsistentes',()=>{
    const {s}=screen(),a=s.moDetail.attribution;
    a.private_messages=0;a.private_replied=0;a.private_failed=0;a.conversations=0;a.converted_conversations=0;a.sales=0;a.confirmed_orders=0;a.revenue=0;a.confirmation_time_buckets=[0,0,0,0];
    expect(s.moResponseSplit().rate).toBeNull();expect(s.moSendingSplit().rate).toBeNull();expect(s.moAverageSale()).toBeNull();expect(s.moMedianTime()).toBe('—');
    a.private_replied=1;expect(s.moResponseSplit()).toBeNull();a.converted_conversations=1;expect(s.moConversationSplit()).toBeNull();
    a.confirmation_time_buckets=[1,0,0,0];expect(s.moTimeBuckets()).toBeNull();
  });
  it('abre a jornada registrada, preserva lacunas e bloqueia links de outras origens',()=>{
    const {s}=screen(),row=s.moSalesRows()[0];row.origin.comment_url='javascript:alert(1)';
    s.moOpenSaleJourney(row);expect(s.moJourneySale.order_id).toBe(row.order_id);expect(s.moSaleJourneySteps()).toHaveLength(4);
    expect(s.moSaleJourneySteps()[0].url).toBeNull();expect(s.moSafeSocialUrl('https://facebook.com.evil.test/post')).toBeNull();
    expect(s.moSafeSocialUrl('https://www.instagram.com/p/abc/')).toContain('instagram.com');
    row.origin={};expect(s.moSaleJourneySteps()[2].text).toBe('Conversa ainda sem referência.');
    s.moCloseSaleJourney();expect(s.moJourneySale).toBeNull();expect(s.$refs.moJourneyDialog.close).toHaveBeenCalled();
  });
  it('alterna as quatro abas usando o mesmo detalhe sem repetir a consulta',async()=>{
    const {s}=screen();s.apiGet=vi.fn();await s.moSwitchAnalysis('sales');expect(s.moAnalysisTab).toBe('sales');
    await s.moSwitchAnalysis('metrics');expect(s.moAnalysisTab).toBe('metrics');await s.moSwitchAnalysis('summary');
    expect(s.apiGet).not.toHaveBeenCalled();expect(s.moDetail.attribution.sales).toBe(8);
  });
  it('ao sair de Comparar posts usa o post A e não deixa o retorno antigo substituir a seleção',async()=>{
    const {s,post,mock}=screen(),other={...post,id:'9',title:'Pneu carro'};
    s.moAnalysisTab='compare';s.moComparePosts=[other,post];s.marketingIsMock=()=>false;
    let resolve:any;s.apiGet=()=>new Promise(r=>resolve=r);const loading=s.moSwitchAnalysis('sales');
    expect(s.moDetailLoading).toBe(true);expect(s.moSalesRows()).toEqual([]);s.moClose();resolve(mock(other));await loading;
    expect(s.moSelected).toBeNull();expect(s.moDetail).toBeNull();expect(s.moJourneySale).toBeNull();
  });
  it('troca a janela sem exibir o detalhamento ou taxas do período anterior',()=>{
    const {s}=screen();s.moSummaryPeriod='30d';expect(s.moSalesRows()).toEqual([]);expect(s.moMetricCards().every((c:any)=>c.value==='—')).toBe(true);
  });
  it('exporta o filtro inteiro, identifica dados ilustrativos e neutraliza fórmulas',()=>{
    const {s}=screen();s.moAnalysisTab='sales';s.moSalesSearch='';s.moDetail.attribution.sales_rows[0].customer_name='=1+1';
    const csv=s.moSummaryCsv(s.moResultsExportRows());expect(csv).toContain('Ilustrativos');expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('"Total concluído no filtro";"8";"1424"');expect(csv).not.toContain('Felipe T.');
    s.moAnalysisTab='metrics';expect(s.moSummaryCsv(s.moResultsExportRows())).toContain('11h 20min');
  });
});
