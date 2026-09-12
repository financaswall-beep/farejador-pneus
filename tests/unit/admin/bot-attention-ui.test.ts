import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach,describe,expect,it,vi } from 'vitest';
function setup() {
  const sandbox={ window:{ PAINEL_MODULES:{} as Record<string,()=>object> },
    document:{ getElementById:()=>null },console,URL,Date,location:{ pathname:'/admin/painel' } };
  for (const name of ['app.bot.js','app.bot.controle.js','app.clientes.js','app.clientes.leads.js']) {
    runInNewContext(readFileSync(`painel/public/${name}`,'utf8'),sandbox);
  }
  const ui:Record<string,any>={};
  for (const factory of Object.values(sandbox.window.PAINEL_MODULES)) Object.defineProperties(ui,Object.getOwnPropertyDescriptors(factory()));
  Object.assign(ui,{ adminAuthenticated:true,hasPanelModule:()=>true,$nextTick:(f:()=>void)=>f(),
    apiGet:vi.fn(),apiPost:vi.fn(),botConversaFiltro:'todos',botConversaBusca:'' });
  return ui;
}
afterEach(()=>vi.useRealTimers());

function fixtureFila() {
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  const ui=setup();
  ui.botCampainha={ mudas:[1,7,8,15,16,30,31,90].map(dias=>({
    conversation_id:String(dias),contact_name:'Cliente '+dias,preview:'Pneu',
    minutos:dias*1440,quando:new Date(Date.now()-dias*86400000).toISOString(),
  })),escalados:[] };
  return ui;
}
describe('fila de atenção e controle azul',() => {
  it('preserva a conversa, a foto e o canal ao mesclar esperando, escalados e controle humano',() => {
    const ui=setup();ui.botCampainha={ mudas:[{ conversation_id:'a',contact_name:'Ana',channel_type:'Channel::Instagram',bot_mode:'human' }],
      escalados:[{ conversation_id:'b',contact_name:'Bruno',channel_type:'Channel::Facebook',bot_mode:'auto' }] };
    ui.botControlesHumanos=[{ conversation_id:'a',contact_name:'Ana',updated_at:new Date().toISOString() },
      { conversation_id:'c',contact_name:'Carla',channel_type:'Channel::Whatsapp',updated_at:new Date().toISOString() }];
    expect(ui.botConversasFila).toHaveLength(3);
    const channels=Object.fromEntries(ui.botConversasFila.map((row:any)=>[row.conversation_id,ui.clienteLeadCanal(row)]));
    expect(channels).toEqual({ a:'instagram',b:'facebook',c:'whatsapp' });
    expect(ui.botConversasFila.find((row:any)=>row.conversation_id==='a')).toMatchObject({ lead_conversation_id:'a',bot_mode:'human' });
  });
  it('reutiliza foto com endpoint autorizado do Bot e fallback sem imagem quebrada',async () => {
    const ui=setup(),row={ lead_conversation_id:'a' };
    ui.apiGet.mockResolvedValue({ avatar_url:'https://chatwoot.example.test/a.png' });
    ui.carregarClienteLeadFoto(row,'bot');ui.carregarClienteLeadFoto(row,'bot');
    await vi.waitFor(()=>expect(ui.clienteLeadFoto(row)).toContain('a.png'));
    expect(ui.apiGet).toHaveBeenCalledTimes(1);
    expect(ui.apiGet).toHaveBeenCalledWith('/admin/api/bot/conversations/a/avatar');
    ui.clienteLeadFotoFalhou(row);expect(ui.clienteLeadFoto(row)).toBe('');
  });
  it('padroniza azul para auto, âmbar para humano e neutro para estado desconhecido',() => {
    const ui=setup();
    expect(ui.botControleClasse('auto')).toContain('bg-blue-600');
    expect(ui.botControleClasse('human')).toContain('bg-amber-50');
    expect(ui.botControleClasse(null)).not.toContain('bg-blue-600');
    ui.botControleModos.a=null;
    expect(ui.botControleModo('a','auto')).toBeNull();
    expect(ui.botControleModo('b','auto')).toBe('auto');
    // O Alpine precisa observar a leitura da chave ausente para atualizar a cor após o GET.
    const read=vi.fn((target:Record<string,unknown>,key:string)=>target[key]);
    ui.botControleModos=new Proxy({},{ get:read });
    expect(ui.botControleModo('novo')).toBeNull();
    expect(read).toHaveBeenCalledWith(expect.any(Object),'novo',expect.any(Object));
    ui.botControleModos.novo='auto';
    expect(ui.botControleModo('novo')).toBe('auto');
  });
  it('atualiza apenas o controle escolhido após confirmação e trata falha sem presumir retomada',async () => {
    const ui=setup();ui.apiGet.mockResolvedValueOnce({ mode:'auto',version:0 });
    await ui.abrirControleBot('a','Ana');
    ui.botControleModos.b='auto';
    ui.apiPost.mockResolvedValue({ mode:'human',version:1 });
    ui.apiGet.mockResolvedValue({ conversations:[] });
    await ui.alterarControleBot('takeover');
    expect(ui.botControleModo('a')).toBe('human');expect(ui.botControleModo('b')).toBe('auto');
    ui.apiPost.mockRejectedValue(new Error('offline'));await ui.alterarControleBot('resume');
    expect(ui.botControleModo('a')).toBeNull();expect(ui.botControleDialog.state).toBeNull();
  });
  it('mantém os atalhos de controle da fila e do modal, com foto e coluna Origem',() => {
    const html=readFileSync('painel/public/index.html','utf8');
    const table=html.slice(html.indexOf('id="bot-fila-atencao"'),html.indexOf('</table>',html.indexOf('id="bot-fila-atencao"')));
    expect(table).toContain('>Origem</th>');expect(table).toContain('clienteOrigemIcone(c)');
    expect(table).toContain("carregarClienteLeadFoto(c,'bot')");expect(table).toContain('clienteLeadFotoFalhou(c)');
    expect(table).toContain(':key="c.conversation_id"');
    expect(table).toContain(':class="botControleClasse(');
    expect(html).toContain('id="bot-controle-fechar"');
  });
  it('abre com todas as pendências e ordena as mais antigas primeiro, inclusive acima de 30 dias',() => {
    const ui=fixtureFila();
    expect(ui.botFilaPeriodo).toBe('todos');
    expect(ui.botConversasFiltradas.map((row:any)=>row.conversation_id)).toEqual(['90','31','30','16','15','8','7','1']);
    expect(ui.botFilaForaPeriodo).toBe(0);
    expect(ui.botMinutosLabel(31*1440+120)).toBe('31d 2h');
  });
  it.each([['7',2,6],['15',4,4],['30',6,2]])('filtra %s dias com limite inclusivo e avisa as demais', (periodo,visiveis,fora) => {
    const ui=fixtureFila();
    const original=JSON.stringify(ui.botCampainha);
    ui.botFilaPagina=3;ui.setBotFilaPeriodo(periodo);
    expect(ui.botConversasFiltradas).toHaveLength(Number(visiveis));
    expect(ui.botFilaForaPeriodo).toBe(fora);expect(ui.botFilaPagina).toBe(1);
    expect(ui.botConversasFila).toHaveLength(8);
    expect(JSON.stringify(ui.botCampainha)).toBe(original);
    expect(ui.apiPost).not.toHaveBeenCalled();
    ui.setBotFilaPeriodo('todos');expect(ui.botConversasFiltradas).toHaveLength(8);
  });
  it('combina busca e situação sem esconder o aviso global do período',() => {
    const ui=fixtureFila();ui.setBotFilaPeriodo('7');ui.botConversaBusca='cliente 1';
    expect(ui.botConversasFiltradas.map((row:any)=>row.conversation_id)).toEqual(['1']);
    ui.botConversaFiltro='humano';expect(ui.botConversasFiltradas).toEqual([]);
    expect(ui.botFilaForaPeriodo).toBe(6);
  });
  it('considera a nova mensagem em um atendimento humano antigo e deduplica a conversa',() => {
    const ui=fixtureFila();
    ui.botControlesHumanos=[{ conversation_id:'90',contact_name:'Antiga',updated_at:new Date(Date.now()-90*86400000).toISOString(),
      last_customer_at:new Date(Date.now()-3600000).toISOString() }];
    ui.setBotFilaPeriodo('7');
    expect(ui.botConversasFila).toHaveLength(8);
    expect(ui.botConversasFiltradas.find((row:any)=>row.conversation_id==='90')).toMatchObject({ tipo:'humano',bot_mode:'human' });
    expect(ui.botFilaForaPeriodo).toBe(5);
  });
  it('preserva a data mais recente ao unir uma mensagem e um encaminhamento antigo',() => {
    const ui=fixtureFila();
    ui.botCampainha.escalados=[{ conversation_id:'1',quando:new Date(Date.now()-60*86400000).toISOString() }];
    ui.setBotFilaPeriodo('7');
    expect(ui.botConversasFiltradas.find((row:any)=>row.conversation_id==='1')).toMatchObject({ tipo:'humano' });
    expect(ui.botConversasFila).toHaveLength(8);
  });
  it('inclui mensagem recém-chegada em encaminhamento antigo, antes dos 5 minutos de espera',() => {
    const ui=fixtureFila();
    ui.botCampainha.escalados=[{ conversation_id:'encaminhada',quando:new Date(Date.now()-60*86400000).toISOString(),
      last_customer_at:new Date(Date.now()-60000).toISOString() }];
    ui.setBotFilaPeriodo('7');
    expect(ui.botConversasFiltradas.some((row:any)=>row.conversation_id==='encaminhada')).toBe(true);
  });
  it('não esconde registros sem data comprovada e trata período inválido como todos',() => {
    const ui=fixtureFila();ui.botCampainha.mudas.push({ conversation_id:'sem-data' });
    ui.setBotFilaPeriodo('7');
    expect(ui.botConversasFiltradas.some((row:any)=>row.conversation_id==='sem-data')).toBe(true);
    ui.setBotFilaPeriodo('365');expect(ui.botFilaPeriodo).toBe('todos');
  });
  it('pagina sem perder conversas e ajusta a página se a fila diminuir',() => {
    const ui=fixtureFila();
    ui.botCampainha.mudas=Array.from({ length:45 },(_,i)=>({ conversation_id:String(i),minutos:i+5 }));
    expect(ui.botFilaTotalPaginas).toBe(3);expect(ui.botConversasPaginadas).toHaveLength(20);
    const ids=[];
    for(let pagina=1;pagina<=3;pagina++) { ui.botFilaPagina=pagina;ids.push(...ui.botConversasPaginadas.map((row:any)=>row.conversation_id)); }
    expect(new Set(ids).size).toBe(45);expect(ui.botConversasPaginadas).toHaveLength(5);
    ui.botCampainha.mudas=ui.botCampainha.mudas.slice(0,1);
    expect(ui.botFilaPaginaAtual).toBe(1);expect(ui.botConversasPaginadas).toHaveLength(1);
  });
  it('não apaga a fila nem zera o badge em falha de atualização',async () => {
    const ui=fixtureFila();Object.assign(ui,{ ensureCredentials:()=>{},currentPage:'resumo',menuBadges:{} });
    const original=ui.botCampainha;ui.apiGet.mockRejectedValueOnce(new Error('offline'));
    await ui.loadBotCampainha();
    expect(ui.botCampainha).toBe(original);expect(ui.botFilaErro).toBe(true);expect(ui.menuBadges.bot).toBe('8');
    ui.apiGet.mockResolvedValueOnce(original);await ui.loadBotCampainha();expect(ui.botFilaErro).toBe(false);
  });
  it('expõe períodos, aviso, paginação e cache atualizado sem mudar o controle do bot',() => {
    const html=readFileSync('painel/public/index.html','utf8');
    for(const periodo of ['Todas as pendentes','Últimos 7 dias','Últimos 15 dias','Últimos 30 dias']) expect(html).toContain(periodo);
    expect(html).toContain('aria-label="Período da fila de atenção"');
    expect(html).toContain('botFilaForaPeriodo > 0');expect(html).toContain('c in botConversasPaginadas');
    expect(html).toContain('app.bot.controle.js?v=20260912-kanban-controls1');
  });
});

