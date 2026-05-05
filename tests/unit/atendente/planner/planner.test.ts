import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlannerContext } from '../../../../src/atendente/planner/context-builder.js';
import {
  fallbackPlannerOutput,
  plannerOutputSchema,
  plannerPromptVersion,
} from '../../../../src/atendente/planner/schemas.js';
import type { ConversationState } from '../../../../src/shared/zod/agent-state.js';

let planTurn: typeof import('../../../../src/atendente/planner/service.js').planTurn;
let recordPlannerDecision: typeof import('../../../../src/atendente/planner/service.js').recordPlannerDecision;

beforeAll(async () => {
  process.env.FAREJADOR_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.CHATWOOT_HMAC_SECRET = 'test';
  process.env.ADMIN_AUTH_TOKEN = 'test';
  process.env.PLANNER_LLM_ENABLED = 'false';
  const service = await import('../../../../src/atendente/planner/service.js');
  planTurn = service.planTurn;
  recordPlannerDecision = service.recordPlannerDecision;
});

const baseTime = '2026-04-29T12:00:00.000Z';
const conversationId = '00000000-0000-4000-8000-000000000001';

function state(overrides: Partial<ConversationState> = {}): ConversationState {
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
    turn_index: 2,
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

function context(overrides: Partial<PlannerContext> = {}): PlannerContext {
  const s = state();
  return {
    environment: 'test',
    conversation_id: conversationId,
    state: s,
    recent_messages: [],
    available_tools: [
      'buscarProduto',
      'verificarEstoque',
      'buscarCompatibilidade',
      'calcularFrete',
      'buscarPoliticaComercial',
    ],
    recent_tool_results: [],
    organizer_facts: [],
    derived_signals: s.derived_signals,
    ...overrides,
  };
}

describe('Planner Sprint 3', () => {
  it('valida tool_requests com input completo da tool', () => {
    expect(() =>
      plannerOutputSchema.parse({
        skill: 'buscar_e_ofertar',
        missing_slots: [],
        tool_requests: [{ tool: 'buscarProduto', input: { environment: 'test' } }],
        risk_flags: [],
        confidence: 0.8,
        rationale: 'teste',
        prompt_version: plannerPromptVersion,
      }),
    ).toThrow();
  });

  it('mock planner escala quando cliente pede humano', async () => {
    const result = await planTurn(
      context({
        recent_messages: [
          {
            id: '00000000-0000-4000-8000-000000000010',
            role: 'customer',
            text: 'quero falar com humano',
            sent_at: baseTime,
          },
        ],
      }),
    );

    expect(result.used_llm).toBe(false);
    expect(result.output).toMatchObject({
      skill: 'escalar_humano',
      risk_flags: ['human_requested'],
      prompt_version: plannerPromptVersion,
    });
  });

  it('mock planner solicita calcularFrete quando bairro ja esta no estado', async () => {
    const s = state({
      global_slots: {
        bairro: {
          scope: 'global',
          item_id: null,
          slot_key: 'bairro',
          value_json: 'Meier',
          source: 'observed',
          confidence: 1,
          stale: 'fresh',
          requires_confirmation: false,
          set_at: baseTime,
        },
      },
    });

    const result = await planTurn(
      context({
        state: s,
        derived_signals: s.derived_signals,
        recent_messages: [
          {
            id: '00000000-0000-4000-8000-000000000011',
            role: 'customer',
            text: 'e o frete?',
            sent_at: baseTime,
          },
        ],
      }),
    );

    expect(result.output.tool_requests).toEqual([
      { tool: 'calcularFrete', input: { environment: 'test', bairro: 'Meier' } },
    ]);
  });

  it('mock planner usa fatos da Organizadora para buscar produto', async () => {
    const result = await planTurn(
      context({
        organizer_facts: [
          organizerFact('medida_pneu', '120/80-18'),
          organizerFact('marca_pneu_preferida', 'Michelin'),
        ],
        recent_messages: [
          {
            id: '00000000-0000-4000-8000-000000000011',
            role: 'customer',
            text: 'tem esse pneu?',
            sent_at: baseTime,
          },
        ],
      }),
    );

    expect(result.output).toMatchObject({
      skill: 'buscar_e_ofertar',
      tool_requests: [
        {
          tool: 'buscarProduto',
          input: {
            environment: 'test',
            medida_pneu: '120/80-18',
            marca: 'Michelin',
            apenas_com_estoque: true,
            limit: 10,
          },
        },
      ],
    });
  });

  it('fallbackPlannerOutput sempre retorna schema valido', () => {
    expect(plannerOutputSchema.parse(fallbackPlannerOutput('falha'))).toMatchObject({
      skill: 'escalar_humano',
      confidence: 0,
    });
  });

  it('recordPlannerDecision grava evento planner_decided auditavel', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query };
    const ctx = context();
    const decision = {
      output: fallbackPlannerOutput('teste'),
      used_llm: false,
      fallback_used: true,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
    };

    await recordPlannerDecision(client as never, ctx, decision);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('planner_decided'),
      expect.arrayContaining(['test', conversationId, 3, 'escalar_humano']),
    );
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (action_id) DO NOTHING');
    expect(query.mock.calls[0]?.[1]?.[5]).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
  });

  it('recordPlannerDecision usa action_id estavel por turno mesmo com output diferente', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query };
    const ctx = context();

    await recordPlannerDecision(client as never, ctx, {
      output: fallbackPlannerOutput('primeira_saida'),
      used_llm: false,
      fallback_used: true,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
    });
    await recordPlannerDecision(client as never, ctx, {
      output: {
        ...fallbackPlannerOutput('segunda_saida'),
        rationale: 'Outra decisao para o mesmo turno.',
      },
      used_llm: false,
      fallback_used: true,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
    });

    expect(query.mock.calls[0]?.[1]?.[5]).toBe(query.mock.calls[1]?.[1]?.[5]);
  });
});

function organizerFact(factKey: string, factValue: unknown): PlannerContext['organizer_facts'][number] {
  return {
    fact_key: factKey,
    fact_value: factValue,
    observed_at: baseTime,
    message_id: '00000000-0000-4000-8000-000000000010',
    truth_type: 'observed',
    source: 'organizadora_llm',
    confidence_level: 0.9,
    extractor_version: 'organizadora_v3.4',
    latest_evidence_text: null,
    latest_evidence_message_id: null,
    latest_evidence_type: null,
  };
}
