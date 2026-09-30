import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
function state() {
  const window:any={MARKETING_PUBLISHER_TEMPLATE:'static',confirm:()=>true,lucide:{createIcons:()=>undefined}};
  const context=createContext({window,crypto:{randomUUID},setTimeout:()=>0,clearTimeout:()=>undefined,Intl,Date});
  runInContext(readFileSync('painel/public/app.marketing.publisher.js','utf8'),context);
  const s=window.PAINEL_MODULES.marketingPublisher();s.$nextTick=(fn:()=>void)=>fn();s.apiPut=vi.fn().mockResolvedValue({version:1});
  s.apiPost=vi.fn().mockResolvedValue({});s.apiGet=vi.fn().mockResolvedValue({config:{enabled:true},posts:[],media:[]});s.mpFresh();return s;
}
it('usa -03:00 independente do fuso do dispositivo e transmite apenas destinos selecionados',async()=>{
  const s=state();s.mpConfig={sending:true};s.mpMedia=[{id:'media',kind:'video'}];s.mpForm.media_id='media';s.mpForm.title='Pneus';s.mpWhen='schedule';
  const futureYear=new Date().getFullYear()+1;s.mpDate=futureYear+'-10-01';s.mpTime='09:00';s.mpForm.destinations[1].selected=false;
  await s.mpSubmit();expect(s.apiPost.mock.calls[0]?.[1]).toMatchObject({version:1,scheduled_at:futureYear+'-10-01T12:00:00.000Z'});
  expect(s.apiPut.mock.calls[0]?.[1].destinations).toHaveLength(1);expect(s.apiPut.mock.calls[0]?.[1]).not.toHaveProperty('environment');
});
it('falha de salvamento mantém o rascunho e impede submissão pública',async()=>{
  const s=state();s.mpConfig={sending:true};s.mpMedia=[{id:'media',kind:'photo'}];s.mpForm.media_id='media';s.mpForm.title='Pneus';s.mpDirty=true;
  s.apiPut.mockRejectedValue(Error('publisher_version_conflict'));const id=s.mpForm.id;
  await s.mpSubmit();expect(s.mpForm.id).toBe(id);expect(s.mpDirty).toBe(true);expect(s.apiPost).not.toHaveBeenCalled();expect(s.mpError).toContain('outra aba');
});
it('ao trocar vídeo/foto, ajusta apenas formatos incompatíveis e mantém Story',()=>{
  const s=state();s.mpForm.destinations[1].format='story';s.mpSelectMedia({id:'video',kind:'video',name:'a.mp4'});
  expect(s.mpForm.destinations.map((d:any)=>d.format)).toEqual(['reel','story']);s.mpSelectMedia({id:'photo',kind:'photo',name:'b.jpg'});
  expect(s.mpForm.destinations.map((d:any)=>d.format)).toEqual(['feed','story']);
});
it('modo demonstrativo impede salvar ou publicar mesmo após uso anterior de dados reais',async()=>{
  const s=state();s.marketingIsMock=()=>true;s.mpConfig={sending:true};s.mpMedia=[{id:'media',kind:'photo'}];s.mpForm.media_id='media';s.mpForm.title='Pneus';
  await s.mpSave();await s.mpSubmit();await s.mpAction({id:'post'},'retry');
  expect(s.apiPut).not.toHaveBeenCalled();expect(s.apiPost).not.toHaveBeenCalled();await s.mpLoad();expect(s.mpConfig.sending).toBe(false);
});
