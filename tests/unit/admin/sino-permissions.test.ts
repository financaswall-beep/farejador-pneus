import { afterEach, describe, expect, it, vi } from 'vitest';

const fixtures=vi.hoisted(()=>({
  context: {authType:'session',role:'admin',modules:['resumo'],displayName:'Teste'},
  data:{entregas_falhadas:[{order_id:'test'}],fiado_vencido:{count:2,total:'600'},
    a_pagar_vencido:{count:1,total:'400'},ledger_health:{status:'red'},galpao_repor:[{measure:'test'}],
    bot_reservations_expiring:1,bot_reservation_expiry_failures:{count:1,orders:[]},
    normalization_failed:1,bot_resilience:{enabled:true,dead_letters:1},future_private_field:'never expose'},
}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',ADMIN_BEARER_FALLBACK_ENABLED:false}}));
vi.mock('../../../src/admin/session.js',()=>({ADMIN_SESSION_COOKIE:'farejador_matriz_session',
  validateMatrizAdminSession:async()=>fixtures.context}));
vi.mock('../../../src/admin/painel/queries.js',()=>({getMatrizNotificacoes:async()=>fixtures.data}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{error(){},warn(){}}}));
import { registerPainelNotificacoes } from '../../../src/admin/painel/route-notificacoes.js';
import { requireAdminAuth } from '../../../src/admin/auth.js';

function request(url='/admin/api/matriz/notificacoes') {
  return {url,routeOptions:{url},method:'GET',protocol:'https',ip:'203.0.113.99',
    headers:{host:'example.test',cookie:'farejador_matriz_session=ms_test'},log:{warn(){}}} as any;
}
function reply() {
  return {statusCode:200,sent:false,payload:null as any,headers:{} as any,
    header(k: string,v: string){this.headers[k]=v;return this;},
    status(v: number){this.statusCode=v;return this;},send(v: any){this.payload=v;this.sent=true;return this;}};
}
async function call() {
  let route: any;
  await registerPainelNotificacoes({get:(url: string,options: any,handler: any)=>{route={url,options,handler};}} as any);
  const req=request(),rep=reply();await route.options.preHandler(req,rep);
  if(!rep.sent)await route.handler(req,rep);return rep;
}
afterEach(()=>{fixtures.context.role='admin';fixtures.context.modules=['resumo'];});
describe('permissões reais do sino, incluindo o preHandler de autenticação',()=>{
  it('Resumo não recebe valores financeiros nem outros módulos',async()=>{
    const forbidden=reply();await requireAdminAuth(request('/admin/api/financeiro/visao-geral'),forbidden as any);
    expect(forbidden.statusCode).toBe(403);
    const rep=await call();expect(rep.statusCode).toBe(200);expect(rep.payload).toEqual({});
    expect(rep.headers['Cache-Control']).toBe('no-store');
  });
  it.each([
    ['financeiro',['fiado_vencido','a_pagar_vencido','ledger_health']],
    ['estoque',['galpao_repor']],['logistica',['entregas_falhadas']],
    ['retiradas',['bot_reservations_expiring']],
    ['bot',['bot_resilience','bot_reservation_expiry_failures','normalization_failed']],
    ['rede',[]],['vendas',[]],
  ])('permite %s sem exigir Resumo e entrega somente seus campos',async(module,fields)=>{
    fixtures.context.modules=[module as string];const rep=await call();expect(rep.statusCode).toBe(200);
    expect(Object.keys(rep.payload).sort()).toEqual([...fields].sort());
  });
  it('combina módulos, mantendo a lista explícita de campos permitidos',async()=>{
    fixtures.context.modules=['financeiro','estoque'];const rep=await call();
    expect(Object.keys(rep.payload).sort()).toEqual(['a_pagar_vencido','fiado_vencido','galpao_repor','ledger_health']);
  });
  it('dono recebe os nove campos conhecidos, sem campos futuros por acidente',async()=>{
    fixtures.context.role='owner';fixtures.context.modules=[];const rep=await call();
    expect(Object.keys(rep.payload)).toHaveLength(9);expect(rep.payload).not.toHaveProperty('future_private_field');
  });
  it('bloqueia sessão ausente ou sem módulos',async()=>{
    fixtures.context.modules=[];expect((await call()).statusCode).toBe(403);
    const req=request();req.headers.cookie='';const rep=reply();await requireAdminAuth(req,rep as any);
    expect(rep.statusCode).toBe(401);
  });
});
