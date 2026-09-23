import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

function deferred(){let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return {promise,resolve};}
function app(){
  const elements=new Map<string,any>();
  const element=(id:string)=>{if(!elements.has(id))elements.set(id,{value:'',classList:{add:vi.fn(),remove:vi.fn(),toggle:vi.fn()},setAttribute:vi.fn(),close:vi.fn()});return elements.get(id);};
  const C:any={authenticatedFetch:vi.fn(),json:async(r:any)=>r.json(),showToast:vi.fn(),sessionFingerprint:()=> 'fixture',token:()=> 'fixture',elements:{sessionView:element('view'),appHeadingTitle:element('title')}};
  const context={window:{Caixa:C},document:{getElementById:element,addEventListener:vi.fn(),body:element('body')},
    location:{hash:''},history:{replaceState:vi.fn()},URL:{revokeObjectURL:vi.fn()},URLSearchParams,AbortController,AbortSignal,TextDecoder,
    crypto:{randomUUID:()=> 'client-token'},setTimeout,clearTimeout,setInterval,clearInterval};
  runInNewContext(readFileSync('painel/public/caixa-chat.js','utf8'),context);
  const chat=C.chat;chat.renderConnection=vi.fn();chat.renderMedia=vi.fn();chat.resetMedia=vi.fn();chat.photoNotice=vi.fn();
  Object.assign(chat.state,{active:true,session:'fixture',id:'one',detail:{id:'one',mode:'human',version:1}});
  return {chat,C,element,context};
}
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
describe('estado assíncrono do chat da operação',()=>{
  it('descarta resposta antiga depois da troca de conversa',async()=>{
    const {chat}=app(),messages=deferred(),detail=deferred();
    chat.api=vi.fn().mockReturnValueOnce(messages.promise).mockReturnValueOnce(detail.promise);
    const loading=chat.loadThread();chat.state.id='two';chat.state.threadSeq++;
    messages.resolve({messages:[{id:'old',content:'antiga'}],outgoing:[],next:null});detail.resolve({id:'one'});await loading;
    expect(chat.state.messages.size).toBe(0);expect(chat.state.id).toBe('two');
  });
  it('impede duplo envio enquanto ainda está preparando o arquivo',async()=>{
    const {chat,element}=app(),file=deferred();chat.toBase64=()=>file.promise;chat.media={blob:{},mime:'audio/webm'};
    chat.api=vi.fn().mockResolvedValue({id:'outbound',status:'pending'});chat.loadThread=vi.fn();element('chat-input').value='Áudio';
    const first=chat.send();await chat.send();expect(chat.api).not.toHaveBeenCalled();
    file.resolve('base64');await first;expect(chat.api).toHaveBeenCalledTimes(1);
  });
  it('reutiliza a chave de envio após timeout sem criar segunda mensagem local',async()=>{
    const {chat,element}=app();element('chat-input').value='Resposta';chat.loadThread=vi.fn();
    chat.api=vi.fn().mockRejectedValueOnce(Error('network')).mockResolvedValueOnce({id:'accepted',status:'pending'});
    await chat.send();const pending=chat.state.pending.get('client-token');expect(pending.status).toBe('unknown');
    await chat.send(pending);expect(chat.state.pending.size).toBe(1);
    expect(chat.api.mock.calls[0][1].body).toBe(chat.api.mock.calls[1][1].body);
  });
  it('não deixa anexo de sessão anterior reaparecer após logout',async()=>{
    const {chat}=app(),file=deferred();chat.toBase64=()=>file.promise;chat.media={blob:{},mime:'audio/webm'};chat.api=vi.fn();
    const sending=chat.send();chat.reset();chat.state.session='outro';file.resolve('base64');await sending;
    expect(chat.api).not.toHaveBeenCalled();expect(chat.state.pending.size).toBe(0);expect(chat.state.sending).toBe(false);
  });
  it('preserva rascunhos ao alternar entre clientes',()=>{
    const {chat,element}=app();chat.loadThread=vi.fn();chat.loadAvatar=vi.fn();element('chat-input').value='Texto de um';
    chat.open('two');expect(element('chat-input').value).toBe('');element('chat-input').value='Texto de dois';chat.open('one');
    expect(element('chat-input').value).toBe('Texto de um');expect(chat.state.drafts.get('two')).toBe('Texto de dois');
  });
  it('refaz a conexão autenticada quando o stream termina',async()=>{
    const {chat,C}=app();C.authenticatedFetch.mockResolvedValue({ok:true,body:{getReader:()=>({read:async()=>({done:true})})}});
    await chat.connect(chat.state.generation);expect(C.authenticatedFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);expect(C.authenticatedFetch).toHaveBeenCalledTimes(2);chat.stop();
    expect(C.authenticatedFetch.mock.calls[0][0]).toBe('/api/caixa/chat/stream');
  });
  it('carrega novamente as páginas abertas sem desaparecerem na atualização automática',async()=>{
    const {chat}=app();chat.state.offset=60;chat.state.rows=Array.from({length:60},(_,n)=>({id:String(n)}));
    const rows=chat.state.rows;chat.api=vi.fn().mockResolvedValueOnce({rows:rows.slice(0,30),has_more:true,total:60,needs_total:60})
      .mockResolvedValueOnce({rows:rows.slice(30),has_more:false});
    await chat.loadList();expect(chat.state.rows).toHaveLength(60);expect(chat.state.hasMore).toBe(false);
  });
});
