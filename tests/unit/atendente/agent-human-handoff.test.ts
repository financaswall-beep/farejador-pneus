import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(() => ({ may:vi.fn(),send:vi.fn(),tool:vi.fn(),
  client:{ query:vi.fn(),release:vi.fn() } }));
vi.mock('../../../src/persistence/db.js',() => ({ pool:{ connect:async()=>mocks.client } }));
vi.mock('../../../src/atendente-v2/conversation-control.js',() => ({ botMayProcessTrigger:mocks.may }));
vi.mock('../../../src/atendente-v2/history.js',() => ({
  loadHistory:async()=>[{ role:'user',content:'Olá' }],lookupChatwootConversationId:async()=>12,
}));
vi.mock('../../../src/atendente-v2/tools.js',() => ({ activeToolDefinitions:()=>[],executeTool:mocks.tool }));
vi.mock('../../../src/atendente-v2/final-send.js',() => ({ sendFinalAgentText:mocks.send }));
vi.mock('../../../src/shared/logger.js',() => ({ logger:{ info:vi.fn(),warn:vi.fn(),error:vi.fn() } }));
beforeEach(() => {
  Object.assign(process.env,{ NODE_ENV:'test',FAREJADOR_ENV:'test',
    DATABASE_URL:'postgresql://test:test@example.test/test',CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-token',
    OPENAI_API_KEY:'fixture-only',ROUTING_GEO:'false',SATISFACTION_SURVEY:'false',PHOTO_REQUESTS:'false' });
  vi.clearAllMocks();mocks.may.mockResolvedValue(true);mocks.client.query.mockResolvedValue({ rows:[] });
});
afterEach(() => { vi.unstubAllGlobals(); });
const job={ jobId:'job',conversationId:'conversation',triggerMessageId:'trigger',environment:'test' };
describe('intervenção enquanto o bot prepara resposta',() => {
  it('não chama LLM nem ferramentas se a conversa já está pausada',async () => {
    mocks.may.mockResolvedValue(false);
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const { runAgentV2 }=await import('../../../src/atendente-v2/agent.js');
    await runAgentV2(job);
    expect(fetcher).not.toHaveBeenCalled();expect(mocks.tool).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.client.release).toHaveBeenCalled();
  });
  it.each(['stop','tool_calls'])('descarta resultado %s recebido após intervenção humana',async finishReason => {
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async () => {
      mocks.may.mockResolvedValue(false); // Humano assumiu enquanto a chamada estava em andamento.
      return new Response(JSON.stringify({ choices:[{ finish_reason:finishReason,message:{ content:'Resposta antiga',
        tool_calls:finishReason==='tool_calls' ? [{ id:'call',type:'function',function:{ name:'criar_pedido',arguments:'{}' } }] : undefined,
      } }],usage:{ prompt_tokens:1,completion_tokens:1 } }));
    }));
    const { runAgentV2 }=await import('../../../src/atendente-v2/agent.js');
    await runAgentV2(job);
    expect(fetch).toHaveBeenCalledTimes(1);expect(mocks.tool).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
  });
});
