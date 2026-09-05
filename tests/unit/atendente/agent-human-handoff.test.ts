import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { functionItem,jsonResponse,reasoningItem,responseBody,textItem } from './responses-fixtures.js';
const mocks=vi.hoisted(() => ({ may:vi.fn(),send:vi.fn(),tool:vi.fn(),
  client:{ query:vi.fn(),release:vi.fn() } }));
vi.mock('../../../src/persistence/db.js',() => ({ pool:{ connect:async()=>mocks.client } }));
vi.mock('../../../src/atendente-v2/conversation-control.js',() => ({ botMayProcessTrigger:mocks.may }));
vi.mock('../../../src/atendente-v2/history.js',() => ({
  loadHistory:async()=>[{ role:'user',content:'Olá' }],lookupChatwootConversationId:async()=>12,
}));
vi.mock('../../../src/atendente-v2/tools.js',() => ({ activeToolDefinitions:()=>['criar_pedido','buscar_produto'].map(name => ({
  type:'function',function:{ name,description:'fixture',parameters:{ type:'object',properties:{} } },
})),executeTool:mocks.tool }));
vi.mock('../../../src/shared/clientes-kanban.notify.js',() => ({ notifyClientesKanban:vi.fn() }));
vi.mock('../../../src/atendente-v2/final-send.js',() => ({ sendFinalAgentText:mocks.send }));
vi.mock('../../../src/shared/logger.js',() => ({ logger:{ info:vi.fn(),warn:vi.fn(),error:vi.fn() } }));
beforeEach(() => {
  Object.assign(process.env,{ NODE_ENV:'test',FAREJADOR_ENV:'test',
    DATABASE_URL:'postgresql://test:test@example.test/test',CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-token',
    OPENAI_API_KEY:'fixture-only',OPENAI_MODEL:'gpt-5.6-sol',ROUTING_GEO:'false',SATISFACTION_SURVEY:'false',PHOTO_REQUESTS:'false' });
  vi.resetAllMocks();mocks.may.mockResolvedValue(true);mocks.client.query.mockResolvedValue({ rows:[] });
  mocks.tool.mockResolvedValue('{"estoque":2}');mocks.send.mockResolvedValue('sent');
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
      return jsonResponse(responseBody(finishReason==='tool_calls'
        ? [reasoningItem,functionItem('call','criar_pedido')] : [textItem('Resposta antiga')]));
    }));
    const { runAgentV2 }=await import('../../../src/atendente-v2/agent.js');
    await runAgentV2(job);
    expect(fetch).toHaveBeenCalledTimes(1);expect(mocks.tool).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
  });
  it('para entre ferramentas quando o humano assume e não chama o modelo novamente',async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(jsonResponse(responseBody([functionItem('a'),functionItem('b')]))));
    mocks.tool.mockImplementation(async () => { mocks.may.mockResolvedValue(false);return 'fixture'; });
    const { runAgentV2 }=await import('../../../src/atendente-v2/agent.js');await runAgentV2(job);
    expect(mocks.tool).toHaveBeenCalledTimes(1);expect(fetch).toHaveBeenCalledTimes(1);expect(mocks.send).not.toHaveBeenCalled();
  });
  it('consulta ferramenta e envia resposta pelo fluxo existente sem persistir reasoning',async () => {
    const fetcher=vi.fn().mockResolvedValueOnce(jsonResponse(responseBody([reasoningItem,functionItem('consulta')])))
      .mockResolvedValueOnce(jsonResponse(responseBody([textItem('Temos duas unidades.\nOPCOES: Comprar | Ver mais')])));
    vi.stubGlobal('fetch',fetcher);
    const { runAgentV2 }=await import('../../../src/atendente-v2/agent.js');await runAgentV2(job);
    expect(mocks.tool).toHaveBeenCalledWith(mocks.client,'test','conversation','buscar_produto',{});
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const sent=mocks.send.mock.calls[0]?.[1];
    expect(sent).toMatchObject({ body:'Temos duas unidades.',inputTokens:200,outputTokens:50,environment:'test',
      actions:[{ role:'assistant',content:null,tool_calls:[{ id:'consulta',type:'function',function:{ name:'buscar_produto',arguments:'{}' } }] },
        { role:'tool',tool_call_id:'consulta',content:'{"estoque":2}' }] });
    expect(JSON.stringify(sent)).not.toContain(reasoningItem.encrypted_content);
    const continuation=JSON.parse(fetcher.mock.calls[1]?.[1].body);
    expect(continuation.input).toContainEqual(reasoningItem);
  });
  it('mantém transação do pedido e revalida pausa antes do envio final',async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(jsonResponse(responseBody([functionItem('order','criar_pedido')])))
      .mockResolvedValueOnce(jsonResponse(responseBody())));
    mocks.client.query.mockImplementation(async (sql:string) => {
      if (sql.includes('SELECT say_text')) mocks.may.mockResolvedValue(false);
      return { rows:[] };
    });
    const { runAgentV2 }=await import('../../../src/atendente-v2/agent.js');await runAgentV2(job);
    expect(mocks.client.query).toHaveBeenCalledWith('BEGIN');expect(mocks.client.query).toHaveBeenCalledWith('COMMIT');
    expect(mocks.send).not.toHaveBeenCalled();expect(mocks.client.release).toHaveBeenCalled();
  });
  it('não executa nenhuma ferramenta se um dos argumentos do lote estiver malformado',async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(jsonResponse(responseBody([functionItem('a'),functionItem('b','criar_pedido','{')]))));
    const { runAgentV2 }=await import('../../../src/atendente-v2/agent.js');
    await expect(runAgentV2(job)).rejects.toThrow('invalid tool arguments JSON');
    expect(mocks.tool).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();expect(mocks.client.release).toHaveBeenCalled();
  });
  it('limite de rodadas fica visível como falha e não envia comentário parcial ao cliente',async () => {
    let call=0;
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async () => jsonResponse(responseBody([
      textItem('Vou consultar.','commentary'),functionItem(`call_${++call}`),
    ]))));
    const { runAgentV2 }=await import('../../../src/atendente-v2/agent.js');
    await expect(runAgentV2(job)).rejects.toThrow('tool round limit reached');
    expect(fetch).toHaveBeenCalledTimes(5);expect(mocks.tool).toHaveBeenCalledTimes(5);expect(mocks.send).not.toHaveBeenCalled();
  });
});
