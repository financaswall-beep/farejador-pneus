import { describe, expect, it } from 'vitest';
import { buildGeneratorMessagesFewShot } from '../../../../src/atendente/generator/prompt-v1_5.js';
import { generatorPromptVersionV15 } from '../../../../src/atendente/generator/schemas.js';
import type { PlannerContext } from '../../../../src/atendente/planner/context-builder.js';
import type { PlannerDecisionResult } from '../../../../src/atendente/planner/service.js';
import type { ToolExecutionResult } from '../../../../src/atendente/executor/tool-executor.js';
import type { ConversationState } from '../../../../src/shared/zod/agent-state.js';

const conversationId = '00000000-0000-4000-8000-000000000099';
const baseTime = '2026-05-15T14:00:00.000Z';

function context(overrides: Partial<PlannerContext> = {}): PlannerContext {
  const state: ConversationState = {
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
  };
  return {
    environment: 'test',
    conversation_id: conversationId,
    state,
    recent_messages: [],
    available_tools: ['buscarProduto', 'verificarEstoque', 'buscarCompatibilidade', 'calcularFrete', 'buscarPoliticaComercial'],
    recent_tool_results: [],
    organizer_facts: [],
    derived_signals: state.derived_signals,
    ...overrides,
  };
}

function decision(skill: string = 'buscar_e_ofertar'): PlannerDecisionResult {
  return {
    output: {
      skill: skill as never,
      missing_slots: [],
      tool_requests: [],
      risk_flags: [],
      confidence: 0.8,
      rationale: 'teste',
      prompt_version: 'planner_v1.2.8',
    },
    used_llm: false,
    fallback_used: false,
    input_tokens: 0,
    output_tokens: 0,
    duration_ms: 0,
  };
}

describe('Generator prompt v1.5.0 (few-shot)', () => {
  it('produz duas mensagens: system + user', () => {
    const messages = buildGeneratorMessagesFewShot(context(), decision(), []);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('system prompt anuncia versao v1.5.0', () => {
    const messages = buildGeneratorMessagesFewShot(context(), decision(), []);
    expect(messages[0].content).toContain(`prompt_version=${generatorPromptVersionV15}`);
    expect(messages[0].content).toContain('generator_v1.5.0');
  });

  it('system prompt tem todos os 10 exemplos canonicos', () => {
    const messages = buildGeneratorMessagesFewShot(context(), decision(), []);
    const prompt = messages[0].content;
    for (let i = 1; i <= 10; i += 1) {
      expect(prompt).toContain(`## Exemplo ${i}`);
    }
  });

  it('system prompt cobre os 5 failure modes identificados na catalog15', () => {
    const messages = buildGeneratorMessagesFewShot(context(), decision(), []);
    const prompt = messages[0].content;
    // Multi-produto (cases 490, 496, 499, 500)
    expect(prompt).toMatch(/Multi-produto|dois pneus|cada/i);
    // Pivot/mudanca (cases 491, 497)
    expect(prompt).toMatch(/Pivot|corrigiu|mudança|mas é/i);
    // Frete coloquial (Belford Roxo)
    expect(prompt).toMatch(/Belford Roxo|sem bairro|sem endereço/i);
    // Closing parcial (pago pix, busco hoje)
    expect(prompt).toMatch(/Closing|pago pix|busco hoje|fechamento parcial/i);
    // Sem evidencia (caso 498)
    expect(prompt).toMatch(/Sem evidência|Intruder|não encontrei/i);
  });

  it('system prompt tem contrato de cada claim type', () => {
    const messages = buildGeneratorMessagesFewShot(context(), decision(), []);
    const prompt = messages[0].content;
    expect(prompt).toContain('"type": "price"');
    expect(prompt).toContain('"type": "stock_availability"');
    expect(prompt).toContain('"type": "fitment"');
    expect(prompt).toContain('"type": "delivery_fee"');
  });

  it('system prompt nao infla acima do v1.4.0', () => {
    const messages = buildGeneratorMessagesFewShot(context(), decision(), []);
    const size = messages[0].content.length;
    // v1.4.0 = ~14748 chars. v1.5.0 inicial era ~12500 (Sprint 6.5).
    // 2026-05-22: adicionados exemplos 11 (fechamento sem tools), 12 (despedida),
    // 13 (nome+endereco separados) — sobe pra ~14650, ainda abaixo do v1.4.0.
    // Filosofia: agente mais pensativo pode pagar bytes em few-shots criticos.
    expect(size).toBeLessThan(15000);
    expect(size).toBeGreaterThan(4000); // sanity: nao esta vazio
  });

  it('user message contem o payload de contexto identico ao v1.4.0', () => {
    const messages = buildGeneratorMessagesFewShot(
      context({
        recent_messages: [
          { id: '00000000-0000-4000-8000-000000000001', role: 'customer', text: 'oi', sent_at: baseTime },
        ],
      }),
      decision(),
      [],
    );
    const userPayload = JSON.parse(messages[1].content) as Record<string, unknown>;
    expect(userPayload).toHaveProperty('context');
    expect(userPayload).toHaveProperty('planner_decision');
    expect(userPayload).toHaveProperty('current_turn_tool_results');
    expect(userPayload).toHaveProperty('commercial_summary');
    expect(userPayload).toHaveProperty('confirmed_evidence');
    expect((userPayload.output_contract as { prompt_version: string }).prompt_version).toBe(
      generatorPromptVersionV15,
    );
  });

  it('exemplos contem regra de NAO somar precos em multi-produto', () => {
    const messages = buildGeneratorMessagesFewShot(context(), decision(), []);
    const prompt = messages[0].content;
    // Exemplo 4 deve mostrar dois precos separados, nao soma
    expect(prompt).toMatch(/R\$ 89,?0?0?.{0,80}R\$ 79,?0?0?/);
    expect(prompt).toContain('NAO soma');
  });

  it('exemplo 7 mostra como nao emitir delivery_fee sem evidencia', () => {
    const messages = buildGeneratorMessagesFewShot(context(), decision(), []);
    const prompt = messages[0].content;
    // Exemplo 7 deve ter explicitamente "claims": [] e mensagem perguntando bairro
    expect(prompt).toMatch(/Belford Roxo.*PERGUNTA|qual o bairro/i);
    expect(prompt).toMatch(/Exemplo 7[\s\S]{0,800}"claims":\s*\[\]/);
  });
});
