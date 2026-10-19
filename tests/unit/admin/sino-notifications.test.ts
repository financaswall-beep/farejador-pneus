import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
function read(name: string) {
  return readFileSync(resolve(root, 'painel/public', name), 'utf8');
}
const modules = ['resumo','bot','retiradas','logistica','financeiro','estoque','rede'];
function frontend(storage = new Map<string,string>()) {
  const context: any = { window: {}, location: { pathname: '/admin/painel' }, document: { hidden: false },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: (k: string) => storage.get(k), setItem: (k: string,v: string) => storage.set(k,v) },
    lucide: { createIcons() {} } };
  for (const name of ['sino','core','comissoes','nav']) vm.runInNewContext(read(`app.${name}.js`),context);
  const state: any = { sino: null, sinoLidas: [], adminAuthenticated: true,
    adminUser: { id:'user-a',username:'test-a',role:'owner',auth_type:'session' },
    panelScope:'matrix',panelModules:modules,currentPage:'financeiro',loadBotCampainha:vi.fn(),
    $nextTick:(fn: () => void)=>fn(),catalogoConditionLabel:(v: string)=>v,formatCurrency:String,
    ...context };
  for (const name of ['sino','core','comissoes','nav'])
    Object.defineProperties(state,Object.getOwnPropertyDescriptors(context.window.PAINEL_MODULES[name]()));
  state.sinoScope=state.sinoContext();
  return state;
}
function allAlerts(m: any) {
  m.sino={bot_reservation_expiry_failures:{count:1,orders:[{order_number:'TEST-1',unit_name:'Teste'}]},
    ledger_health:{status:'red',error_signals:1,pending_signals:0},bot_reservations_expiring:1,
    normalization_failed:1,bot_resilience:{enabled:true,dead_letters:1,api_ack_unconfirmed:0},
    entregas_falhadas:[{order_id:'order-1',reason:'ausente'}],
    galpao_repor:[{measure:'90/90-18',tire_condition:'novo',quantity_on_hand:1,min_quantity:2}],
    fiado_vencido:{count:1,total:'100'},a_pagar_vencido:{count:1,total:'200'}};
  m.sinoApplications=[{id:'app-1',trade_name:'Loja teste'}];
  m.sinoComissoes={enabled:true,partners:[{partner_id:'partner-a',partner_name:'Loja A',open_total:100,open_count:1}]};
  m.comissaoAlerta=50;
}
function responses(m: any) {
  m.apiGet=vi.fn(async (path: string) => path.includes('partner-applications') ? []
    : path.includes('comissoes') ? {enabled:true,partners:[]} : {});
}
const deferred = () => { let resolve!: (v: any)=>void; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; };
afterEach(()=>vi.useRealTimers());

