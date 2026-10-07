import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe,expect,it,vi } from 'vitest';

const soundCode=readFileSync('painel/public/caixa-alert-sound.js','utf8');
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup() {
  const gestures=new Map<string,(event?:unknown)=>void>();
  let allowed=false,enabled=true,brokenFile=false,clock=0;
  const attempts:boolean[]=[];
  const player={muted:false,currentTime:0,preload:'',pause:vi.fn(),play:vi.fn(async()=>{
    attempts.push(player.muted);
    if(!allowed||brokenFile)throw new Error('play_rejected');
  })};
  const start=vi.fn(),stop=vi.fn();
  const context={state:'suspended',currentTime:0,destination:{},resume:vi.fn(async()=>{
    if(!allowed)throw new Error('resume_rejected');
    context.state='running';
  }),createOscillator:()=>({frequency:{value:0},type:'',connect:()=>({connect:vi.fn()}),start,stop}),
    createGain:()=>({gain:{setValueAtTime:vi.fn(),exponentialRampToValueAtTime:vi.fn()}})};
  const C:any={keys:{notifications:'sound'}};
  vm.runInNewContext(soundCode,{
    window:{Caixa:C,AudioContext:function(){return context;}},
    Audio:function(){return player;},Date:{now:()=>clock},Promise,
    localStorage:{getItem:()=>enabled?null:'false'},
    document:{addEventListener:(type:string,callback:(event?:unknown)=>void)=>gestures.set(type,callback)},
  });
  return {C,player,attempts,context,start,gestures,
    allow:()=>{allowed=true;},disable:()=>{enabled=false;C.setPhotoSoundEnabled(false);},
    breakFile:()=>{brokenFile=true;},advance:()=>{clock+=61000;},
    gesture:(type:string)=>gestures.get(type)!({isTrusted:true})};
}

describe('Som dos avisos depois de recarregar no celular',()=>{
  it('guarda o aviso bloqueado e toca no touchend válido, sem duplicar no click seguinte',async()=>{
    const s=setup();s.C.playPartnerAlert();expect(s.player.play).not.toHaveBeenCalled();
    s.gesture('pointerdown');await flush();expect(s.start).not.toHaveBeenCalled();
    s.allow();s.gesture('touchend');await flush();s.gesture('click');await flush();
    expect(s.attempts).toEqual([false,false]);
    expect(s.player.play).toHaveBeenCalledTimes(2);
  });
  it('a primeira liberação rejeitada não impede a próxima tentativa de emitir o aviso',async()=>{
    const s=setup();s.gesture('pointerdown');await flush();
    s.C.playPartnerAlert();expect(s.attempts).toEqual([true]);
    s.allow();s.gesture('click');await flush();
    expect(s.attempts).toEqual([true,false]);
  });
  it('depois de liberar o áudio, toca novos avisos recebidos sem outro toque',async()=>{
    const s=setup();s.allow();s.gesture('click');await flush();
    s.C.playPartnerAlert();await flush();s.C.playPartnerAlert();await flush();
    expect(s.attempts).toEqual([true,false,false]);
  });
  it('desativar o som cancela o aviso aguardando o primeiro toque',async()=>{
    const s=setup();s.C.playPartnerAlert();s.disable();s.allow();
    s.gesture('touchend');s.C.playPartnerAlert();await flush();
    expect(s.player.play).not.toHaveBeenCalled();expect(s.start).not.toHaveBeenCalled();
  });
  it('não toca um aviso antigo ao tocar na tela muito tempo depois',async()=>{
    const s=setup();s.C.playPartnerAlert();s.advance();s.allow();s.gesture('touchend');await flush();
    expect(s.attempts).toEqual([true]);expect(s.start).not.toHaveBeenCalled();
  });
  it('usa o sinal sintetizado apenas com contexto realmente liberado se o MP3 falhar',async()=>{
    const s=setup();s.C.playPartnerAlert();s.allow();s.breakFile();
    s.gesture('touchend');await flush();expect(s.start).toHaveBeenCalledTimes(2);
    expect(s.context.state).toBe('running');
    s.context.state='interrupted';s.gesture('click');await flush();
    expect(s.context.resume).toHaveBeenCalledTimes(2);expect(s.start).toHaveBeenCalledTimes(2);
  });
  it('sair da sessão descarta o aviso pendente antes do próximo toque',async()=>{
    const s=setup();s.C.playPartnerAlert();s.C.clearPartnerAlert();s.allow();
    s.gesture('click');await flush();expect(s.attempts).toEqual([true]);
  });
});

describe('Identidade dos pedidos de foto para avisos sonoros',()=>{
  it('um pedido novo toca mesmo quando substitui outro e o total não aumenta',async()=>{
    const element={classList:{toggle:vi.fn(),contains:()=>true,add:vi.fn(),remove:vi.fn()},
      querySelector:()=>({lastChild:{textContent:''}}),addEventListener:vi.fn(),textContent:''};
    const rows=[{id:'foto-a',status:'pending'},{id:'foto-b',status:'pending'}];
    let responseRows=[rows[0]];
    const C:any={state:{},keys:{notifications:'sound'},token:()=> 'session',isPartner:()=>true,
      operationPath:(path:string)=>path,sessionFingerprint:()=> 'session',json:(r:any)=>r.json(),
      authenticatedFetch:async()=>({ok:true,json:async()=>({photo_requests:responseRows})}),
      playPartnerAlert:vi.fn(),clearPartnerAlert:vi.fn(),showToast:vi.fn()};
    vm.runInNewContext(readFileSync('painel/public/caixa-photo.js','utf8'),{
      window:{Caixa:C,clearInterval:vi.fn(),clearTimeout:vi.fn()},
      document:{title:'Loja',getElementById:()=>element,querySelectorAll:()=>[]},console,
    });
    await C.loadPhotoRequests();responseRows=[rows[1]];
    await C.loadPhotoRequests();await C.loadPhotoRequests();
    expect(C.playPartnerAlert).toHaveBeenCalledTimes(2);
    C.stopPhotoNotifications();expect(C.clearPartnerAlert).toHaveBeenCalledOnce();
  });
});
