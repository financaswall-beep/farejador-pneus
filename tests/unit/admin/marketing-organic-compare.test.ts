import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function screen() {
  const focus=vi.fn(),context=vm.createContext({window:{PAINEL_MODULES:{}},Date,Intl,document:{activeElement:{focus}},lucide:{createIcons:vi.fn()}});
  for(const name of ['organic','organic.summary','organic.compare','organic.compare-charts','organic.mock']) {
    vm.runInContext(readFileSync(`painel/public/app.marketing.${name}.js`,'utf8'),context);
  }
  const state=Object.assign({},...['marketingOrganic','marketingOrganicSummary','marketingOrganicCompare','marketingOrganicCompareCharts'].map(name=>context.window.PAINEL_MODULES[name]()),{
    marketingIsMock:()=>true,$nextTick:(fn:()=>void)=>fn(),
    $refs:{moDialog:{close:vi.fn()},moPickerDialog:{showModal:vi.fn(),close:vi.fn()},moPickerSearch:{focus:vi.fn()}},
  });
  const a={id:'6',platform:'instagram',format:'image',title:'Pneu para sua NMAX',caption:'130/70-13',published_at:'2026-09-12T12:00:00Z'};
  const b={id:'5',platform:'instagram',format:'image',title:'Pneus para seu carro',caption:'175/65R14',published_at:'2026-09-15T12:00:00Z'};
  const c={...b,id:'7',platform:'facebook',title:'Retirada na loja'};
  state.moData={rows:[a,b,c]};state.moSelected=a;
  return {state,a,b,c,detail:context.marketingOrganicMockDetail};
}

