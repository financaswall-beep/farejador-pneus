import Fastify from 'fastify';
import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({env:{FAREJADOR_ENV:'test',MATRIZ_CUSTOMER_REGISTRY:true,ADMIN_BEARER_FALLBACK_ENABLED:false},
  session:vi.fn(),create:vi.fn(),update:vi.fn()}));
vi.mock('../../../src/shared/config/env.js',()=>({env:mocks.env}));
vi.mock('../../../src/admin/session.js',()=>({ADMIN_SESSION_COOKIE:'farejador_matriz_session',validateMatrizAdminSession:mocks.session}));
vi.mock('../../../src/admin/painel/customer-registry.js',()=>({createCustomerRegistry:mocks.create,updateCustomerRegistry:mocks.update}));
const id='10000000-0000-4000-8000-000000000001';
const fields={name:'João Silva',commercial_profile:'varejo',phone:'21999994321',email:'',document_number:'',postal_code:'',
  street:'',number:'',complement:'',neighborhood:'',city:'',state:''};
async function send(body:object,options:{method?:'POST'|'PUT';auth?:boolean;origin?:string}={}) {
  const app=Fastify();
  const {registerCustomerRegistryRoutes}=await import('../../../src/admin/painel/route-customer-registry.js');
  await registerCustomerRegistryRoutes(app);
  try { return await app.inject({method:options.method || 'POST',url:options.method==='PUT'?`/admin/api/clientes/chatwoot/${id}/cadastro`:'/admin/api/clientes/cadastro',payload:body,
    headers:{...(options.auth===false?{}:{cookie:'farejador_matriz_session=ms_test'}),origin:options.origin || 'http://localhost:80'}}); }
  finally {await app.close();}
}
beforeEach(()=>{vi.clearAllMocks();mocks.env.MATRIZ_CUSTOMER_REGISTRY=true;
  mocks.session.mockResolvedValue({role:'owner',displayName:'Owner',modules:['clientes']});mocks.create.mockResolvedValue({source:'balcao',source_id:id});});
describe('escritas de Clientes',()=>{
  it('exige proprietário e mesma origem',async()=>{
    expect((await send({...fields,idempotency_key:id},{auth:false})).statusCode).toBe(401);
    mocks.session.mockResolvedValue({role:'admin',modules:['clientes']});
    expect((await send({...fields,idempotency_key:id})).statusCode).toBe(403);
    mocks.session.mockResolvedValue({role:'owner',modules:['clientes']});
    expect((await send({...fields,idempotency_key:id},{origin:'https://evil.invalid'})).statusCode).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('não grava se a feature estiver desligada',async()=>{
    mocks.env.MATRIZ_CUSTOMER_REGISTRY=false;
    expect((await send({...fields,idempotency_key:id})).statusCode).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('valida também fora do navegador e não permite escolher ambiente',async()=>{
    for (const patch of [{phone:'2548825'},{environment:'prod'},{document_number:'123'}])
      expect((await send({...fields,idempotency_key:id,...patch})).statusCode).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('grava somente campos normalizados e ambiente do servidor',async()=>{
    expect((await send({...fields,idempotency_key:id})).statusCode).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith('test',expect.objectContaining({phone:'+5521999994321'}),id,'Owner');
  });
  it('trata conflito sem expor dados ou SQL',async()=>{
    mocks.update.mockRejectedValue(new Error('registry_version_conflict'));
    expect((await send({...fields,expected_version:0},{method:'PUT'})).statusCode).toBe(409);
    mocks.create.mockRejectedValue(new Error('secret SQL / personal data'));
    const result=await send({...fields,idempotency_key:id});
    expect(result.statusCode).toBe(503);expect(result.body).not.toContain('secret');
  });
});
