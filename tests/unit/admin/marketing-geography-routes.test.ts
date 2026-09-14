import Fastify from 'fastify';
import {describe,it,expect,vi,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),get:vi.fn(),save:vi.fn(),refresh:vi.fn(),owner:vi.fn(async(req:any,reply:any)=>{if(req.headers['x-test-owner']!=='yes')return reply.code(403).send({error:'forbidden'});})}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminOwner:mocks.owner,getAdminContext:()=>({displayName:'Owner'})}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{query:mocks.query}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',META_ADS_ACCOUNT_ID:'act_123'}}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn()}}));
vi.mock('../../../src/admin/painel/queries-marketing-geography.js',()=>({getMarketingGeography:mocks.get}));
vi.mock('../../../src/marketing/geography-sync.js',()=>({refreshGeographyObservations:mocks.refresh}));
import {registerMarketingGeography} from '../../../src/admin/painel/route-marketing-geography.js';
beforeEach(()=>{vi.clearAllMocks();mocks.query.mockResolvedValue({rows:[],rowCount:0});mocks.get.mockResolvedValue({records:[]});});
const headers={'x-test-owner':'yes'};
const payload={period:'30d',target:40,region:'São Gonçalo',percent:10,days:7,request_key:'00000000-0000-4000-8000-000000000001'};
async function request(options:any){const app=Fastify();await registerMarketingGeography(app);try{return await app.inject(options);}finally{await app.close();}}
describe('Geografia: autorização e planos',()=>{
  it.each(['/admin/api/marketing/geography','/admin/api/marketing/geography/refresh','/admin/api/marketing/geography/1/binding','/admin/api/marketing/geography/1/plans'])('exige owner: %s',async url=>{
    const r=await request({url,method:url.endsWith('/geography')?'GET':'POST',payload:url.endsWith('/geography')?undefined:{}});expect(r.statusCode).toBe(403);
  });
  it('valida filtros e sinaliza migration ausente sem responder com números zero',async()=>{
    expect((await request({url:'/admin/api/marketing/geography?target=-1',headers})).statusCode).toBe(400);
    mocks.get.mockRejectedValueOnce(Object.assign(Error('missing'),{code:'42P01'}));
    const r=await request({url:'/admin/api/marketing/geography',headers});expect(r.statusCode).toBe(503);expect(r.json().error).toBe('geography_migration_required');
  });
  it('recalcula a indicação e recusa plano quando as condições mudaram',async()=>{
    const r=await request({url:'/admin/api/marketing/geography/1/plans',method:'POST',headers,payload});expect(r.statusCode).toBe(409);expect(mocks.get).toHaveBeenCalledWith('30d',40);
  });
  it('recusa reutilizar chave de plano para outra campanha',async()=>{
    mocks.query.mockResolvedValueOnce({rows:[{id:'p1',ad_account_id:'act_123',campaign_id:'2',payload}],rowCount:1});
    const r=await request({url:'/admin/api/marketing/geography/1/plans',method:'POST',headers,payload});expect(r.statusCode).toBe(409);expect(mocks.get).not.toHaveBeenCalled();
  });
  it('repetir o mesmo pedido recupera o rascunho sem criar outro',async()=>{
    mocks.query.mockResolvedValueOnce({rows:[{id:'p1',ad_account_id:'act_123',campaign_id:'1',payload}],rowCount:1});
    const r=await request({url:'/admin/api/marketing/geography/1/plans',method:'POST',headers,payload});expect(r.statusCode).toBe(200);expect(r.json().id).toBe('p1');expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
