import Fastify from 'fastify';
import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(() => ({ change:vi.fn(),get:vi.fn(),list:vi.fn() }));
vi.mock('../../../src/admin/painel/bot-conversation-control.js',() => ({
  changeBotConversationControl:mocks.change,getBotConversationControl:mocks.get,listHumanControlledConversations:mocks.list,
}));
vi.mock('../../../src/admin/auth.js',() => ({ requireAdminAuth:async (req:{ headers:Record<string,string> },reply:{ code:Function; send:Function }) => {
  if (req.headers.authorization!=='Bearer fixture') return reply.code(401).send({ error:'unauthorized' });
} }));
vi.mock('../../../src/admin/painel/route-helpers.js',() => ({ operatorLabel:() => 'fixture:operator' }));
vi.mock('../../../src/shared/logger.js',() => ({ logger:{ error:vi.fn() } }));
import { registerBotControlRoutes } from '../../../src/admin/painel/route-bot-control.js';
const id='10000000-0000-4000-8000-000000000001',url=`/admin/api/bot/conversations/${id}/controle`;
const headers={ authorization:'Bearer fixture' };
beforeEach(() => { vi.clearAllMocks();mocks.change.mockResolvedValue({ mode:'human',version:1 }); });
describe('controle administrativo por conversa',() => {
  it('exige autenticação para leitura e mutação',async () => {
    const app=Fastify();await registerBotControlRoutes(app);
    try {
      for (const method of ['GET','POST'] as const) expect((await app.inject({ method,url })).statusCode).toBe(401);
      expect(mocks.change).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('valida UUID, ação e versão e não aceita ambiente escolhido pelo navegador',async () => {
    const app=Fastify();await registerBotControlRoutes(app);
    try {
      for (const payload of [{ action:'all',expected_version:0 },{ action:'takeover' },
        { action:'resume',expected_version:0,environment:'prod' }]) {
        expect((await app.inject({ method:'POST',url,headers,payload })).statusCode).toBe(400);
      }
      expect(mocks.change).not.toHaveBeenCalled();
      expect((await app.inject({ method:'GET',url:url.replace(id,'invalid'),headers })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it('envia ação escopada e autoria interna sem enviar mensagem pública',async () => {
    const app=Fastify();await registerBotControlRoutes(app);
    try {
      const result=await app.inject({ method:'POST',url,headers,payload:{ action:'takeover',expected_version:0 } });
      expect(result.json()).toEqual({ mode:'human',version:1 });
      expect(mocks.change).toHaveBeenCalledWith({ conversationId:id,action:'takeover',expectedVersion:0,actor:'fixture:operator' });
    } finally { await app.close(); }
  });
  it('rejeita tela desatualizada com 409',async () => {
    mocks.change.mockRejectedValue(new Error('bot_control_conflict'));
    const app=Fastify();await registerBotControlRoutes(app);
    try { expect((await app.inject({ method:'POST',url,headers,payload:{ action:'resume',expected_version:0 } })).statusCode).toBe(409); }
    finally { await app.close(); }
  });
});