describe('sino: atualizações e falhas',()=>{
  it('conserva alertas na falha, sinaliza erro e permite recuperar sem falso Tudo em dia',async()=>{
    const m=frontend();allAlerts(m);const before=m.notificacoes.map((n: any)=>n.id);
    m.apiGet=vi.fn(async()=>{throw Error('offline');});await m.loadSino();
    expect(m.notificacoes.map((n: any)=>n.id)).toEqual(before);
    expect(m.sinoError).toBeTruthy();expect(m.sinoEmpty).toBe(false);expect(m.sinoLoading).toBe(false);
    responses(m);await m.loadSino();expect(m.sinoError).toBeNull();expect(m.sinoEmpty).toBe(true);
  });
  it('primeira falha e carregamento nunca indicam ausência de pendências',async()=>{
    const m=frontend(),d=deferred();m.apiGet=()=>d.promise;
    const run=m.loadSino();expect(m.sinoLoading).toBe(true);expect(m.sinoEmpty).toBe(false);
    d.resolve(null);await run;expect(m.sinoError).toBeTruthy();expect(m.sinoEmpty).toBe(false);
  });
  it('rebusca comissões e candidaturas em qualquer página a cada atualização',async()=>{
    const m=frontend();responses(m);
    await m.liveRefresh();await vi.waitFor(()=>expect(m.sinoLoading).toBe(false));
    await m.liveRefresh();await vi.waitFor(()=>expect(m.sinoLoading).toBe(false));
    for (const path of ['/admin/api/matriz/notificacoes','/admin/api/rede/comissoes','/admin/api/partner-applications?status=pending'])
      expect(m.apiGet.mock.calls.filter(([url]: [string])=>url===path)).toHaveLength(2);
  });
  it('não consulta fontes fora das permissões nem candidaturas de outro papel',async()=>{
    const m=frontend();m.adminUser.role='admin';m.panelModules=['estoque'];responses(m);await m.loadSino();
    expect(m.apiGet.mock.calls).toEqual([['/admin/api/matriz/notificacoes']]);
  });
  it('aplica fontes bem-sucedidas mas mantém a fonte que falhou e o horário anterior',async()=>{
    const m=frontend();allAlerts(m);m.sinoUpdatedAt='2026-10-19T12:00:00.000Z';
    m.apiGet=async (path: string)=>{ if(path.includes('comissoes'))throw Error('offline'); return path.includes('applications')?[]:{}; };
    await m.loadSino();expect(m.notificacoes).toHaveLength(1);expect(m.notificacoes[0].page).toBe('rede');
    expect(m.sinoUpdatedAt).toBe('2026-10-19T12:00:00.000Z');expect(m.sinoError).toBeTruthy();
  });
  it('limpa fonte proibida em vez de manter informações antigas após 403',async()=>{
    const m=frontend();allAlerts(m);m.apiGet=async()=>{throw Error('api_403');};await m.loadSino();
    expect(m.notificacoes).toHaveLength(0);expect(m.sinoError).toBeTruthy();expect(m.sinoEmpty).toBe(false);
  });
  it('ignora resposta antiga após mudar de conta e não duplica consultas simultâneas',async()=>{
    const m=frontend(),d=deferred();m.apiGet=vi.fn(()=>d.promise);
    const old=m.loadSino();await m.loadSino();expect(m.apiGet).toHaveBeenCalledTimes(3);
    m.adminUser={...m.adminUser,id:'user-b'};responses(m);await m.loadSino();
    d.resolve({fiado_vencido:{count:99,total:'999'}});await old;
    expect(m.sino).toEqual({});expect(m.notificacoes).toHaveLength(0);
  });
  it('limpa dados e ignora respostas pendentes quando a sessão termina',async()=>{
    const m=frontend(),d=deferred();allAlerts(m);m.apiGet=()=>d.promise;
    const run=m.loadSino();m.adminAuthenticated=false;
    expect(m.notificacoes).toHaveLength(0);d.resolve({});await run;
    expect(m.sino).toBeNull();expect(m.sinoLoading).toBe(false);
  });
  it('limita espera de resposta travada e ignora sua chegada depois da recuperação',async()=>{
    vi.useFakeTimers();const m=frontend(),d=deferred();m.apiGet=()=>d.promise;
    const run=m.loadSino();await vi.advanceTimersByTimeAsync(12001);await run;
    expect(m.sinoError).toBeTruthy();expect(m.sinoLoading).toBe(false);
    responses(m);await m.loadSino();d.resolve({fiado_vencido:{count:99,total:'999'}});
    await Promise.resolve();expect(m.sino).toEqual({});
  });
  it('pausa consultas periódicas enquanto a aba está oculta',async()=>{
    const m=frontend();responses(m);m.document.hidden=true;await m.liveRefresh();expect(m.apiGet).not.toHaveBeenCalled();
    m.document.hidden=false;await m.liveRefresh();await vi.waitFor(()=>expect(m.sinoLoading).toBe(false));
    expect(m.apiGet).toHaveBeenCalledTimes(3);
  });
});

