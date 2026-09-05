import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ToolDefinition } from '../../../src/atendente-v2/types.js';
import { functionItem, jsonResponse, reasoningItem, responseBody, textItem } from './responses-fixtures.js';

const config = vi.hoisted(() => ({ OPENAI_API_KEY: 'fixture-only', OPENAI_MODEL: 'gpt-5.6-sol',
  OPENAI_TIMEOUT_MS: 1000, AGENT_V2_MAX_OUTPUT_TOKENS: 8192 }));
vi.mock('../../../src/shared/config/env.js', () => ({ env: config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn() } }));
import { createOpenAIResponsesTurn } from '../../../src/atendente-v2/openai-responses.js';
import { classifyAtendenteError } from '../../../src/shared/repositories/ops-atendente-retry.js';

const definition: ToolDefinition = { type: 'function', function: { name: 'buscar_produto',
  description: 'Consulta estoque', parameters: { type: 'object', properties: { medida: { type: 'string' } } } } };
const history: ChatMessage[] = [{ role: 'system', content: 'Prompt fixture inalterado.' }, { role: 'user', content: 'Olá' }];
const fetcher = vi.fn<typeof fetch>();
const turn = () => createOpenAIResponsesTurn(history, [definition]);
const request = (index = 0) => JSON.parse(String(fetcher.mock.calls[index]?.[1]?.body));
beforeEach(() => {
  fetcher.mockReset(); vi.stubGlobal('fetch', fetcher);
  config.OPENAI_MODEL = 'gpt-5.6-sol'; config.OPENAI_API_KEY = 'fixture-only'; config.AGENT_V2_MAX_OUTPUT_TOKENS = 8192;
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('contrato Responses do Agent V2', () => {
  it('mantém Sol, reasoning e schemas não estritos; não usa parâmetros de Chat Completions', async () => {
    fetcher.mockResolvedValue(jsonResponse(responseBody()));
    expect(await turn().next()).toEqual({ type: 'text', content: 'Olá! Como posso ajudar?', inputTokens: 100, outputTokens: 25, cachedTokens: 80 });
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(request()).toEqual({ model: 'gpt-5.6-sol', input: history, store: false, max_output_tokens: 8192,
      reasoning: { effort: 'medium' }, include: ['reasoning.encrypted_content'], tool_choice: 'auto',
      tools: [{ type: 'function', ...definition.function, strict: false }] });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-only' });
  });
  it('continua com call_id, outputs completos e reasoning criptografado somente em memória', async () => {
    const outputs = [reasoningItem, textItem('Vou conferir.', 'commentary'), functionItem('call_a')];
    fetcher.mockResolvedValueOnce(jsonResponse(responseBody(outputs))).mockResolvedValueOnce(jsonResponse(responseBody()));
    const session = turn();
    const first = await session.next();
    expect(first.tool_calls?.[0]?.id).toBe('call_a');
    expect(first).not.toHaveProperty('content');
    expect(JSON.stringify(first)).not.toContain(reasoningItem.encrypted_content);
    session.appendToolResult('call_a', '{"estoque":2}');
    await session.next();
    expect(request(1).input).toEqual([...history, ...outputs, { type: 'function_call_output', call_id: 'call_a', output: '{"estoque":2}' }]);
    expect(request(1)).not.toHaveProperty('previous_response_id');
    expect(request(1).store).toBe(false);
  });
  it('converte ações históricas sem alterar o formato persistido', async () => {
    const actions: ChatMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'buscar_produto', arguments: '{"medida":"90/90-12"}' } }] },
      { role: 'tool', tool_call_id: 'old_call', content: '{"estoque":1}' }, { role: 'assistant', content: 'Temos uma unidade.' },
    ];
    const original = structuredClone(actions);
    fetcher.mockResolvedValue(jsonResponse(responseBody()));
    await createOpenAIResponsesTurn([...history, ...actions], [definition]).next();
    expect(request().input).toEqual([...history,
      { type: 'function_call', call_id: 'old_call', name: 'buscar_produto', arguments: '{"medida":"90/90-12"}' },
      { type: 'function_call_output', call_id: 'old_call', output: '{"estoque":1}' }, { role: 'assistant', content: 'Temos uma unidade.' }]);
    expect(actions).toEqual(original);
  });
  it('mantém compatibilidade com o default gpt-4o-mini sem enviar reasoning', async () => {
    config.OPENAI_MODEL = 'gpt-4o-mini'; config.AGENT_V2_MAX_OUTPUT_TOKENS = 4096;
    fetcher.mockResolvedValue(jsonResponse(responseBody()));
    await turn().next();
    expect(request().model).toBe('gpt-4o-mini'); expect(request().max_output_tokens).toBe(4096);
    expect(request()).not.toHaveProperty('reasoning'); expect(request()).not.toHaveProperty('include');
  });
  it('preserva strict explícito e aceita texto sem phase', async () => {
    fetcher.mockResolvedValue(jsonResponse(responseBody([{ ...textItem(), phase: undefined }])));
    await createOpenAIResponsesTurn(history, [{ ...definition, function: { ...definition.function, strict: true } }]).next();
    expect(request().tools[0].strict).toBe(true);
  });
  it('não mistura estado entre jobs/conversas', async () => {
    fetcher.mockResolvedValueOnce(jsonResponse(responseBody([reasoningItem, functionItem()]))).mockResolvedValueOnce(jsonResponse(responseBody()));
    const first = turn(); await first.next(); first.appendToolResult('call_fixture', 'segredo-fixture');
    await createOpenAIResponsesTurn([{ role: 'user', content: 'Outro cliente' }], [definition]).next();
    expect(request(1).input).toEqual([{ role: 'user', content: 'Outro cliente' }]);
  });
  it('exige todos os resultados e rejeita resultado duplicado ou desconhecido', async () => {
    fetcher.mockResolvedValueOnce(jsonResponse(responseBody([functionItem('a'), functionItem('b')]))).mockResolvedValueOnce(jsonResponse(responseBody()));
    const session = turn(); await session.next();
    session.appendToolResult('b', 'segundo');
    await expect(session.next()).rejects.toThrow('still pending');
    expect(() => session.appendToolResult('b', 'duplicado')).toThrow('duplicate tool result');
    expect(() => session.appendToolResult('z', 'desconhecido')).toThrow('unexpected');
    session.appendToolResult('a', 'primeiro'); await session.next(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejeita repetição de call_id em rodadas seguintes', async () => {
    fetcher.mockImplementation(async () => jsonResponse(responseBody([functionItem('same')])));
    const session = turn(); await session.next(); session.appendToolResult('same', 'ok');
    await expect(session.next()).rejects.toThrow('duplicate tool call_id');
  });
  it.each([
    ['incompleta', { ...responseBody([functionItem()]), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }],
    ['falhou', { ...responseBody(), status: 'failed' }],
    ['cancelada', { ...responseBody(), status: 'cancelled' }],
    ['vazia', responseBody([])], ['só reasoning', responseBody([reasoningItem])],
    ['só comentário', responseBody([textItem('aguarde', 'commentary')])],
    ['tool desconhecida', responseBody([functionItem('a'), functionItem('b', 'nao_permitida')])],
    ['JSON inválido', responseBody([functionItem('a'), functionItem('b', 'buscar_produto', '{')])],
    ['argumento nulo', responseBody([functionItem('a', 'buscar_produto', 'null')])],
    ['argumento array', responseBody([functionItem('a', 'buscar_produto', '[]')])],
    ['call_id ausente', responseBody([{ ...functionItem(), call_id: undefined }])],
    ['call_id duplicado', responseBody([functionItem(), functionItem()])],
    ['tool incompleta', responseBody([{ ...functionItem(), status: 'in_progress' }])],
    ['mensagem incompleta', responseBody([{ ...textItem(), status: 'incomplete' }])],
    ['recusa', responseBody([{ ...textItem(), content: [{ type: 'refusal', refusal: 'fixture privada' }] }])],
    ['tipo inesperado', responseBody([{ type: 'web_search_call', id: 'fixture' }])],
    ['usage malformado', { ...responseBody(), usage: { input_tokens: 'not a number' } }],
    ['envelope malformado', null],
  ])('falha %s não vira resposta enviada nem retry automático', async (_label, body) => {
    fetcher.mockResolvedValue(jsonResponse(body));
    const failure = await turn().next().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(classifyAtendenteError(failure)).toMatchObject({ retryable: false, code: 'validation_failed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(failure)).not.toContain('fixture privada');
  });
});

describe('transporte Responses sem efeitos externos nos testes', () => {
  it.each([400, 401, 403, 429])('não repete HTTP %s nem expõe corpo do erro', async (status) => {
    fetcher.mockResolvedValue(new Response('segredo-fixture: dados de cliente', { status }));
    await expect(turn().next()).rejects.toThrow(`OpenAI error ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('faz no máximo um retry de 5xx com o mesmo corpo', async () => {
    vi.useFakeTimers();
    fetcher.mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(jsonResponse(responseBody()));
    const result = turn().next(); await vi.runAllTimersAsync();
    expect((await result).type).toBe('text'); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  });
  it('propaga o segundo 5xx para o controle de retry da fila', async () => {
    vi.useFakeTimers(); fetcher.mockImplementation(async () => new Response('', { status: 503 }));
    const failure = turn().next().catch((error: unknown) => error); await vi.runAllTimersAsync();
    expect(classifyAtendenteError(await failure)).toMatchObject({ retryable: true, code: 'provider_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['headers', 'body'])('timeout cobre %s e só tenta duas vezes', async (stage) => {
    vi.useFakeTimers();
    fetcher.mockImplementation(async (_url, init) => {
      const hanging = () => new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
      if (stage === 'headers') return hanging();
      return { ok: true, json: hanging } as Response;
    });
    const failure = turn().next().catch((error: unknown) => error); await vi.runAllTimersAsync();
    expect(classifyAtendenteError(await failure)).toMatchObject({ retryable: true, code: 'provider_timeout' });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('não imprime JSON inválido e não faz retry desse erro', async () => {
    fetcher.mockResolvedValue(new Response('segredo-fixture não é JSON'));
    await expect(turn().next()).rejects.toThrow('validation failed: invalid JSON');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('falha sem chave antes de chamar a API', async () => {
    config.OPENAI_API_KEY = '';
    await expect(turn().next()).rejects.toThrow('OPENAI_API_KEY not set'); expect(fetcher).not.toHaveBeenCalled();
  });
});
