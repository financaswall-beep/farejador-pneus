import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { functionItem,jsonResponse,reasoningItem,responseBody,textItem } from './responses-fixtures.js';
import { CUSTOMER_LOCATION_REQUEST } from '../../../src/atendente-v2/product-search-nudge.js';
const mocks=vi.hoisted(() => ({ may:vi.fn(),send:vi.fn(),tool:vi.fn(),history:vi.fn(),
  client:{ query:vi.fn(),release:vi.fn() } }));
vi.mock('../../../src/persistence/db.js',() => ({ pool:{ connect:async()=>mocks.client } }));
vi.mock('../../../src/atendente-v2/conversation-control.js',() => ({ botMayProcessTrigger:mocks.may }));
vi.mock('../../../src/atendente-v2/history.js',() => ({
  loadHistory:mocks.history,lookupChatwootConversationId:async()=>12,
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
  mocks.history.mockResolvedValue([{ role:'user',content:'Olá' }]);
  mocks.tool.mockResolvedValue('{"estoque":2}');mocks.send.mockResolvedValue('sent');
});
afterEach(() => { vi.unstubAllGlobals(); });
const job={ jobId:'job',conversationId:'conversation',triggerMessageId:'trigger',environment:'test' };
describe('contexto de localização enviado ao modelo', () => {
  it('aplica a abertura aprovada ao pedido de Twister que chega depois do cumprimento', async () => {
    mocks.history.mockResolvedValue([
      { role:'user',content:'Ola meu amigo bom dia' },
      { role:'assistant',content:'Olá, bom dia! Como posso te ajudar?' },
      { role:'user',content:'entao to precisando de um pneuzinho traseiro da twister tem' },
    ]);
    const fetcher=vi.fn().mockResolvedValue(jsonResponse(responseBody([textItem(CUSTOMER_LOCATION_REQUEST)])));
    vi.stubGlobal('fetch',fetcher);
    const { runAgentV2 }=await import('../../../src/atendente-v2/agent.js');
    await runAgentV2(job);
    const input=JSON.parse(fetcher.mock.calls[0]?.[1].body).input;
    const system=input.find((message:{role:string})=>message.role==='system').content;
    expect(system).toContain('[LOCALIZAÇÃO ANTES DA DISPONIBILIDADE DO PNEU]');
    expect(system).toContain(CUSTOMER_LOCATION_REQUEST);
    expect(system).not.toContain('Tenho sim.');
    expect(system).not.toContain('You MAY mention the price');
    expect(system).not.toContain('OBRIGATÓRIO: chame buscar_produto');
  });

  it('na resposta com endereço, monta a continuação de cotação em vez de repetir a abertura', async () => {
    mocks.history.mockResolvedValue([
      { role:'user',content:'Tem pneu 90/90-12?' },
      { role:'assistant',content:CUSTOMER_LOCATION_REQUEST },
      { role:'user',content:'Rua das Flores, 50, Alcântara, São Gonçalo' },
    ]);
    const fetcher=vi.fn().mockResolvedValue(jsonResponse(responseBody()));
    vi.stubGlobal('fetch',fetcher);
    const { runAgentV2 }=await import('../../../src/atendente-v2/agent.js');
    await runAgentV2(job);
    const input=JSON.parse(fetcher.mock.calls[0]?.[1].body).input;
    const system=input.find((message:{role:string})=>message.role==='system').content;
    expect(system).toContain('[VOCÊ JÁ PEDIU A LOCALIZAÇÃO NESTA CONVERSA]');
    expect(system).toContain('Se AINDA NÃO houve cotação');
    expect(system).not.toContain('[LOCALIZAÇÃO ANTES DA DISPONIBILIDADE DO PNEU]');
  });
});

describe('continuidade enviada ao modelo depois de pedir foto', () => {
  it.each([
    ['retirada ainda pendente', 'vc pode me enviar uma foto', 'goste1'],
    ['retirada confirmada', 'vou buscar mesmo assim, manda a foto', 'gostei'],
    ['cliente mudou de ideia', 'vou buscar mesmo assim, manda a foto', 'vê se tem outro mais perto'],
    ['cliente quer esperar', 'vc pode me enviar uma foto', 'quero ver a foto antes de decidir'],
  ])('preserva as decisões e resultados na requisição: %s', async (_scenario, photoRequest, latestReply) => {
    mocks.history.mockResolvedValue([
      { role:'user',content:'entregar' },
      { role:'assistant',content:null,tool_calls:[{id:'store',type:'function',function:{
        name:'localizacao_loja',arguments:'{"product_ids":["irc"]}',
      }}] },
      { role:'tool',tool_call_id:'store',content:'{"encontrado":false,"motivo":"retirada_so_longe","nome_loja":"Matriz","distancia_km":47}' },
      { role:'assistant',content:'Pra entregar não atende. Na Matriz fica a uns 47 km. Vai buscar?' },
      { role:'user',content:photoRequest },
      { role:'assistant',content:null,tool_calls:[{id:'photo',type:'function',function:{
        name:'pedir_foto',arguments:'{"product_id":"irc"}',
      }}] },
      { role:'tool',tool_call_id:'photo',content:'{"status":"foto_solicitada","prazo_min":10}' },
      { role:'assistant',content:'Pedi a foto desse pneu pra loja.' },
      { role:'user',content:latestReply },
    ]);
    const fetcher=vi.fn().mockResolvedValue(jsonResponse(responseBody()));
    vi.stubGlobal('fetch',fetcher);
    const { runAgentV2 }=await import('../../../src/atendente-v2/agent.js');
    await runAgentV2(job);
    const request=JSON.parse(fetcher.mock.calls[0]?.[1].body);
    const system=request.input.find((message:{role:string})=>message.role==='system').content;
    expect(request.model).toBe('gpt-5.6-sol');
    expect(system).toContain('[CONTINUIDADE DA COMPRA — DADOS DAS FERRAMENTAS]');
    expect(system).toContain('"foto_solicitada":{"product_id":"irc"}');
    expect(system).toContain('"loja":"Matriz","distante":true');
    expect(system).toContain('não são confirmação de retirada pelo cliente');
    expect(request.input).toContainEqual({role:'user',content:photoRequest});
    expect(request.input.at(-1)).toEqual({role:'user',content:latestReply});
    expect(mocks.tool).not.toHaveBeenCalled(); // O destaque não executa ações por conta própria.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

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
