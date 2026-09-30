import Fastify from 'fastify';
import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({query:vi.fn(),reserve:vi.fn(),submit:vi.fn(),draft:vi.fn(),caption:vi.fn(),enabled:true,sending:true}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminOwner:async(req:any,reply:any)=>{
  if(req.headers['x-role']!=='owner')return reply.code(403).send({error:'owner_required'});
},getAdminContext:()=>({displayName:'Owner',personId:'operator-test'})}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{query:m.query}}));
vi.mock('../../../src/marketing/publisher/config.js',()=>({publisherConfig:()=>({enabled:m.enabled,sending:m.sending,storage_ready:false}),
  requirePublisher:()=>{if(!m.enabled)throw Error('disabled');},requireSending:()=>{if(!m.sending)throw Error('disabled');}}));
vi.mock('../../../src/marketing/publisher/media.js',()=>({reserveMedia:m.reserve,finalizeMedia:vi.fn(),listMedia:vi.fn()}));
vi.mock('../../../src/marketing/publisher/posts.js',()=>({submitPost:m.submit,saveDraft:m.draft,postAction:vi.fn(),listPosts:async()=>[]}));
vi.mock('../../../src/marketing/publisher/caption.js',()=>({generateCaption:m.caption}));
import {registerMarketingPublisher} from '../../../src/admin/painel/route-marketing-publisher.js';
const base='/admin/api/marketing/publisher';const id='ad5e2be8-2725-4a4f-96a6-c77aceecdc80';
beforeEach(()=>{vi.clearAllMocks();m.enabled=true;m.sending=true;m.query.mockResolvedValue({rows:[{ready:true}]});m.submit.mockResolvedValue({id});});
it('owner-only antes de banco, upload, IA e publicação',async()=>{
  const app=Fastify();await registerMarketingPublisher(app);
  try{
    for(const [method,url] of [['GET',base],['POST',base+'/media'],['POST',base+'/caption'],['POST',base+'/posts/'+id+'/submit']] as const){
      expect((await app.inject({method,url,headers:{'x-role':'admin'},...(method==='POST'?{payload:{}}:{})})).statusCode).toBe(403);
    }
    expect(m.query).not.toHaveBeenCalled();expect(m.reserve).not.toHaveBeenCalled();expect(m.caption).not.toHaveBeenCalled();expect(m.submit).not.toHaveBeenCalled();
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
