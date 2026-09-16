import Fastify from 'fastify';
import { describe,expect,it,vi } from 'vitest';
const svc=vi.hoisted(()=>({create:vi.fn(),reverse:vi.fn(),read:vi.fn(),flags:{FAREJADOR_ENV:'test',MATRIZ_CENTRAL_LEDGER:true,MATRIZ_CENTRAL_LEDGER_READ:true}}));
vi.mock('../../../src/admin/auth.js',()=>({
  requireAdminAuth:async(r:any,p:any)=>{if(!r.headers.authorization)return p.code(401).send({error:'auth'});},
  requireAdminOwner:async(r:any,p:any)=>{if(r.headers.authorization!=='owner')return p.code(403).send({error:'owner'});},
}));
vi.mock('../../../src/shared/config/env.js',()=>({env:svc.flags}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error:vi.fn()}}));
vi.mock('../../../src/admin/painel/route-helpers.js',()=>({operatorLabel:()=> 'owner:test'}));
vi.mock('../../../src/admin/painel/matriz-finance-overview.js',()=>({getMatrizFinanceOverview:svc.read}));
vi.mock('../../../src/admin/painel/matriz-owner-withdrawal.js',()=>({createOwnerWithdrawal:svc.create,reverseOwnerWithdrawal:svc.reverse}));
import { registerFinanceiroOverview } from '../../../src/admin/painel/route-financeiro-overview.js';
const body={amount:100,occurred_at:'2026-09-01T12:00:00-03:00',reason:'Uso pessoal',payment_method:'dinheiro',cash_account:'Caixa principal',idempotency_key:'withdrawal-test-01'};
describe('rotas financeiras de retirada',()=>{
  it('exige autenticação, dono, flags e dados válidos, sem aceitar contas enviadas pelo cliente',async()=>{
    const app=Fastify(); await registerFinanceiroOverview(app);
    expect((await app.inject({url:'/admin/api/matriz/financeiro/overview?mes=2026-09'})).statusCode).toBe(401);
    const send=(payload:any,role='owner')=>app.inject({method:'POST',url:'/admin/api/matriz/financeiro/withdrawals',headers:{authorization:role},payload});
    expect((await send(body,'staff')).statusCode).toBe(403);
    for(const change of [{amount:-1},{amount:.001},{occurred_at:'2099-01-01T12:00:00Z'},{environment:'prod'},{reason:''},{account_class:'expense'}])expect((await send({...body,...change})).statusCode).toBe(400);
    svc.create.mockResolvedValueOnce({id:'new'}); expect((await send(body)).statusCode).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(body,'owner:test');
    svc.create.mockRejectedValueOnce(new Error('matriz_ledger_idempotency_conflict')); expect((await send(body)).statusCode).toBe(409);
    svc.flags.MATRIZ_CENTRAL_LEDGER_READ=false; expect((await send(body)).statusCode).toBe(409);svc.flags.MATRIZ_CENTRAL_LEDGER_READ=true;
    await app.close();
  });
});