describe('Comparar posts orgânicos',()=>{
  beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));});
  afterEach(()=>vi.useRealTimers());

  it('alinha o Dia 1 de posts publicados em datas diferentes, sem comparar dias do calendário',async()=>{
    const {state:s}=screen();await s.moSwitchAnalysis('compare');
    expect(s.moCompareDetails.map((d:any)=>d.attribution.period.since)).toEqual(['2026-09-12','2026-09-15']);
    expect(s.moCompareTimeline()).toEqual({labels:['Dia 1','Dia 2','Dia 3','Dia 4','Dia 5','Dia 6','Dia 7'],a:[3,7,12,16,21,25,30],b:[2,4,7,10,14,17,20]});
    expect(s.moCompareInsights().map((i:any)=>i.side)).toEqual([0,1]);
    expect(s.moCompareInsights()[1].text).toContain('71,00');
  });
  it('dados indisponíveis não viram zero, não ganham destaque e não geram conclusão',async()=>{
    const {state:s}=screen();await s.moSwitchAnalysis('compare');s.moCompareDetails[1].attribution.status='not_implemented';
    expect(s.moCompareRows().every((r:any)=>r.values[1]===null)).toBe(true);
    expect(s.moCompareFunnel()).toBeNull();expect(s.moCompareTimeline()).toBeNull();expect(s.moCompareInsights()).toEqual([]);
    expect(s.moCompareRows().some((r:any)=>s.moCompareWinner(r,0))).toBe(false);
    s.moCompareDetails[1].attribution.status='ready';s.moCompareDetails[1].attribution.sales=0;
    expect(s.moCompareValue(1,'sales')).toBe(0);
  });
  it('não aponta vencedor enquanto um dos posts não completou a janela de acompanhamento',async()=>{
    const {state:s,b}=screen();b.published_at='2026-09-26T12:00:00Z';await s.moSwitchAnalysis('compare');
    expect(s.moCompareNotice()).toContain('Período ainda em andamento');expect(s.moCompareFair()).toBe(false);
    expect(s.moCompareInsights()).toEqual([]);expect(s.moCompareWinner(s.moCompareRows()[2],0)).toBe(false);
  });
  it('calcula conversão por conversas distintas mesmo quando uma conversa tem mais de uma venda',async()=>{
    const {state:s}=screen();await s.moSwitchAnalysis('compare');s.moCompareDetails[0].attribution.sales=12;
    expect(s.moCompareFormat(s.moCompareConversion(0),'conversion')).toBe('26,7%');
    s.moCompareDetails[0].attribution.conversations=0;expect(s.moCompareConversion(0)).toBeNull();
  });
  it('não transforma falha de um post em falha do outro e permite tentar novamente',async()=>{
    const {state:s,a,detail}=screen();s.marketingIsMock=()=>false;
    s.apiGet=vi.fn().mockResolvedValueOnce(detail(a)).mockRejectedValueOnce(Error('Meta offline'));
    await s.moSwitchAnalysis('compare');
    expect(s.moCompareValue(0,'sales')).toBe(8);expect(s.moCompareValue(1,'sales')).toBeNull();
    expect(s.moCompareErrors[1]).toContain('post B');expect(s.moCompareLoading).toBe(false);
  });
  it('descarta a resposta antiga depois da troca de post e depois do fechamento',async()=>{
    const {state:s,a,b,c,detail}=screen();s.marketingIsMock=()=>false;
    const pending:Array<(value:any)=>void>=[];s.apiGet=()=>new Promise(resolve=>pending.push(resolve));
    const first=s.moSwitchAnalysis('compare');s.moComparePosts=[a,c];const second=s.moLoadCompare();
    pending[2](detail(a));pending[3](detail(c));await second;
    pending[0](detail(a));pending[1](detail(b));await first;
    expect(s.moCompareDetails[1].publication.id).toBe(c.id);
    const third=s.moLoadCompare();s.moClose();pending[4](detail(a));pending[5](detail(c));await third;
    expect(s.moCompareDetails).toEqual([null,null]);expect(s.moSelected).toBeNull();
  });
  it('exige que o retorno corresponda ao post, à rede e ao período solicitado',async()=>{
    const {state:s,a,b,detail}=screen();s.marketingIsMock=()=>false;
    s.apiGet=vi.fn().mockResolvedValueOnce(detail({...a,platform:'facebook'})).mockResolvedValueOnce(detail(b,'30d'));
    await s.moSwitchAnalysis('compare');expect(s.moCompareDetails).toEqual([null,null]);
    expect(s.moCompareErrors.every(Boolean)).toBe(true);
  });
  it('exclui o outro post do seletor, trata acentos e não confunde IDs de redes diferentes',async()=>{
    const {state:s,b,c}=screen();await s.moSwitchAnalysis('compare');s.moOpenPostPicker(0);
    s.moData.rows.push({...b,platform:'facebook'});
    expect(s.moPostChoices().filter((p:any)=>p.id===b.id).map((p:any)=>p.platform)).toEqual(['facebook']);
    s.moPickerSearch='retiráda';expect(s.moPostChoices()[0].id).toBe(c.id);
    await s.moChooseComparePost(c);expect(s.moComparePosts[0].id).toBe(c.id);expect(s.moPickerSide).toBeNull();
  });
  it('não inventa uma segunda publicação e mantém a orientação de escolha',async()=>{
    const {state:s,a}=screen();s.moData.rows=[a];await s.moSwitchAnalysis('compare');
    expect(s.moComparePosts[1]).toBeNull();expect(s.moCompareNotice()).toContain('Escolha outra publicação');
    expect(s.moCompareFunnel()).toBeNull();
  });
  it('inverte os lados sem refazer consultas e mantém os dados ligados ao post correto',async()=>{
    const {state:s,a,b}=screen();await s.moSwitchAnalysis('compare');s.moSwapCompare();
    expect(s.moComparePosts.map((p:any)=>p.id)).toEqual([b.id,a.id]);
    expect(s.moCompareValue(0,'sales')).toBe(5);expect(s.moCompareValue(1,'sales')).toBe(8);
  });
  it('recusa séries com buracos ou de outra janela sem preencher ausência com zero',async()=>{
    const {state:s}=screen();await s.moSwitchAnalysis('compare');s.moCompareDetails[0].attribution.conversation_series.splice(1,1);
    expect(s.moCompareTimeline()).toBeNull();s.moSummaryPeriod='30d';expect(s.moCompareRows().every((r:any)=>r.values.every((v:any)=>v===null))).toBe(true);
  });
  it('exporta duas datas de início, identifica pendência e preserva campos contra fórmulas',async()=>{
    const {state:s}=screen();await s.moSwitchAnalysis('compare');s.moComparePosts[1].title='=1+1';s.moCompareDetails[1].attribution.status='not_implemented';
    const csv=s.moSummaryCsv(s.moCompareExportRows());
    expect(csv).toContain('"Início";"2026-09-12";"2026-09-15"');
    expect(csv).toContain('"Vendas concluídas";"8";"Indisponível"');
    expect(csv).toContain('"\'=1+1"');expect(csv).toContain('Vínculo pendente');
  });
});
