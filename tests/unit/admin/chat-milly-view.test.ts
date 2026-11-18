import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script=(name:string)=>readFileSync('painel/public/caixa-chat-milly'+name+'.js','utf8');
type Data=Record<string,unknown>;
function view(turn:Data) {
  const chat={escape:(v:string)=>String(v).replaceAll('<','&lt;'),millyView:{} as {html:(d:Data,stock:boolean)=>string}};
  runInNewContext(script('-view'),{window:{Caixa:{chat}}});
  return chat.millyView.html({turns:[turn],selected:turn.id,opened:turn.id,orderOpen:true},true);
}
const order={id:'pedido',numero:'PED-01',total_centavos:8000,itens:[]};
const consultation={id:'av',estado:'consumed',decisao:'aceitar',aval_centavos:8000,proposta_centavos:8000,
  solicitada_em:'2026-11-18T15:00:02Z',decidida_em:'2026-11-18T15:00:13Z',tempo_milly_ms:11000,justificativa:'Giro <privado>'};
const turn={id:'t',numero:62,cliente:{texto:'<cliente>',em:'2026-11-18T15:00:00Z'},
  atendente:{texto:'<resposta>',em:'2026-11-18T15:00:15Z'},tempo_resposta_ms:15000};
describe('análise da Milly no chat da Matriz',()=>{
  it('exibe falas escapadas, decisão estruturada, situação efetiva, divisão do tempo e pedido conferido',()=>{
    const html=view({...turn,consulta:{...consultation,pedido:order}});
    for(const value of ['Turno 62','&lt;cliente>','&lt;resposta>','&lt;privado>','Oferta utilizada','Aceitar a proposta','15 s','11 s','2 s','Valores conferem','PED-01'])expect(html).toContain(value);
    expect(html).not.toMatch(/<cliente>|<resposta>|<privado>/);
    expect(html).toContain('ficha histórica de estoque e custos está indisponível');
    const sidebar=html.slice(html.indexOf('<aside'));
    expect(sidebar.indexOf('Dados na consulta')).toBeLessThan(sidebar.indexOf('Conferência do pedido'));
  });
  it('compara somente o pedido vinculado à consulta, com totais em centavos',()=>{
    expect(view({...turn,consulta:{...consultation,pedido:{...order,total_centavos:7999}}})).toContain('Divergência de valores');
    const html=view({...turn,pedido:order,consulta:{...consultation,pedido:null}});
    expect(html).toContain('Sem comparação disponível');
    expect(html).not.toContain('Valores conferem');
  });
  it('trata o turno sem consulta, a espera e o estado expirado sem criar parecer ou fala pública',()=>{
    expect(view({...turn,consulta:null})).toContain('Sem consulta à Milly neste turno.');
    const pending={...turn,atendente:null,consulta:{estado:'pending'}};
    const html=view(pending);
    expect(html).toContain('Aguardando parecer');
    expect(html).toContain('Sem resposta pública vinculada');
    expect(html).not.toContain('Milly → Atendente');
    expect(view({...pending,consulta:{...consultation,estado:'expired'}})).toContain('Prazo encerrado');
  });
});
type Click = (e:{target:{closest:()=>unknown}})=>void;
function mounted(){
  function element() {
    return {dataset:{} as Record<string,string>,hidden:true,innerHTML:'',scrollTop:0,
      classList:{toggle:vi.fn()},setAttribute:vi.fn(),removeAttribute:vi.fn(),getClientRects:()=>[],
      replaceChildren(){this.innerHTML='';},addEventListener:vi.fn(),contains:()=>false,hasAttribute:(_key:string)=>false};
  }
  const nodes=new Map<string,ReturnType<typeof element>>();
  const el=(id:string)=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)!;};
  const state={id:'A',active:true,session:'sessao',generation:1,filter:'all'};
  const req=vi.fn(),chat={state,el,millyView:{html:(data:{turns:{id:string}[]})=>JSON.stringify(data.turns)},path:(id:string)=>'/chat/'+id,api:req,milly:{} as {sync:()=>void;reset:()=>void}};
  const app={adminUser:{role:'owner',auth_type:'session'}};
  runInNewContext(script(''),{window:{FarejadorBotChat:{chat,app,chatMountId:'root',isAuthenticated:()=>true,sessionFingerprint:()=>state.session,canOpenStock:()=>true}},
    document:{activeElement:null,hidden:false},setTimeout,clearTimeout,AbortController,URLSearchParams,Date});
  const click=el('panel').addEventListener.mock.calls.find(args=>args[0]==='click')![1] as Click;
  return {state,chat,app,req,el,click:(target:ReturnType<typeof element>)=>click({target:{closest:()=>target}})};
}
it('descarta a resposta de outra conversa e elimina a ficha quando muda o acesso',async()=>{
  const {chat,app,state,req,el,click}=mounted();
  let finish!:(page:unknown)=>void;
  req.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  chat.milly.sync();click(el('milly-tab'));
  req.mockResolvedValueOnce({turns:[{id:'histórico B'}],next:null});
  state.id='B';chat.milly.sync();
  await vi.waitFor(()=>expect(el('milly-analysis').innerHTML).toContain('histórico B'));
  finish({turns:[{id:'histórico A'}],next:null});await new Promise(resolve=>setTimeout(resolve,0));
  expect(el('milly-analysis').innerHTML).not.toContain('histórico A');
  app.adminUser.role='admin';chat.milly.sync();
  expect(el('milly-analysis').innerHTML).toBe('');expect(el('milly-filter').hidden).toBe(true);
});
it('usa o cursor recebido e evita reler páginas antigas a cada atualização automática',async()=>{
  const {chat,req,el,click}=mounted(),oldest={at:'2026-11-18T12:00:00.000123Z',id:'primeira'};
  req.mockResolvedValueOnce({turns:[{id:'primeira'}],next:oldest});
  chat.milly.sync();click(el('milly-tab'));
  await vi.waitFor(()=>expect(el('milly-analysis').innerHTML).toContain('primeira'));
  const older=el('carregar');older.hasAttribute=(key:string)=>key==='data-milly-older';
  req.mockResolvedValueOnce({turns:[{id:'anterior'}],next:null});click(older);
  await vi.waitFor(()=>expect(el('milly-analysis').innerHTML).toContain('anterior'));
  expect(req.mock.calls[1]![0]).toBe('/chat/A/milly?'+new URLSearchParams({at:oldest.at,before:oldest.id}));
  const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+30000);
  try {chat.milly.sync();expect(req).toHaveBeenCalledTimes(2);} finally {clock.mockRestore();}
});