describe('ícones de atendente nos cards do Kanban',() => {
  const lead={ id:'lead-a',name:'Ana',lead_conversation_id:'a',lead_bot_mode:'auto',lead_bot_version:0,lead_manual_lane:'orcamento' };
  it('assume e retoma a mesma conversa usando a versão atual, sem abrir detalhe nem mudar etapa',async () => {
    const ui=setup();ui.abrirClienteLead=vi.fn();
    ui.apiGet.mockResolvedValueOnce({mode:'auto',version:3});
    ui.apiPost.mockResolvedValueOnce({mode:'human',version:4});
    await ui.definirClienteLeadAtendente(lead,'human');
    expect(ui.apiPost).toHaveBeenLastCalledWith('/admin/api/bot/conversations/a/controle',{action:'takeover',expected_version:3});
    expect(ui.clienteLeadBotStatus(lead).state).toBe('human');
    ui.apiGet.mockResolvedValueOnce({mode:'human',version:4});
    ui.apiPost.mockResolvedValueOnce({mode:'auto',version:5});
    await ui.definirClienteLeadAtendente(lead,'auto');
    expect(ui.apiPost).toHaveBeenLastCalledWith('/admin/api/bot/conversations/a/controle',{action:'resume',expected_version:4});
    expect(ui.clienteLeadBotStatus(lead).state).toBe('auto');
    expect(ui.abrirClienteLead).not.toHaveBeenCalled();expect(lead.lead_manual_lane).toBe('orcamento');
  });
  it('confere o servidor até quando o card já mostra o modo desejado e bloqueia clique duplo',async () => {
    const ui=setup();ui.registrarBotControle('a',{mode:'auto',version:0});
    let resolve!: (value:unknown)=>void;
    ui.apiGet.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
    ui.apiPost.mockResolvedValueOnce({mode:'auto',version:2});
    const pending=ui.definirClienteLeadAtendente(lead,'auto');
    await ui.definirClienteLeadAtendente(lead,'human');
    expect(ui.apiGet).toHaveBeenCalledTimes(1);expect(ui.apiPost).not.toHaveBeenCalled();
    expect(ui.clienteLeadControleDesabilitado(lead)).toBe(true);
    resolve({mode:'human',version:1});await pending;
    expect(ui.apiPost).toHaveBeenCalledWith('/admin/api/bot/conversations/a/controle',{action:'resume',expected_version:1});
    expect(ui.clienteLeadControleDesabilitado(lead)).toBe(false);
  });
  it('não repete conflitos automaticamente e não mostra sucesso em resposta incerta',async () => {
    const ui=setup();ui.registrarBotControle('a',{mode:'human',version:7});
    ui.apiGet.mockResolvedValue({mode:'human',version:7});ui.apiPost.mockRejectedValue(new Error('409'));
    await ui.definirClienteLeadAtendente(lead,'auto');
    expect(ui.apiPost).toHaveBeenCalledTimes(1);expect(ui.clienteLeadBotStatus(lead).state).toBe('unknown');
    expect(ui.clienteLeadControlesErros.a).toContain('Não foi possível confirmar');
    expect(ui.clienteLeadControlesSalvando.a).toBe(false);
  });
  it('uma atualização antiga do quadro ou do modal não desfaz um clique confirmado',async () => {
    const ui=setup();ui.registrarBotControle('a',{mode:'human',version:4});
    ui.registrarBotControle('a',{mode:'auto',version:3});
    expect(ui.clienteLeadBotStatus(lead).state).toBe('human');
    ui.apiGet.mockResolvedValue({mode:'auto',version:2});await ui.consultarBotControle('a');
    expect(ui.clienteLeadBotStatus(lead).state).toBe('human');
    ui.registrarBotControle('a',{mode:'auto',version:5});
    expect(ui.clienteLeadBotStatus(lead).state).toBe('auto');
    ui.registrarBotControle('a',{mode:'human',version:6});
    expect(ui.clienteLeadBotStatus(lead).state).toBe('human');
  });
  it('leitura inicial não inventa bot ativo e clique no modo já vigente não grava novamente',async () => {
    const ui=setup();expect(ui.clienteLeadBotStatus({lead_conversation_id:'b'}).state).toBe('unknown');
    expect(ui.clienteLeadBotStatus(lead).state).toBe('auto');
    ui.apiGet.mockResolvedValue({mode:'human',version:1});
    await ui.definirClienteLeadAtendente(lead,'human');
    expect(ui.apiPost).not.toHaveBeenCalled();expect(ui.clienteLeadBotStatus(lead).state).toBe('human');
  });
  it('não altera atendimento sem permissão, durante seleção ou arquivamento em lote',async () => {
    const ui=setup();ui.hasPanelModule=()=>false;await ui.definirClienteLeadAtendente(lead,'human');
    ui.hasPanelModule=()=>true;ui.clientesLeadSelecionando=true;await ui.definirClienteLeadAtendente(lead,'human');
    ui.clientesLeadSelecionando=false;ui.clientesLeadLote={};await ui.definirClienteLeadAtendente(lead,'auto');
    expect(ui.apiGet).not.toHaveBeenCalled();expect(ui.apiPost).not.toHaveBeenCalled();
  });
  it('não usa uma resposta incompleta para liberar atendimento nem manter o robô aceso',async () => {
    const ui=setup();ui.registrarBotControle('a',{mode:'auto',version:0});
    ui.apiGet.mockResolvedValue({mode:'auto'});
    await ui.definirClienteLeadAtendente(lead,'human');
    expect(ui.apiPost).not.toHaveBeenCalled();expect(ui.clienteLeadBotStatus(lead).state).toBe('unknown');
    expect(ui.clienteLeadControlesErros.a).toContain('Não foi possível confirmar');
  });
});
