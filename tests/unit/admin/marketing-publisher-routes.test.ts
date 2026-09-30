import Fastify from 'fastify';
import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({query:vi.fn(),reserve:vi.fn(),complete:vi.fn(),listMedia:vi.fn(),listPosts:vi.fn(),
  bucket:vi.fn(),reconcile:vi.fn(),submit:vi.fn(),draft:vi.fn(),caption:vi.fn(),enabled:true,sending:true,storageReady:false}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminOwner:async(req:any,reply:any)=>{
  if(req.headers['x-role']!=='owner')return reply.code(403).send({error:'owner_required'});
},getAdminContext:()=>({displayName:'Owner',personId:'operator-test'})}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{query:m.query}}));
vi.mock('../../../src/marketing/publisher/config.js',()=>({publisherConfig:()=>({enabled:m.enabled,sending:m.sending,
  storage_ready:m.storageReady,max_file_bytes:524288000}),
  requirePublisher:()=>{if(!m.enabled)throw Error('disabled');},requireSending:()=>{if(!m.sending)throw Error('disabled');}}));
vi.mock('../../../src/marketing/publisher/media.js',()=>({reserveMedia:m.reserve,finalizeMedia:m.complete,listMedia:m.listMedia}));
vi.mock('../../../src/marketing/publisher/posts.js',()=>({submitPost:m.submit,saveDraft:m.draft,postAction:vi.fn(),listPosts:m.listPosts}));
vi.mock('../../../src/marketing/publisher/storage.js',()=>({PublisherStorage:class {assertPrivateBucket=m.bucket;}}));
vi.mock('../../../src/marketing/publisher/reconciliation.js',async()=>{
  const actual=await vi.importActual<typeof import('../../../src/marketing/publisher/reconciliation.js')>('../../../src/marketing/publisher/reconciliation.js');
  return {...actual,reconcileDestination:m.reconcile};
});
vi.mock('../../../src/marketing/publisher/caption.js',()=>({generateCaption:m.caption}));
import {registerMarketingPublisher} from '../../../src/admin/painel/route-marketing-publisher.js';
const base='/admin/api/marketing/publisher';const id='ad5e2be8-2725-4a4f-96a6-c77aceecdc80';
beforeEach(()=>{
  vi.clearAllMocks();m.enabled=true;m.sending=true;m.storageReady=false;
  m.query.mockResolvedValue({rows:[{ready:true}]});m.submit.mockResolvedValue({id});m.complete.mockResolvedValue({id});
  m.listMedia.mockResolvedValue([]);m.listPosts.mockResolvedValue([]);m.bucket.mockResolvedValue({maxBytes:null,allowedMimes:null});
  m.reconcile.mockResolvedValue({id,status:'cancelled'});
});
it('owner-only antes de banco, upload, IA e publicação',async()=>{
  const app=Fastify();await registerMarketingPublisher(app);
  try{
    for(const [method,url] of [['GET',base],['POST',base+'/media'],['POST',base+'/media/'+id+'/complete'],
      ['POST',base+'/caption'],['POST',base+'/posts/'+id+'/submit'],['POST',base+'/posts/'+id+'/reconcile']] as const){
      expect((await app.inject({method,url,headers:{'x-role':'admin'},...(method==='POST'?{payload:{}}:{})})).statusCode).toBe(403);
    }
    expect(m.query).not.toHaveBeenCalled();expect(m.reserve).not.toHaveBeenCalled();expect(m.caption).not.toHaveBeenCalled();
    expect(m.submit).not.toHaveBeenCalled();expect(m.complete).not.toHaveBeenCalled();expect(m.reconcile).not.toHaveBeenCalled();
  }finally{await app.close();}
});
it('falha da biblioteca preserva publicações e nunca devolve a mensagem externa',async()=>{
  const app=Fastify();await registerMarketingPublisher(app);
  try{
    m.storageReady=true;m.listPosts.mockResolvedValue([{id,status:'scheduled'}]);
    m.listMedia.mockRejectedValue(Error('https://storage.invalid?token=secret'));
    const result=await app.inject({url:base,headers:{'x-role':'owner'}});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({posts:[{id,status:'scheduled'}],media:[],warnings:['publisher_library_unavailable']});
    expect(result.body).not.toContain('secret');
  }finally{await app.close();}
});
it('falha no bucket bloqueia upload/publicação na tela e preserva histórico',async()=>{
  const app=Fastify();await registerMarketingPublisher(app);
  try{
    m.storageReady=true;m.listPosts.mockResolvedValue([{id,status:'published'}]);
    m.bucket.mockRejectedValue(Error('key=secret'));m.listMedia.mockResolvedValue([{id,thumbnail_url:null}]);
    const result=await app.inject({url:base,headers:{'x-role':'owner'}});
    expect(result.json()).toMatchObject({config:{sending:false,storage_ready:false,storage_credentials_ready:true},
      posts:[{id,status:'published'}],warnings:['publisher_storage_unavailable']});
    expect(result.body).not.toContain('secret');
    m.bucket.mockResolvedValue({maxBytes:104857600,allowedMimes:null});
    const recovered=await app.inject({url:base,headers:{'x-role':'owner'}});
    expect(recovered.json().config.max_file_bytes).toBe(104857600);
  }finally{await app.close();}
});
it('recupera a finalização sem exigir metadados e recusa escolha de ambiente',async()=>{
  const app=Fastify();await registerMarketingPublisher(app);
  try{
    const url=base+'/media/'+id+'/complete';
    expect((await app.inject({method:'POST',url,headers:{'x-role':'owner'},payload:{}})).statusCode).toBe(200);
    expect(m.complete.mock.calls[0]?.slice(1)).toEqual(['test',id,{}]);
    expect((await app.inject({method:'POST',url,headers:{'x-role':'owner'},payload:{environment:'prod'}})).statusCode).toBe(400);
    expect(m.complete).toHaveBeenCalledOnce();
  }finally{await app.close();}
});
it('conciliação exige confirmação e permite encerrar sem ativar envios',async()=>{
  const app=Fastify();await registerMarketingPublisher(app);
  try{
    m.sending=false;const url=base+'/posts/'+id+'/reconcile';
    const payload={version:2,platform:'instagram',decision:'abandon',confirmed:true,note:'Revisei na conta e encerrei sem reenviar.'};
    for(const invalid of [{...payload,confirmed:false},{...payload,environment:'prod'},
      {...payload,account_id:'999'},{...payload,platform:'tiktok'},{...payload,note:'x'}]) {
      expect((await app.inject({method:'POST',url,headers:{'x-role':'owner'},payload:invalid})).statusCode).toBe(400);
    }
    expect(m.reconcile).not.toHaveBeenCalled();
    expect((await app.inject({method:'POST',url,headers:{'x-role':'owner'},payload})).statusCode).toBe(200);
    expect(m.reconcile.mock.calls[0]?.slice(1,5)).toEqual(['test',id,payload,'Owner']);
  }finally{await app.close();}
});
it('ignora tentativas de escolher ambiente/conta e rejeita datas sem fuso horário',async()=>{
  const app=Fastify();await registerMarketingPublisher(app);
  try{
    for(const payload of [{version:1,scheduled_at:'2026-10-01T09:00:00'},{version:1,scheduled_at:null,environment:'prod'}]){
      expect((await app.inject({method:'POST',url:base+'/posts/'+id+'/submit',headers:{'x-role':'owner'},payload})).statusCode).toBe(400);
    }
    expect(m.submit).not.toHaveBeenCalled();
    const result=await app.inject({method:'POST',url:base+'/posts/'+id+'/submit',headers:{'x-role':'owner'},payload:{version:1,scheduled_at:'2026-10-01T09:00:00-03:00'}});
    expect(result.statusCode).toBe(200);expect(m.submit.mock.calls[0]?.slice(1)).toEqual(['test',id,1,'2026-10-01T09:00:00-03:00','Owner']);
  }finally{await app.close();}
});
it('status sem migration é explícito e nenhum segredo aparece em erros',async()=>{
  const app=Fastify();await registerMarketingPublisher(app);
  try{
    m.query.mockResolvedValue({rows:[{ready:false}]});const result=await app.inject({url:base,headers:{'x-role':'owner'}});
    expect(result.json()).toMatchObject({config:{schema_ready:false},posts:[],media:[]});expect(result.headers['cache-control']).toBe('no-store');
    m.reserve.mockRejectedValue(Error('token=secret-service-key'));
    const failure=await app.inject({method:'POST',url:base+'/media',headers:{'x-role':'owner'},payload:{id,name:'a.mp4',mime:'video/mp4',bytes:200}});
    expect(failure.statusCode).toBe(503);expect(failure.body).not.toContain('secret-service-key');
  }finally{await app.close();}
});