describe('sino: leitura, identidade e destinos',()=>{
  it('marca os 11 tipos sem resolver pendências e abre cada destino permitido',async()=>{
    const m=frontend();allAlerts(m);m.openApplications=vi.fn();expect(m.notificacoes).toHaveLength(11);
    for(const n of m.notificacoes){await m.sinoClick(n);if(n.page)expect(m.currentPage).toBe(n.page);}
    expect(m.openApplications).toHaveBeenCalledOnce();expect(m.finTab).toBe('pagar');
    expect(m.cobrancaFiltro).toBe('vencida');expect(m.pagarFiltro).toBe('vencida');expect(m.redeSection).toBe('operacao');
    expect(m.notificacoes).toHaveLength(11);expect(m.notifBadgeCount()).toBe(0);
    m.sino={};m.sinoApplications=[];m.sinoComissoes=null;expect(m.notificacoes).toHaveLength(0);
  });
  it('abandona abas e filtros antigos para mostrar a pendência do alerta',async()=>{
    const m=frontend();allAlerts(m);m.$dispatch=vi.fn();
    m.stockTab='custos';m.stockVehicleType='car';
    await m.sinoClick(m.notificacoes.find((n:any)=>n.page==='estoque'));
    expect(m.stockTab).toBe('reposicao');expect(m.stockVehicleType).toBe('all');
    expect(m.$dispatch).toHaveBeenCalledWith('sino-reposicao');
    m.partnerRetiradasFilter='completed';m.partnerRetiradasSearch='outro cliente';m.partnerRetiradasSelectedId='old';
    await m.sinoClick(m.notificacoes.find((n:any)=>n.page==='retiradas'));
    expect(m.partnerRetiradasFilter).toBe('waiting');expect(m.partnerRetiradasSearch).toBe('');expect(m.partnerRetiradasSelectedId).toBe('');
    m.finTab='extrato';await m.sinoClick(m.notificacoes.find((n:any)=>n.id.startsWith('ledger-health:')));
    expect(m.finTab).toBe('visao');
    m.botTab='demanda';await m.sinoClick(m.notificacoes.find((n:any)=>n.id.startsWith('bot-expiry-failed:')));
    expect(m.botTab).toBe('vendas');
    await m.sinoClick(m.notificacoes.find((n:any)=>n.id.startsWith('bot-resilience:')));
    expect(m.botTab).toBe('conversas');
  });
  it('abre a ocorrência exata da entrega após atualizar a logística',async()=>{
    const m=frontend();allAlerts(m);m.logisticaTab='historico';
    m.loadLogistica=vi.fn(async()=>{});m.logisticaTodasEntregas=()=>[{order_id:'order-1',delivery_status:'failed'}];
    m.logOpAbrirDialog=vi.fn();await m.sinoClick(m.notificacoes.find((n:any)=>n.page==='logistica'));
    expect(m.logisticaTab).toBe('visao');expect(m.loadLogistica).toHaveBeenCalled();
    expect(m.logOpAbrirDialog).toHaveBeenCalledWith('pedido','order-1');
  });
  it('não abre ocorrência atrasada se a pessoa navegar para outra tela',async()=>{
    const m=frontend();allAlerts(m);const d=deferred();m.loadLogistica=()=>d.promise;
    m.logisticaTodasEntregas=()=>[{order_id:'order-1',delivery_status:'failed'}];m.logOpAbrirDialog=vi.fn();
    const click=m.sinoClick(m.notificacoes.find((n:any)=>n.page==='logistica'));
    m.currentPage='estoque';d.resolve(undefined);await click;expect(m.logOpAbrirDialog).not.toHaveBeenCalled();
  });
  it('não abre ocorrência já resolvida nem um detalhe antigo após falha de atualização',async()=>{
    const m=frontend();allAlerts(m);m.logOpAbrirDialog=vi.fn();
    m.loadLogistica=async()=>{};m.logisticaTodasEntregas=()=>[{order_id:'order-1',delivery_status:'delivered'}];
    await m.sinoClick(m.notificacoes.find((n:any)=>n.page==='logistica'));
    m.logisticaTodasEntregas=()=>[{order_id:'order-1',delivery_status:'failed'}];
    m.loadLogistica=async()=>{throw Error('offline');};
    await m.sinoClick(m.notificacoes.find((n:any)=>n.page==='logistica'));
    expect(m.logOpAbrirDialog).not.toHaveBeenCalled();
  });
  it('descarta abertura pendente após trocar de conta',async()=>{
    const m=frontend();allAlerts(m);const d=deferred();m.loadLogistica=()=>d.promise;
    m.logisticaTodasEntregas=()=>[{order_id:'order-1',delivery_status:'failed'}];m.logOpAbrirDialog=vi.fn();
    const click=m.sinoClick(m.notificacoes.find((n:any)=>n.page==='logistica'));
    m.adminUser={...m.adminUser,id:'user-b'};d.resolve(undefined);await click;expect(m.logOpAbrirDialog).not.toHaveBeenCalled();
  });
  it('o clique mais recente prevalece quando duas ocorrências carregam fora de ordem',async()=>{
    const m=frontend();allAlerts(m);m.sino.entregas_falhadas.push({order_id:'order-2',reason:'avaria'});
    const d=deferred();m.loadLogistica=vi.fn().mockImplementationOnce(()=>d.promise).mockResolvedValueOnce(undefined);
    m.logisticaTodasEntregas=()=>['order-1','order-2'].map(order_id=>({order_id,delivery_status:'failed'}));
    m.logOpAbrirDialog=vi.fn();const notices=m.notificacoes.filter((n:any)=>n.page==='logistica');
    const first=m.sinoClick(notices[0]);await m.sinoClick(notices[1]);d.resolve(undefined);await first;
    expect(m.logOpAbrirDialog.mock.calls).toEqual([['pedido','order-2']]);
  });
  it('troca de parceiro ou quantidade de lançamentos reavisa mesmo com o mesmo valor',()=>{
    const m=frontend();allAlerts(m);m.sinoMarcarTodas();
    m.sinoComissoes.partners[0].partner_id='partner-b';expect(m.notifBadgeCount()).toBe(1);
    m.sinoMarcarTodas();m.sinoComissoes.partners[0].open_count=2;expect(m.notifBadgeCount()).toBe(1);
  });
  it('reordenar candidaturas, estoque ou parceiros não gera alerta novo',()=>{
    const m=frontend();allAlerts(m);
    m.sinoApplications.push({id:'app-2'});m.sinoComissoes.partners.push({partner_id:'partner-b',open_total:200,open_count:1});
    m.sino.galpao_repor.push({measure:'80/100-18',tire_condition:'novo',quantity_on_hand:0,min_quantity:2});
    m.sinoMarcarTodas();m.sinoApplications.reverse();m.sinoComissoes.partners.reverse();m.sino.galpao_repor.reverse();
    expect(m.notifBadgeCount()).toBe(0);
  });
  it('mantém leituras separadas por conta e ignora a chave antiga compartilhada',async()=>{
    const storage=new Map([['farejador_sino_lidas','["legacy"]']]);const m=frontend(storage);allAlerts(m);m.sinoMarcarTodas();
    m.adminUser={...m.adminUser,id:'user-b'};responses(m);await m.loadSino();allAlerts(m);
    expect(m.notifBadgeCount()).toBe(11);
    m.adminUser={...m.adminUser,id:'user-a'};await m.loadSino();allAlerts(m);expect(m.notifBadgeCount()).toBe(0);
  });
  it('storage bloqueado ou inválido não impede carregar nem marcar leituras',async()=>{
    const m=frontend(new Map([['farejador_sino_lidas_v2:user-a','invalid-json']]));m.sinoScope=null;
    responses(m);await m.loadSino();allAlerts(m);
    m.localStorage.setItem=()=>{throw Error('blocked');};m.sinoMarcarTodas();expect(m.notifBadgeCount()).toBe(0);
  });
  it('esconde dados anteriores imediatamente se os acessos mudarem',()=>{
    const m=frontend();allAlerts(m);m.adminUser.role='admin';m.panelModules=['estoque'];
    expect(m.notificacoes).toHaveLength(0);m.sinoScope=m.sinoContext();
    expect(m.notificacoes.map((n: any)=>n.page)).toEqual(['estoque']);
  });
  it('o vazio no HTML depende de confirmação e oferece erro, horário e nova tentativa',()=>{
    const html=read('index.html');expect(html).toContain('x-show="sinoEmpty"');
    expect(html).not.toMatch(/x-show="notificacoes.length === 0"/);
    expect(html).toContain('x-text="sinoStatus"');expect(html).toContain('Tentar novamente');
    expect(html).toContain('Última atualização completa:');expect(html).toContain('width:min(400px,calc(100vw - 2rem))');
  });
});
