import Fastify from 'fastify';
import {beforeEach,describe,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({env:{FAREJADOR_ENV:'test',MATRIZ_CENTRAL_LEDGER:true,MATRIZ_CENTRAL_LEDGER_READ:true,ADMIN_BEARER_FALLBACK_ENABLED:false},
  session:vi.fn(),create:vi.fn(),reverse:vi.fn()}));
vi.mock('../../../src/shared/config/env.js',()=>({env:m.env}));
vi.mock('../../../src/admin/session.js',()=>({ADMIN_SESSION_COOKIE:'farejador_matriz_session',validateMatrizAdminSession:m.session}));
vi.mock('../../../src/admin/painel/manual-finance-entry.js',()=>({createManualFinanceEntry:m.create,reverseManualFinanceEntry:m.reverse}));
const id='10000000-0000-4000-8000-000000000001';
const body={kind:'income',category:'servicos',amount:150.5,occurred_at:'2026-09-02T12:00:00-03:00',description:'Serviço recebido',
  payment_method:'pix',cash_account:'Caixa principal',idempotency_key:id};
async function send(payload:object,options:{auth?:boolean;origin?:string;reverse?:boolean}={}){
  const app=Fastify();const {registerFinanceEntryRoutes}=await import('../../../src/admin/painel/route-financeiro-entries.js');await registerFinanceEntryRoutes(app);
  try{return await app.inject({method:'POST',url:'/admin/api/matriz/financeiro/entries'+(options.reverse?'/'+id+'/reverse':''),payload,
    headers:{...(options.auth===false?{}:{cookie:'farejador_matriz_session=test'}),origin:options.origin||'http://localhost:80'}});}
  finally{await app.close();}
}
beforeEach(()=>{vi.clearAllMocks();m.env.MATRIZ_CENTRAL_LEDGER_READ=true;
  m.session.mockResolvedValue({role:'owner',authType:'session',displayName:'Proprietário',modules:['financeiro']});m.create.mockResolvedValue({id});});
describe('autorização e validação de entradas',()=>{
  it('exige sessão de proprietário e mesma origem',async()=>{
    expect((await send(body,{auth:false})).statusCode).toBe(401);
    m.session.mockResolvedValue({role:'admin',modules:['financeiro']});expect((await send(body)).statusCode).toBe(403);
    m.session.mockResolvedValue({role:'owner',authType:'session',displayName:'Owner'});
    expect((await send(body,{origin:'https://other.invalid'})).statusCode).toBe(403);expect(m.create).not.toHaveBeenCalled();
  });
  it('recusa livro desligado, valores ou campos arbitrários',async()=>{
    for(const patch of [{amount:-1},{amount:1.005},{environment:'prod'},{account_class:'equity'}])
      expect((await send({...body,...patch})).statusCode).toBe(400);
    m.env.MATRIZ_CENTRAL_LEDGER_READ=false;expect((await send(body)).statusCode).toBe(409);expect(m.create).not.toHaveBeenCalled();
  });
  it('usa autor da sessão e não expõe detalhes internos',async()=>{
    const response=await send(body);expect(response.statusCode).toBe(201);expect(response.headers['cache-control']).toContain('no-store');
    expect(m.create.mock.calls[0][1]).toContain('Proprietário');
    m.create.mockRejectedValue(new Error('secret SQL'));const fail=await send(body);expect(fail.statusCode).toBe(503);expect(fail.body).not.toContain('secret');
    m.create.mockRejectedValue(new Error('matriz_ledger_idempotency_conflict'));expect((await send(body)).statusCode).toBe(409);
  });
  it('estorna somente por ID válido, com motivo',async()=>{
    expect((await send({reason:'Erro de digitação',occurred_at:body.occurred_at,idempotency_key:id},{reverse:true})).statusCode).toBe(200);
    expect(m.reverse).toHaveBeenCalledWith(id,expect.objectContaining({reason:'Erro de digitação'}),expect.any(String));
  });
});
