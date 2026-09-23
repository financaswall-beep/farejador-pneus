import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {parseOperatorMedia} from '../../../src/admin/caixa/chat-media.js';

function mediaApp(){
  const elements=new Map<string,any>();
  const el=(id:string)=>{if(!elements.has(id))elements.set(id,{classList:{toggle:vi.fn()},setAttribute:vi.fn(),addEventListener:vi.fn(),replaceChildren:vi.fn()});return elements.get(id);};
  let resolve!:(value:any)=>void;const permission=new Promise<any>(r=>{resolve=r;});
  const capture={getTracks:()=>[{stop}]},stop=vi.fn(),getUserMedia=vi.fn(()=>permission);
  const chat:any={state:{id:'one',active:true},el,icon:()=>'',setControl:vi.fn(),errorText:(e:any)=>e.message};
  const instances:any[]=[];
  class Recorder {
    static isTypeSupported=()=>true;state='inactive';onstop?:()=>void;ondataavailable?:(e:any)=>void;
    constructor(){instances.push(this);}start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['audio'])});this.onstop?.();}
  }
  runInNewContext(readFileSync('painel/public/caixa-chat-media.js','utf8'),{
    window:{Caixa:{chat,showToast:vi.fn()},MediaRecorder:Recorder},MediaRecorder:Recorder,navigator:{mediaDevices:{getUserMedia}},
    document:{createElement:()=>el('file'),body:{append:vi.fn()}},URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL:vi.fn()},Blob,
    setInterval,clearInterval,Date,
  });
  return {chat,el,resolve:()=>resolve(capture),stop,getUserMedia,instances};
}
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
describe('áudio e validação dos anexos',()=>{
  it('pede acesso ao microfone uma única vez mesmo com duplo toque',async()=>{
    const a=mediaApp(),first=a.el('mic').onclick();await a.el('mic').onclick();expect(a.getUserMedia).toHaveBeenCalledTimes(1);
    a.resolve();await first;expect(a.chat.recording).toBe(true);a.chat.resetMedia();expect(a.stop).toHaveBeenCalled();
  });
  it('fecha o microfone se a pessoa trocar de conversa durante a permissão',async()=>{
    const a=mediaApp(),start=a.el('mic').onclick();a.chat.resetMedia();a.chat.state.id='two';a.resolve();await start;
    expect(a.stop).toHaveBeenCalled();expect(a.instances).toHaveLength(0);expect(a.chat.media).toBeNull();
  });
  it('produz prévia para ouvir, sem enviar automaticamente ao parar',async()=>{
    const a=mediaApp(),start=a.el('mic').onclick();a.resolve();await start;a.chat.stopRecording();
    await Promise.resolve();expect(a.chat.recording).toBe(false);expect(a.chat.media.mime).toBe('audio/webm');
    expect(a.el('media-preview').innerHTML).toContain('<audio controls');expect(a.stop).toHaveBeenCalled();
  });
  it('recusa arquivo que só se apresenta como foto',async()=>{
    await expect(parseOperatorMedia({mime:'image/jpeg',base64:Buffer.from('<script>fake</script>').toString('base64')})).rejects.toThrow('chat_media_invalid');
  });
  it('mantém áudio WebM identificado para envio ao provedor',async()=>{
    const bytes=Buffer.from('1a45dfa301020304','hex');
    const result=await parseOperatorMedia({mime:'audio/webm',base64:bytes.toString('base64')});
    expect(result).toEqual({bytes,mime:'audio/webm',filename:'anexo.webm'});
  });
});
