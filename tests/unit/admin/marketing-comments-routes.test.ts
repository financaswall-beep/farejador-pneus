import Fastify from 'fastify';
import { describe,it,expect,vi,beforeEach } from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),dashboard:vi.fn(),health:vi.fn(),audit:vi.fn()}));
vi.mock('../../../src/admin/auth.js',()=>({getAdminContext:()=>({displayName:'Owner'}),requireAdminOwner:async(req:any,reply:any)=>{
  if(req.headers['x-owner']!=='yes')return reply.code(403).send({error:'forbidden'});
}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test'}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{query:mocks.query}}));
vi.mock('../../../src/social-comments/dashboard.js',()=>({commentsDashboard:mocks.dashboard}));
vi.mock('../../../src/social-comments/graph.js',()=>({CommentsGraph:class{health=mocks.health;},MetaCommentError:class extends Error{}}));
vi.mock('../../../src/admin/painel/marketing-audit.js',()=>({recordMarketingAudit:mocks.audit}));
import { registerMarketingComments } from '../../../src/admin/painel/route-marketing-comments.js';
import { MetaCommentError } from '../../../src/social-comments/graph.js';
describe('Comentários — APIs somente owner',()=>{
  beforeEach(()=>vi.clearAllMocks());
  async function app(){const a=Fastify();await registerMarketingComments(a);return a;}
  it.each(['/admin/api/marketing/comments','/admin/api/marketing/comments/pause','/admin/api/marketing/comments/connection'])('nega %s sem owner',async(url)=>{
    const a=await app();try{const response=await a.inject({method:url.endsWith('/comments')?'GET':'POST',url});expect(response.statusCode).toBe(403);expect(mocks.query).not.toHaveBeenCalled();expect(mocks.health).not.toHaveBeenCalled();}finally{await a.close();}
  });
  it('retorna estado de instalação sem tentar publicar',async()=>{
    mocks.dashboard.mockResolvedValue({ready:false,rows:[],total:0});const a=await app();
    try{const r=await a.inject({url:'/admin/api/marketing/comments',headers:{'x-owner':'yes'}});expect(r.statusCode).toBe(200);expect(r.json().ready).toBe(false);expect(mocks.health).not.toHaveBeenCalled();}finally{await a.close();}
  });
  it('retorna somente código seguro e etapa quando a Meta recusa a conexão',async()=>{
    mocks.health.mockRejectedValue(Object.assign(new MetaCommentError('meta_app_secret_mismatch'),{
      code:'meta_app_secret_mismatch',stage:'page',details:'secret-token',
    }));
    const a=await app();
    try{
      const r=await a.inject({method:'POST',url:'/admin/api/marketing/comments/connection',headers:{'x-owner':'yes'},payload:{}});
      expect(r.statusCode).toBe(502);
      expect(r.json()).toEqual({error:'meta_app_secret_mismatch',stage:'page'});
    }finally{await a.close();}
  });
  it('valida paginação e pausa e audita quem pausou',async()=>{
    mocks.query.mockResolvedValue({rows:[]});const a=await app();
    try{
      expect((await a.inject({url:'/admin/api/marketing/comments?page=-1',headers:{'x-owner':'yes'}})).statusCode).toBe(400);
      expect((await a.inject({method:'POST',url:'/admin/api/marketing/comments/pause',headers:{'x-owner':'yes'},payload:{paused:'false'}})).statusCode).toBe(400);
      expect((await a.inject({method:'POST',url:'/admin/api/marketing/comments/pause',headers:{'x-owner':'yes'},payload:{paused:true}})).statusCode).toBe(200);
      expect(mocks.query.mock.calls[0][1]).toEqual(['test',true,'Owner']);expect(mocks.audit).toHaveBeenCalled();
    }finally{await a.close();}
  });
});
