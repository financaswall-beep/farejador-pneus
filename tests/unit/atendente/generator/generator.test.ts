/**
 * Testes do Generator Shadow — Sprint 6.
 *
 * Cobrem:
 * 1. não inventa preço sem resultado de tool
 * 2. não inventa estoque sem resultado de tool
 * 3. não promete frete sem resultado de tool
 * 4. gera fallback seguro quando falta dado
 * 5. bloqueia fala com preço sem lastro
 * 6. garante que não existe envio Chatwoot
 *
 * Estratégia: env é mockado via vi.hoisted como objeto mutável para
 * controlar GENERATOR_LLM_ENABLED por teste sem re-importar módulos.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlannerContext } from '../../../../src/atendente/planner/context-builder.js';
import type { PlannerDecisionResult } from '../../../../src/atendente/planner/service.js';
import type { ToolExecutionResult } from '../../../../src/atendente/executor/tool-executor.js';
import type { ConversationState } from '../../../../src/shared/zod/agent-state.js';

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted garante inicialização antes da avaliação dos módulos)
// ---------------------------------------------------------------------------

// env mutável — cada teste pode alternar GENERATOR_LLM_ENABLED
const mockEnv = vi.hoisted(() => ({
  GENERATOR_LLM_ENABLED: false as boolean,
  GENERATOR_OPENAI_API_KEY: undefined as string | undefined,
  GENERATOR_MODEL: 'gpt-4o-mini',
  OPENAI_TIMEOUT_MS: 30000,
}));

vi.mock('../../../../src/shared/config/env.js', () => ({
  env: mockEnv,
  parseEnv: () => mockEnv,
}));

// callOpenAI — evita chamadas HTTP reais
const callOpenAIMock = vi.fn();
vi.mock('../../../../src/shared/llm-clients/openai.js', () => ({
  callOpenAI: callOpenAIMock,
}));

// logger — silencia output durante testes
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Constantes e importações dinâmicas
// ---------------------------------------------------------------------------

const conversationId = '00000000-0000-4000-8000-000000000001';
const baseTime = '2026-05-03T12:00:00.000Z';
let generatorPromptVersion: string;

let generateTurn: typeof import('../../../../src/atendente/generator/service.js').generateTurn;
let recordGeneratorResult: typeof import('../../../../src/atendente/generator/service.js').recordGeneratorResult;
let buildGeneratorMessages: typeof import('../../../../src/atendente/generator/prompt.js').buildGeneratorMessages;
let SAFE_FALLBACK_SAY: string;

beforeAll(async () => {
  const module = await import('../../../../src/atendente/generator/service.js');
  generateTurn = module.generateTurn;
  recordGeneratorResult = module.recordGeneratorResult;

  const prompt = await import('../../../../src/atendente/generator/prompt.js');
  buildGeneratorMessages = prompt.buildGeneratorMessages;

  const schemas = await import('../../../../src/atendente/generator/schemas.js');
  SAFE_FALLBACK_SAY = schemas.SAFE_FALLBACK_SAY;
  generatorPromptVersion = schemas.generatorPromptVersion;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    schema_version: 'atendente_v1.0',
    environment: 'test',
    conversation_id: conversationId,
    contact_id: null,
    status: 'active',
    current_skill: null,
    last_customer_message_id: null,
    last_agent_turn_id: null,
    last_processed_message_id: null,
    version: 0,
    turn_index: 1,
    items: [],
    global_slots: {},
    cart: [],
    pending_confirmation: null,
    last_offer: null,
    derived_signals: {
      missing_for_close: [],
      stale_slots: [],
      recent_objections: [],
      has_pending_human_request: false,
      offer_expired: false,
    },
    updated_at: baseTime,
    created_at: baseTime,
    ...overrides,
  };
}

function makeContext(overrides: Partial<PlannerContext> = {}): PlannerContext {
  const state = makeState();
  return {
    environment: 'test',
    conversation_id: conversationId,
    state,
    recent_messages: [],
    available_tools: ['buscarProduto', 'verificarEstoque', 'calcularFrete'],
    recent_tool_results: [],
    organizer_facts: [],
    derived_signals: state.derived_signals,
    ...overrides,
  };
}

function makeDecision(skill: string, missingSlots: string[] = []): PlannerDecisionResult {
  return {
    output: {
      skill: skill as never,
      missing_slots: missingSlots as never,
      tool_requests: [],
      risk_flags: [],
      confidence: 0.8,
      rationale: 'mock',
      prompt_version: 'planner_v1.0.0' as never,
    },
    used_llm: false,
    fallback_used: false,
    input_tokens: 0,
    output_tokens: 0,
    duration_ms: 0,
  };
}

function makeToolResult(tool: string, ok: boolean, output: unknown): ToolExecutionResult {
  return {
    tool: tool as never,
    input: {},
    output,
    ok,
    duration_ms: 5,
    error_message: ok ? null : 'tool_error',
  };
}

function llmResponse(say: string, actions: unknown[] = []): string {
  return JSON.stringify({
    say,
    actions,
    rationale: 'llm rationale',
    prompt_version: generatorPromptVersion,
  });
}

// ---------------------------------------------------------------------------
// Helpers para controlar LLM por teste
// ---------------------------------------------------------------------------

function enableLlm(): void {
  mockEnv.GENERATOR_LLM_ENABLED = true;
  mockEnv.GENERATOR_OPENAI_API_KEY = 'fake-key';
  callOpenAIMock.mockReset();
}

function disableLlm(): void {
  mockEnv.GENERATOR_LLM_ENABLED = false;
  mockEnv.GENERATOR_OPENAI_API_KEY = undefined;
  callOpenAIMock.mockReset();
}

function queueLlm(say: string, actions: unknown[] = []): void {
  callOpenAIMock.mockResolvedValueOnce({
    content: llmResponse(say, actions),
    inputTokens: 10,
    outputTokens: 20,
    durationMs: 50,
  });
}

// ---------------------------------------------------------------------------
// 1. Sem envio Chatwoot
// ---------------------------------------------------------------------------

describe('Generator Shadow — sem envio Chatwoot', () => {
  it('generateTurn não retorna nenhum campo de envio ao Chatwoot', async () => {
    disableLlm();
    const result = await generateTurn(makeContext(), makeDecision('responder_geral'), []);

    expect(result).not.toHaveProperty('chatwoot_message_id');
    expect(result).not.toHaveProperty('sent_to_chatwoot');
    expect(result).not.toHaveProperty('delivered_message_id');
    expect(callOpenAIMock).not.toHaveBeenCalled();
  });

  it('o módulo generator não exporta funções de envio Chatwoot', async () => {
    const mod = await import('../../../../src/atendente/generator/service.js');
    const keys = Object.keys(mod);

    expect(keys).not.toContain('sendChatwootMessage');
    expect(keys).not.toContain('chatwootSend');
    expect(keys).toContain('generateTurn');
    expect(keys).toContain('recordGeneratorResult');
  });
});

// ---------------------------------------------------------------------------
// 2. Não inventa preço sem tool
// ---------------------------------------------------------------------------

describe('Generator Shadow — não inventa preço sem tool', () => {
  it('bloqueia say com valor monetário quando não há tool results (LLM path)', async () => {
    enableLlm();
    queueLlm('O pneu custa R$ 350,00.');

    const result = await generateTurn(makeContext(), makeDecision('buscar_e_ofertar'), []);

    expect(result.blocked).toBe(true);
    expect(result.block_reason).toBe('money_mentioned_without_tool_result');
    expect(result.say_text).toBeNull();
    expect(result.candidate_say_text).toBe('O pneu custa R$ 350,00.');
    expect(result.used_llm).toBe(true);
    disableLlm();
  });

  it('bloqueia action fora do escopo shadow, como add_to_cart', async () => {
    enableLlm();
    queueLlm('Separei esse produto para você.', [
      {
        type: 'add_to_cart',
        product_id: '00000000-0000-4000-8000-0000000000aa',
        quantity: 1,
      },
    ]);

    const result = await generateTurn(makeContext(), makeDecision('buscar_e_ofertar'), []);

    expect(result.blocked).toBe(true);
    expect(result.say_text).toBeNull();
    expect(result.block_reason).toContain('generator_schema_failed');
    disableLlm();
  });

  it('bloqueia preço inventado diferente do retorno da tool (LLM path)', async () => {
    enableLlm();
    queueLlm('O pneu custa R$ 500,00.');

    const toolResults = [
      makeToolResult('buscarProduto', true, [{ product_id: 'p1', price_amount: '300.00' }]),
    ];

    const result = await generateTurn(makeContext(), makeDecision('buscar_e_ofertar'), toolResults);

    expect(result.blocked).toBe(true);
    expect(result.block_reason).toContain('money_not_supported_by_tool_result');
    expect(result.say_text).toBeNull();
    disableLlm();
  });

  it('permite preço exatamente igual ao retorno da tool (LLM path)', async () => {
    enableLlm();
    queueLlm('O pneu custa R$ 300,00.');

    const toolResults = [
      makeToolResult('buscarProduto', true, [{ product_id: 'p1', price_amount: '300.00' }]),
    ];

    const result = await generateTurn(makeContext(), makeDecision('buscar_e_ofertar'), toolResults);

    expect(result.blocked).toBe(false);
    expect(result.say_text).toBe('O pneu custa R$ 300,00.');
    disableLlm();
  });
});

// ---------------------------------------------------------------------------
// 3. Não inventa estoque sem tool
// ---------------------------------------------------------------------------

describe('Generator Shadow — não inventa estoque sem tool', () => {
  it('modo mock: buscar_e_ofertar sem tool results retorna fallback (não afirma estoque)', async () => {
    disableLlm();
    const result = await generateTurn(makeContext(), makeDecision('buscar_e_ofertar'), []);

    expect(result.say_text).toBe(SAFE_FALLBACK_SAY);
    expect(result.say_text).not.toMatch(/em estoque/i);
    expect(result.say_text).not.toMatch(/disponível/i);
    expect(result.say_text).not.toMatch(/temos\s+\d/i);
  });

  it('modo mock: buscar_e_ofertar com tool result ok não usa fallback', async () => {
    disableLlm();
    const toolResults = [
      makeToolResult('buscarProduto', true, [{ product_id: 'p1', price_amount: '299.90' }]),
    ];

    const result = await generateTurn(makeContext(), makeDecision('buscar_e_ofertar'), toolResults);

    expect(result.say_text).not.toBe(SAFE_FALLBACK_SAY);
    expect(result.blocked).toBe(false);
  });

  it('modo mock: tool result com ok=false é tratado como ausência de dado', async () => {
    disableLlm();
    const toolResults = [makeToolResult('buscarProduto', false, null)];

    const result = await generateTurn(makeContext(), makeDecision('buscar_e_ofertar'), toolResults);

    expect(result.say_text).toBe(SAFE_FALLBACK_SAY);
  });
});

// ---------------------------------------------------------------------------
// 4. Não promete frete sem tool
// ---------------------------------------------------------------------------

describe('Generator Shadow — não promete frete sem tool', () => {
  it('bloqueia valor de frete sem calcularFrete nos tool results (LLM path)', async () => {
    enableLlm();
    queueLlm('O frete para seu bairro fica R$ 15,00.');

    const result = await generateTurn(makeContext(), makeDecision('responder_logistica'), []);

    expect(result.blocked).toBe(true);
    expect(result.block_reason).toBe('money_mentioned_without_tool_result');
    expect(result.say_text).toBeNull();
    disableLlm();
  });

  it('modo mock: responder_logistica sem tool results retorna fallback (não promete frete)', async () => {
    disableLlm();
    const result = await generateTurn(makeContext(), makeDecision('responder_logistica'), []);

    expect(result.say_text).toBe(SAFE_FALLBACK_SAY);
    expect(result.say_text).not.toMatch(/frete/i);
    expect(result.say_text).not.toMatch(/R\$/);
  });

  it('permite frete com valor exato do calcularFrete (LLM path)', async () => {
    enableLlm();
    queueLlm('O frete fica R$ 12,50.');

    const toolResults = [
      makeToolResult('calcularFrete', true, { valor: 12.5, prazo_dias: 3 }),
    ];

    const result = await generateTurn(makeContext(), makeDecision('responder_logistica'), toolResults);

    expect(result.blocked).toBe(false);
    expect(result.say_text).toBe('O frete fica R$ 12,50.');
    disableLlm();
  });
});

// ---------------------------------------------------------------------------
// 5. Fallback seguro quando falta dado
// ---------------------------------------------------------------------------

describe('Generator Shadow — fallback seguro quando falta dado', () => {
  it('SAFE_FALLBACK_SAY não contém valores monetários inventados', () => {
    expect(SAFE_FALLBACK_SAY).not.toMatch(/R\$/);
    expect(SAFE_FALLBACK_SAY).toBeTruthy();
  });

  it('retorna SAFE_FALLBACK_SAY para buscar_e_ofertar sem tools (mock path)', async () => {
    disableLlm();
    const result = await generateTurn(makeContext(), makeDecision('buscar_e_ofertar'), []);

    expect(result.say_text).toBe(SAFE_FALLBACK_SAY);
    expect(result.blocked).toBe(false);
    expect(result.fallback_used).toBe(true);
    expect(result.used_llm).toBe(false);
  });

  it('bloqueia quando LLM retorna schema inválido (sem say)', async () => {
    enableLlm();
    callOpenAIMock.mockResolvedValueOnce({
      content: JSON.stringify({ campo_errado: 'nenhum say' }),
      inputTokens: 5,
      outputTokens: 5,
      durationMs: 20,
    });

    const result = await generateTurn(makeContext(), makeDecision('responder_geral'), []);

    expect(result.blocked).toBe(true);
    expect(result.say_text).toBeNull();
    expect(result.block_reason).toContain('generator_schema_failed');
    expect(result.fallback_used).toBe(true);
    expect(result.used_llm).toBe(true);
    disableLlm();
  });

  it('bloqueia quando LLM lança exceção de rede', async () => {
    enableLlm();
    callOpenAIMock.mockRejectedValueOnce(new Error('network_timeout'));

    const result = await generateTurn(makeContext(), makeDecision('buscar_e_ofertar'), []);

    expect(result.blocked).toBe(true);
    expect(result.say_text).toBeNull();
    expect(result.block_reason).toContain('generator_llm_failed:network_timeout');
    expect(result.fallback_used).toBe(true);
    expect(result.used_llm).toBe(true);
    disableLlm();
  });

  it('bloqueia quando GENERATOR_LLM_ENABLED mas chave ausente', async () => {
    mockEnv.GENERATOR_LLM_ENABLED = true;
    mockEnv.GENERATOR_OPENAI_API_KEY = undefined;

    const result = await generateTurn(makeContext(), makeDecision('buscar_e_ofertar'), []);

    expect(result.blocked).toBe(true);
    expect(result.block_reason).toBe('generator_llm_enabled_without_key');
    expect(callOpenAIMock).not.toHaveBeenCalled();
    disableLlm();
  });
});

// ---------------------------------------------------------------------------
// 6. Skills no modo mock — cobertura adicional
// ---------------------------------------------------------------------------

describe('Generator Shadow — skills no modo mock', () => {
  it('escalar_humano gera say de transferência sem dados factuais', async () => {
    disableLlm();
    const result = await generateTurn(makeContext(), makeDecision('escalar_humano'), []);

    expect(result.blocked).toBe(false);
    expect(result.say_text).toBeTruthy();
    expect(result.say_text).not.toMatch(/R\$/);
    expect(result.actions).toEqual([]);
  });

  it('pedir_dados_faltantes menciona os slots ausentes sem inventar dados', async () => {
    disableLlm();
    const result = await generateTurn(
      makeContext(),
      makeDecision('pedir_dados_faltantes', ['moto_modelo', 'medida_pneu']),
      [],
    );

    expect(result.blocked).toBe(false);
    expect(result.say_text).toContain('moto_modelo');
    expect(result.say_text).toContain('medida_pneu');
    expect(result.say_text).not.toMatch(/R\$/);
  });

  it('tratar_objecao responde sem dados factuais inventados', async () => {
    disableLlm();
    const result = await generateTurn(makeContext(), makeDecision('tratar_objecao'), []);

    expect(result.blocked).toBe(false);
    expect(result.say_text).toBeTruthy();
    expect(result.say_text).not.toMatch(/R\$/);
  });
});

// ---------------------------------------------------------------------------
// 7. Memória operacional em tempo real
// ---------------------------------------------------------------------------

describe('Generator Shadow — memória operacional em tempo real', () => {
  it('prompt instrui criar slots por mensagem, inclusive múltiplos itens', () => {
    const messages = buildGeneratorMessages(makeContext(), makeDecision('pedir_dados_faltantes'), []);
    const systemPrompt = messages[0]!.content;

    expect(systemPrompt).toContain('REGRAS DE MEMORIA EM TEMPO REAL');
    expect(systemPrompt).toContain('Para cada dado novo dito pelo cliente na mensagem atual, emita update_slot');
    expect(systemPrompt).toContain('Se o cliente citar dois pneus/produtos na mesma mensagem, crie/atualize dois itens separados');
    expect(systemPrompt).toContain('Para pagamento mencionado, use update_draft.payment_method e update_slot global forma_pagamento');
  });

  it('prompt proibe misturar fallback seguro com resposta util', () => {
    const messages = buildGeneratorMessages(makeContext(), makeDecision('escalar_humano'), []);
    const systemPrompt = messages[0]!.content;

    expect(systemPrompt).toContain('NAO cole a frase de fallback seguro no final de uma resposta útil');
    expect(systemPrompt).toContain('so pode aparecer sozinha, exatamente igual, nunca misturada com outro texto');
  });

  it('inclui items completos e organizer_facts no contexto entregue ao LLM', () => {
    const context = makeContext({
      state: makeState({
        items: [
          {
            id: '00000000-0000-4000-8000-000000000010',
            status: 'aberto',
            is_active: true,
            created_at: baseTime,
            slots: {},
          },
        ],
      }),
      organizer_facts: [
        {
          fact_key: 'medida_pneu',
          fact_value: '140/70-17',
          observed_at: baseTime,
          message_id: '00000000-0000-4000-8000-0000000000f1',
          truth_type: 'observed',
          source: 'llm',
          confidence_level: 0.99,
          extractor_version: 'test',
          latest_evidence_text: '140/70-17',
          latest_evidence_message_id: '00000000-0000-4000-8000-0000000000f1',
          latest_evidence_type: 'message',
        },
      ],
    });

    const messages = buildGeneratorMessages(context, makeDecision('pedir_dados_faltantes'), []);
    const payload = JSON.parse(messages[1]!.content);

    expect(payload.context.state_summary.items).toHaveLength(1);
    expect(payload.context.organizer_facts).toHaveLength(1);
    expect(payload.context.organizer_facts[0].fact_value).toBe('140/70-17');
  });

  it('hidrata e preserva slots de dois pneus e dados globais emitidos no mesmo turno', async () => {
    enableLlm();
    const latestMessageId = '00000000-0000-4000-8000-0000000000f2';
    const firstItemId = '00000000-0000-4000-8000-000000000101';
    const secondItemId = '00000000-0000-4000-8000-000000000102';
    queueLlm('Anotei os dois pneus, o endereço e o pagamento. Vou conferir as opções para você.', [
      { type: 'create_item', item_id: firstItemId, make_active: true },
      {
        type: 'update_slot',
        scope: 'item',
        item_id: firstItemId,
        slot_key: 'medida_pneu',
        value: '140/70-17',
        source: 'observed',
        confidence: 0.99,
        evidence_text: '140/70-17',
        set_by_message_id: latestMessageId,
      },
      { type: 'create_item', item_id: secondItemId, make_active: true },
      {
        type: 'update_slot',
        scope: 'item',
        item_id: secondItemId,
        slot_key: 'medida_pneu',
        value: '110/70-17',
        source: 'observed',
        confidence: 0.99,
        evidence_text: '110/70-17',
        set_by_message_id: latestMessageId,
      },
      {
        type: 'update_slot',
        scope: 'global',
        item_id: null,
        slot_key: 'forma_pagamento',
        value: 'cartao_credito',
        source: 'observed',
        confidence: 0.95,
        evidence_text: 'vou pagar no cartão',
        set_by_message_id: latestMessageId,
      },
      { type: 'update_draft', payment_method: 'cartao_credito' },
    ]);

    const context = makeContext({
      recent_messages: [
        {
          id: latestMessageId,
          role: 'customer',
          text: 'quero um pneu 140/70-17 e outro 110/70-17 e vou pagar no cartão',
          sent_at: baseTime,
        },
      ],
    });

    const result = await generateTurn(context, makeDecision('pedir_dados_faltantes'), []);

    expect(result.blocked).toBe(false);
    expect(result.actions).toHaveLength(6);
    expect(result.actions.map((action) => action.type)).toEqual([
      'create_item',
      'update_slot',
      'create_item',
      'update_slot',
      'update_slot',
      'update_draft',
    ]);
    expect(result.actions[1]).toMatchObject({
      type: 'update_slot',
      item_id: firstItemId,
      slot_key: 'medida_pneu',
      value: '140/70-17',
      set_by_skill: 'pedir_dados_faltantes',
    });
    expect(result.actions[3]).toMatchObject({
      type: 'update_slot',
      item_id: secondItemId,
      slot_key: 'medida_pneu',
      value: '110/70-17',
    });
    expect(result.actions[4]).toMatchObject({
      type: 'update_slot',
      scope: 'global',
      item_id: null,
      slot_key: 'forma_pagamento',
      value: 'cartao_credito',
    });
    expect(result.actions[5]).toMatchObject({
      type: 'update_draft',
      action_id: expect.any(String),
      turn_index: 2,
      emitted_by: 'generator',
      payment_method: 'cartao_credito',
    });
    disableLlm();
  });
});

describe('Generator Shadow — auditoria de bloqueios', () => {
  it('recordGeneratorResult persiste o candidato bloqueado para auditoria', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }),
    };

    await recordGeneratorResult(
      client as never,
      makeContext(),
      'responder_logistica',
      {
        say_text: null,
        actions: [],
        blocked: true,
        block_reason: 'delivery_claim_without_calcular_frete',
        candidate_say_text: 'Entregamos amanhã no seu bairro.',
        candidate_actions: [],
        candidate_raw_actions: [],
        used_llm: true,
        fallback_used: false,
        input_tokens: 11,
        output_tokens: 7,
        duration_ms: 123,
      },
      '00000000-0000-4000-8000-0000000000ee',
    );

    expect(queries[0]!.sql).toContain('blocked_say_text');
    expect(queries[0]!.sql).toContain('blocked_actions');
    expect(queries[0]!.sql).toContain('blocked_payload');
    expect(queries[0]!.params[14]).toBe('Entregamos amanhã no seu bairro.');
    expect(queries[0]!.params[15]).toBe('[]');

    const blockedPayload = JSON.parse(queries[0]!.params[16] as string);
    expect(blockedPayload).toMatchObject({
      say_text: 'Entregamos amanhã no seu bairro.',
      block_reason: 'delivery_claim_without_calcular_frete',
      used_llm: true,
    });

    const eventPayload = JSON.parse(queries[1]!.params[4] as string);
    expect(eventPayload).toMatchObject({
      say_text: null,
      blocked: true,
      blocked_say_text: 'Entregamos amanhã no seu bairro.',
      block_reason: 'delivery_claim_without_calcular_frete',
    });
  });
});
