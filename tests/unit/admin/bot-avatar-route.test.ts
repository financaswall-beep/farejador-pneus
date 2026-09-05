import Fastify from 'fastify';
import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(() => ({ avatar:vi.fn(),session:vi.fn(),
  env:{ FAREJADOR_ENV:'test',MATRIZ_CUSTOMER_IDENTITY:false,ADMIN_BEARER_FALLBACK_ENABLED:false } }));
vi.mock('../../../src/shared/config/env.js',() => ({ env:mocks.env }));
vi.mock('../../../src/admin/session.js',() => ({ ADMIN_SESSION_COOKIE:'farejador_matriz_session',validateMatrizAdminSession:mocks.session }));
vi.mock('../../../src/admin/painel/customer-lead-avatar.js',() => ({ getCustomerLeadAvatar:mocks.avatar }));
vi.mock('../../../src/admin/painel/bot-conversation-control.js',() => ({
  changeBotConversationControl:vi.fn(),getBotConversationControl:vi.fn(),listHumanControlledConversations:vi.fn(),
}));
vi.mock('../../../src/admin/painel/route-helpers.js',() => ({ operatorLabel:() => 'fixture' }));
import { registerBotControlRoutes } from '../../../src/admin/painel/route-bot-control';
const id='10000000-0000-4000-8000-000000000001';
const url=`/admin/api/bot/conversations/${id}/avatar`;
const headers={ cookie:'farejador_matriz_session=ms_test' };
async function run(test:(app:ReturnType<typeof Fastify>)=>Promise<void>) {
  const app=Fastify();await registerBotControlRoutes(app);
  try { await test(app); } finally { await app.close(); }
}
beforeEach(() => {
  vi.clearAllMocks();mocks.env.MATRIZ_CUSTOMER_IDENTITY=false;
  mocks.session.mockResolvedValue({ role:'admin',modules:['bot'] });
  mocks.avatar.mockResolvedValue('https://chatwoot.example.test/avatar.png');
});
describe('foto na fila do Bot',() => {
  it('exige sessão e permissão Bot, sem exigir o módulo Clientes',() => run(async app => {
    expect((await app.inject(url)).statusCode).toBe(401);
    expect(mocks.avatar).not.toHaveBeenCalled();
    expect((await app.inject({ url,headers })).statusCode).toBe(200);
    mocks.avatar.mockClear();mocks.session.mockResolvedValue({ role:'admin',modules:['clientes'] });
    expect((await app.inject({ url,headers })).statusCode).toBe(403);
    expect(mocks.avatar).not.toHaveBeenCalled();
  }));
  it('preserva owner-only quando a proteção de identidade está ativa',() => run(async app => {
    mocks.env.MATRIZ_CUSTOMER_IDENTITY=true;
    expect((await app.inject({ url,headers })).statusCode).toBe(403);
    expect(mocks.avatar).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue({ role:'owner',modules:['bot'] });
    expect((await app.inject({ url,headers })).statusCode).toBe(200);
  }));
  it('retorna somente a referência no ambiente configurado e sem cache público',() => run(async app => {
    const res=await app.inject({ url,headers });
    expect(res.json()).toEqual({ avatar_url:'https://chatwoot.example.test/avatar.png' });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(mocks.avatar).toHaveBeenCalledWith(id,'test');
  }));
  it('valida UUID e não expõe detalhes de falhas internas',() => run(async app => {
    expect((await app.inject({ url:url.replace(id,'invalid'),headers })).statusCode).toBe(400);
    expect(mocks.avatar).not.toHaveBeenCalled();
    mocks.avatar.mockRejectedValue(new Error('internal-secret'));
    const res=await app.inject({ url,headers });
    expect(res.statusCode).toBe(503);expect(res.json()).toEqual({ error:'lead_avatar_unavailable' });
  }));
});
