import Fastify from 'fastify';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({list:vi.fn(),resolve:vi.fn(),metrics:vi.fn(),report:vi.fn(),summary:vi.fn()}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminOwner:async(req:any,reply:any)=>{
  if(req.headers['x-owner']!=='yes')return reply.code(403).send({error:'forbidden'});
}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',ORGANIC_ATTRIBUTION_ENABLED:true}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/social-comments/config.js',()=>({commentsConfig:()=>({pageId:'100',instagramId:'200',token:'secret'})}));
vi.mock('../../../src/marketing/organic/results.js',()=>({organicResults:mocks.list,resolveOrganicResult:mocks.resolve,organicResultMetrics:mocks.metrics}));
vi.mock('../../../src/marketing/organic/report.js',()=>({organicAttributionReport:mocks.report}));
vi.mock('../../../src/admin/painel/queries-marketing-organic.js',()=>({organicPublicationSummary:mocks.summary}));
import {registerMarketingOrganicResults} from '../../../src/admin/painel/route-marketing-organic-results.js';
import {MetaCommentError} from '../../../src/social-comments/graph.js';
const base='/admin/api/marketing/organic/results';
const uuid='00000000-0000-4000-8000-000000000001';
describe('Resultados orgânicos — escopo autorizado',()=>{
  beforeEach(()=>vi.resetAllMocks());
  async function app(){const app=Fastify();await registerMarketingOrganicResults(app);return app;}
  it.each([base,base+'/instagram:301',base+'/publisher:'+uuid+'/metrics'])('exige owner antes de qualquer consulta %s',async url=>{
    const a=await app();try{expect((await a.inject({url})).statusCode).toBe(403);
      expect(mocks.list).not.toHaveBeenCalled();expect(mocks.resolve).not.toHaveBeenCalled();
    }finally{await a.close();}
  });
  it('recusa contas arbitrárias, redes inativas, chaves e janelas inválidas',async()=>{
    const a=await app();try{
      for(const url of [base+'?account=999',base+'/youtube:301',base+'/publisher:invalid',
        base+'/instagram:301?network=youtube',base+'/instagram:301/metrics?days=all',base+'/instagram:301/metrics?refresh=1']){
        expect((await a.inject({url,headers:{'x-owner':'yes'}})).statusCode).toBe(400);
      }
      expect(mocks.resolve).not.toHaveBeenCalled();
    }finally{await a.close();}
  });
  it('relatório conjunto inclui somente os destinos com publicação confirmada',async()=>{
    const references=[{platform:'instagram',account_id:'200',post_id:'301',status:'published'},
      {platform:'facebook',account_id:'100',post_id:'302',status:'uncertain'}];
    mocks.resolve.mockResolvedValue({key:'publisher:'+uuid,published_at:'2026-09-29T12:00:00Z',deliveries:references});
    mocks.summary.mockResolvedValue({available:true});mocks.report.mockResolvedValue({status:'ready'});
    const a=await app();try{
      const response=await a.inject({url:base+'/publisher:'+uuid,headers:{'x-owner':'yes'}});
      expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
      expect(mocks.report).toHaveBeenCalledWith({},'test','instagram','200','301','2026-09-29T12:00:00Z','7d',[references[0]]);
    }finally{await a.close();}
  });
  it('selecionar uma rede filtra a fonte comercial sem inventar resultado de destino incerto',async()=>{
    mocks.resolve.mockResolvedValue({published_at:'2026-09-29T12:00:00Z',deliveries:[
      {platform:'instagram',account_id:'200',post_id:'301',status:'published'},
      {platform:'facebook',account_id:'100',post_id:'302',status:'uncertain'}]});
    const a=await app();try{
      const response=await a.inject({url:base+'/publisher:'+uuid+'?network=facebook',headers:{'x-owner':'yes'}});
      expect(response.json().attribution.status).toBe('disabled');expect(mocks.report).not.toHaveBeenCalled();
      expect(mocks.summary).not.toHaveBeenCalled();
    }finally{await a.close();}
  });
  it('post de outra conta nunca libera métricas nem consulta comercial',async()=>{
    mocks.resolve.mockRejectedValue(new MetaCommentError('meta_post_owner_mismatch'));
    const a=await app();try{
      const r=await a.inject({url:base+'/instagram:301/metrics',headers:{'x-owner':'yes'}});
      expect(r.statusCode).toBe(404);expect(mocks.metrics).not.toHaveBeenCalled();expect(mocks.report).not.toHaveBeenCalled();
    }finally{await a.close();}
  });
});
