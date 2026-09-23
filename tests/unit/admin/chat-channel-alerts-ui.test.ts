import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
function setup(){const window:any={};runInNewContext(readFileSync('painel/public/chat-channel-alerts.js','utf8'),{window,URL,Date});return window.FarejadorChannelAlerts;}
const data={status:'ok',checked_at:'2026-09-23T12:00:00Z',channels:[
  {inbox_id:40,channel:'instagram',authorization:'reauthorization_required',reconnect_url:'https://chatwoot.test/app/accounts/2/inbox/40'},
  {inbox_id:34,channel:'facebook',authorization:'reauthorization_required',reconnect_url:'https://chatwoot.test/app/accounts/2/inbox/34'},
]};
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
describe('avisos dos canais no atendimento',()=>{
  it('mostra as duas redes na fila, só a caixa afetada na conversa e nenhum alerta em WhatsApp',()=>{
    const ui=setup();expect(ui.notices(data)).toHaveLength(2);
    expect(ui.notices(data,40).map((x:any)=>x.title)).toEqual(['Instagram desconectado']);
    expect(ui.notices(data,34).map((x:any)=>x.title)).toEqual(['Facebook desconectado']);expect(ui.notices(data,39)).toEqual([]);
  });
  it('retira o aviso depois de confirmar a autorização, sem prometer entrega',()=>{
    const ui=setup(),element:any={};ui.render(element,data);expect(element.hidden).toBe(false);
    ui.render(element,{...data,channels:data.channels.map(c=>({...c,authorization:'no_reauthorization_required'}))});
    expect(element.hidden).toBe(true);expect(element.innerHTML).toBe('');
  });
  it('distingue indisponibilidade de desconexão e identifica aviso anterior',()=>{
    const ui=setup(),notices=ui.notices({...data,status:'unavailable'});
    expect(notices[0].title).toContain('indisponível');expect(notices[0].disconnected).toBe(false);
    expect(notices[1].text).toContain('Último aviso registrado');
    expect(ui.notices({...data,channels:[{...data.channels[0],authorization:'unknown'}]})[0].disconnected).toBe(false);
  });
  it('rejeita links executáveis ou com credenciais',()=>{
    const ui=setup(),element:any={};for(const url of ['javascript:alert(1)','https://user:secret@test.local']){
      ui.render(element,{...data,channels:[{...data.channels[0],reconnect_url:url}]});expect(element.innerHTML).not.toContain('href=');
    }
  });
  it('não consulta a cada poll das mensagens e descarta respostas após logout',async()=>{
    const ui=setup(),element:any={};let session='one',active=true;
    const request=vi.fn().mockResolvedValue(data),controller=ui.create({request,targets:()=>[{element}],session:()=>session,active:()=>active});
    await controller.refresh();await controller.refresh();expect(request).toHaveBeenCalledTimes(1);
    let resolve!:(v:any)=>void;request.mockReturnValue(new Promise(r=>resolve=r));await vi.advanceTimersByTimeAsync(30001);
    const work=controller.refresh();controller.reset();session='two';resolve(data);await work;
    expect(element.hidden).toBe(true);active=false;await controller.refresh();expect(request).toHaveBeenCalledTimes(2);
  });
  it('mantém alerta anterior em falha temporária e recupera no próximo ciclo',async()=>{
    const ui=setup(),element:any={},request=vi.fn().mockResolvedValueOnce(data).mockRejectedValueOnce(Error('network'))
      .mockResolvedValueOnce({...data,channels:[]});
    const c=ui.create({request,targets:()=>[{element}],session:()=> 'one',active:()=>true});
    await c.refresh();await vi.advanceTimersByTimeAsync(30001);await c.refresh();
    expect(element.innerHTML).toContain('Instagram desconectado');expect(element.innerHTML).toContain('Último aviso registrado');
    await vi.advanceTimersByTimeAsync(15001);await c.refresh();expect(element.hidden).toBe(true);
  });
});
