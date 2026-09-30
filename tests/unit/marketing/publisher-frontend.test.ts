import {it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
function state() {
  const window:any={MARKETING_PUBLISHER_TEMPLATE:'static',confirm:()=>true,lucide:{createIcons:()=>undefined}};
  const context=createContext({window,crypto:{randomUUID},setTimeout:()=>0,clearTimeout:()=>undefined,Intl,Date});
  runInContext(readFileSync('painel/public/app.marketing.publisher.helpers.js','utf8'),context);
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
it('conta identificada sem permissão não habilita envio e informa o que falta',async()=>{
  const s=state();s.mpConfig={sending:true};s.mpMedia=[{id:'media',kind:'photo'}];s.mpForm.media_id='media';
  s.mpConnections=[{platform:'facebook',verified:true,permissions_checked:true,publish_allowed:false,missing_permissions:['pages_manage_posts']}];
  expect(s.mpConnectionLabel('facebook')).toContain('Faltam permissões');
  expect(s.mpMissingPermissions('facebook')).toBe('pages_manage_posts');
  await s.mpSubmit();expect(s.apiPost).not.toHaveBeenCalled();expect(s.apiPut).not.toHaveBeenCalled();
  s.mpForm.destinations[1].selected=false;expect(s.mpKnownPermissionBlock()).toBe(false);
});
it('aviso da biblioteca mantém calendário e histórico acessíveis',async()=>{
  const s=state();s.apiGet.mockResolvedValue({config:{enabled:true},posts:[{id:'one',status:'scheduled'}],media:[],warnings:['publisher_library_unavailable']});
  await s.mpLoad();expect(s.mpPosts).toHaveLength(1);expect(s.mpWarnings).toEqual(['publisher_library_unavailable']);expect(s.mpError).toBe('');
});
it('mídia pendente não pode ser selecionada e miniatura ausente usa imagem substituta',()=>{
  const s=state();s.mpSelectMedia({id:'pending',name:'video.mov',kind:'video',status:'uploading'});
  expect(s.mpForm.media_id).toBe(null);expect(s.mpThumbnail({thumbnail_url:null})).toContain('data:image/svg+xml');
});
it('vídeo legado precisa de inspeção no servidor antes de voltar à seleção',()=>{
  const s=state();const media={id:'legacy',name:'antigo.mov',kind:'video',status:'ready',can_finalize:true,inspection:null};
  s.mpMedia=[media];s.mpForm.media_id='legacy';expect(s.mpSelectedMedia()).toBe(null);
  expect(s.mpMediaNeedsRecovery(media)).toBe(true);expect(s.mpMediaCanFinalize(media)).toBe(true);
  media.inspection={verified:true} as any;expect(s.mpSelectedMedia()).toBe(media);
});
it('arquivo pendente pode ser conferido mesmo quando a página fechou antes de finalizar',()=>{
  const s=state();const media={id:'pending',status:'uploading',can_finalize:true,upload_completed_at:null};
  expect(s.mpMediaCanFinalize(media)).toBe(true);expect(s.mpMediaReceived(media)).toBe(false);
});
it('falha ao verificar contas não mantém uma confirmação antiga na interface',async()=>{
  const s=state();s.mpConnections=[{platform:'facebook',verified:true,permissions_checked:true,publish_allowed:true}];
  s.apiPost.mockRejectedValue(Error('publisher_permissions_unavailable'));await s.mpCheckConnections();
  expect(s.mpConnectionLabel('facebook')).toBe('Permissões ainda não conferidas');
});
it('conferência incerta exige confirmação e mantém formulário quando a Meta não comprova ausência',async()=>{
  const s=state();s.mpOpenReconciliation({id:'post',title:'Pneu',version:3},{platform:'instagram',status:'uncertain',provider_id:'123'});
  s.mpReconciliation.note='Conferi a conta e o conteúdo.';s.mpReconciliation.decision='not_published';
  await s.mpReconcile();expect(s.apiPost).not.toHaveBeenCalled();
  s.mpReconciliation.confirmed=true;s.apiPost.mockRejectedValue(Error('publisher_reconciliation_ambiguous'));
  await s.mpReconcile();expect(s.mpReconciliation).not.toBe(null);expect(s.mpError).toContain('não permite confirmar');
  expect(s.apiPost.mock.calls).toEqual([['/admin/api/marketing/publisher/posts/post/reconcile',{
    version:3,platform:'instagram',decision:'not_published',confirmed:true,note:'Conferi a conta e o conteúdo.',
  }]]);
});
it('conferência publicada exige ID da Meta e informa conta incorreta sem liberar outro envio',async()=>{
  const s=state();s.mpOpenReconciliation({id:'post',title:'Pneu',version:3},{platform:'instagram',status:'uncertain'});
  Object.assign(s.mpReconciliation,{note:'Conferi o conteúdo na conta.',confirmed:true,provider_id:'https://instagram.com/p/shortcode'});
  await s.mpReconcile();expect(s.apiPost).not.toHaveBeenCalled();expect(s.mpError).toContain('ID numérico');
  s.mpReconciliation.provider_id='123';s.apiPost.mockRejectedValue(Error('meta_post_owner_mismatch'));
  await s.mpReconcile();expect(s.mpError).toContain('outra conta');expect(s.mpReconciliation).not.toBe(null);
});
it('conexão exibe token expirado sem apresentar permissão confirmada',()=>{
  const s=state();s.mpConnections=[{platform:'facebook',verified:true,permissions_checked:false,publish_allowed:false,error_code:'publisher_token_expired'}];
  expect(s.mpConnectionError('facebook')).toContain('expirou');expect(s.mpConnectionLabel('facebook')).toContain('não conferidas');
});
it('encerrar destino não envia retry e deixa de contar como atenção após conciliação',async()=>{
  const s=state();s.mpOpenReconciliation({id:'post',title:'Pneu',version:3},{platform:'facebook',status:'uncertain'});
  Object.assign(s.mpReconciliation,{note:'Conferi e prefiro encerrar sem reenviar.',decision:'abandon',confirmed:true});
  await s.mpReconcile();expect(s.apiPost).toHaveBeenCalledTimes(1);expect(s.mpReconciliation).toBe(null);
  s.mpPosts=[{status:'partial',deliveries:[{status:'published'},{status:'cancelled'}]},{status:'failed',deliveries:[{status:'uncertain'}]}];
  expect(s.mpAttention()).toBe(1);
  expect(s.mpStatus('partial')).toBe('Publicado parcialmente');
});
