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
let normalizePlannerOutputCandidate: typeof import('../../../../src/atendente/planner/service.js').normalizePlannerOutputCandidate;
let buildPlannerMessages: typeof import('../../../../src/atendente/planner/prompt.js').buildPlannerMessages;

beforeAll(async () => {
  process.env.FAREJADOR_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.CHATWOOT_HMAC_SECRET = 'test';
  process.env.ADMIN_AUTH_TOKEN = 'test';
  process.env.PLANNER_LLM_ENABLED = 'false';
  const service = await import('../../../../src/atendente/planner/service.js');
  planTurn = service.planTurn;
  recordPlannerDecision = service.recordPlannerDecision;
  normalizePlannerOutputCandidate = service.normalizePlannerOutputCandidate;
  const prompt = await import('../../../../src/atendente/planner/prompt.js');
  buildPlannerMessages = prompt.buildPlannerMessages;
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

  it('mock planner usa responder_geral para horario de funcionamento', async () => {
    const result = await planTurn(
      context({
        recent_messages: [
          {
            id: '00000000-0000-4000-8000-000000000012',
            role: 'customer',
            text: 'Que horas voces fecham hoje?',
            sent_at: baseTime,
          },
        ],
      }),
    );

    expect(result.output).toMatchObject({
      skill: 'responder_geral',
      tool_requests: [{ tool: 'buscarPoliticaComercial', input: { environment: 'test' } }],
      prompt_version: plannerPromptVersion,
    });
  });

  it('mock planner usa responder_geral para pergunta de endereco', async () => {
    const result = await planTurn(
      context({
        recent_messages: [
          {
            id: '00000000-0000-4000-8000-000000000014',
            role: 'customer',
            text: 'Onde fica a loja de voces?',
            sent_at: baseTime,
          },
        ],
      }),
    );

    expect(result.output).toMatchObject({
      skill: 'responder_geral',
      missing_slots: [],
      tool_requests: [{ tool: 'buscarPoliticaComercial', input: { environment: 'test' } }],
      prompt_version: plannerPromptVersion,
    });
  });

  it('mock planner usa responder_geral para pergunta de montagem', async () => {
    const result = await planTurn(
      context({
        recent_messages: [
          {
            id: '00000000-0000-4000-8000-000000000015',
            role: 'customer',
            text: 'Voces fazem montagem na hora?',
            sent_at: baseTime,
          },
        ],
      }),
    );

    expect(result.output).toMatchObject({
      skill: 'responder_geral',
      missing_slots: [],
      tool_requests: [{ tool: 'buscarPoliticaComercial', input: { environment: 'test' } }],
    });
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

  it('prompt orienta skill especializada antes de escalar humano', () => {
    const messages = buildPlannerMessages(context());
    const systemPrompt = messages[0]!.content;

    expect(systemPrompt).toContain('Use escalar_humano somente se o cliente pedir humano/atendente');
    expect(systemPrompt).toContain('Objeções de preço, caro, concorrente, desconto ou condição comercial usam tratar_objecao');
    expect(systemPrompt).toContain('Perguntas sobre cartão, pix, boleto, parcelamento, troca, devolucao, garantia, horario de funcionamento');
    expect(systemPrompt).toContain('Perguntas sobre cartão, pix, pagamento, desconto ou condição comercial nao sao responder_logistica');
    expect(systemPrompt).toContain('Não repita escalar_humano em turnos seguidos');
    expect(systemPrompt).toContain('posicao_pneu deve ser exatamente front, rear ou both');
    expect(systemPrompt).toContain('buscarProduto exige pelo menos um destes campos');
  });

  it('normaliza input de tool antes de validar output do Planner', () => {
    const normalized = plannerOutputSchema.parse(
      normalizePlannerOutputCandidate(
        {
          skill: 'pedir_dados_faltantes',
          missing_slots: [],
          tool_requests: [
            {
              tool: 'buscarCompatibilidade',
              input: {
                environment: 'test',
                moto_modelo: 'Bros 160',
                moto_ano: '2022',
                posicao_pneu: 'traseiro',
              },
            },
          ],
          risk_flags: ['compatibilidade_precisa_confirmacao_por_tool', 'low_confidence'],
          confidence: 0.7,
          rationale: 'teste',
          prompt_version: 'planner_v1.2.0',
        },
        context(),
      ),
    );

    expect(normalized.tool_requests).toEqual([
      {
        tool: 'buscarCompatibilidade',
        input: {
          environment: 'test',
          moto_modelo: 'Bros 160',
          moto_ano: 2022,
          posicao_pneu: 'rear',
          limit: 10,
        },
      },
    ]);
    expect(normalized.risk_flags).toEqual(['low_confidence']);
    expect(normalized.prompt_version).toBe(plannerPromptVersion);
  });

  it('enriquece buscarProduto com fatos antes de validar', () => {
    const normalized = plannerOutputSchema.parse(
      normalizePlannerOutputCandidate(
        {
          skill: 'buscar_e_ofertar',
          missing_slots: [],
          tool_requests: [
            {
              tool: 'buscarProduto',
              input: { environment: 'test', posicao_pneu: 'traseiro' },
            },
          ],
          risk_flags: ['mentions_stock'],
          confidence: 0.8,
          rationale: 'teste',
          prompt_version: 'planner_v1.2.0',
        },
        context({
          organizer_facts: [
            organizerFact('medida_pneu', '140/70-17'),
            organizerFact('marca_pneu_preferida', 'Michelin'),
          ],
        }),
      ),
    );

    expect(normalized.tool_requests).toEqual([
      {
        tool: 'buscarProduto',
        input: {
          environment: 'test',
          medida_pneu: '140/70-17',
          marca: 'Michelin',
          posicao_pneu: 'rear',
          apenas_com_estoque: false,
          limit: 10,
        },
      },
    ]);
  });

  it('nao deixa buscarProduto invalido virar fallback de humano', () => {
    const normalized = plannerOutputSchema.parse(
      normalizePlannerOutputCandidate(
        {
          skill: 'buscar_e_ofertar',
          missing_slots: [],
          tool_requests: [{ tool: 'buscarProduto', input: { environment: 'test' } }],
          risk_flags: [],
          confidence: 0.9,
          rationale: 'teste',
          prompt_version: 'planner_v1.2.0',
        },
        context(),
      ),
    );

    expect(normalized).toMatchObject({
      skill: 'pedir_dados_faltantes',
      missing_slots: ['medida_pneu'],
      tool_requests: [],
      confidence: 0.65,
      prompt_version: plannerPromptVersion,
    });
  });

  it('garante buscarPoliticaComercial quando Planner esquece tool em pergunta de politica', () => {
    const normalized = plannerOutputSchema.parse(
      normalizePlannerOutputCandidate(
        {
          skill: 'pedir_dados_faltantes',
          missing_slots: ['medida_pneu'],
          tool_requests: [],
          risk_flags: [],
          confidence: 0.7,
          rationale: 'teste',
          prompt_version: 'planner_v1.2.1',
        },
        context({
          recent_messages: [
            {
              id: '00000000-0000-4000-8000-000000000013',
              role: 'customer',
              text: 'Se o pneu nao servir eu posso trocar?',
              sent_at: baseTime,
            },
          ],
        }),
      ),
    );

    expect(normalized).toMatchObject({
      skill: 'tratar_objecao',
      missing_slots: [],
      tool_requests: [{ tool: 'buscarPoliticaComercial', input: { environment: 'test' } }],
      prompt_version: plannerPromptVersion,
    });
  });

  it('garante responder_geral + politica quando Planner usa pedir_dados_faltantes para pergunta de endereco', () => {
    const normalized = plannerOutputSchema.parse(
      normalizePlannerOutputCandidate(
        {
          skill: 'pedir_dados_faltantes',
          missing_slots: ['moto_modelo', 'medida_pneu'],
          tool_requests: [],
          risk_flags: [],
          confidence: 0.6,
          rationale: 'teste',
          prompt_version: 'planner_v1.2.1',
        },
        context({
          recent_messages: [
            {
              id: '00000000-0000-4000-8000-000000000016',
              role: 'customer',
              text: 'Voces abrem domingo?',
              sent_at: baseTime,
            },
          ],
        }),
      ),
    );

    expect(normalized).toMatchObject({
      skill: 'responder_geral',
      missing_slots: [],
      tool_requests: [{ tool: 'buscarPoliticaComercial', input: { environment: 'test' } }],
      prompt_version: plannerPromptVersion,
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

  it('mock planner usa pedir_dados_faltantes quando cliente so apresenta a moto sem pedir produto', async () => {
    const result = await planTurn(
      context({
        recent_messages: [
          {
            id: '00000000-0000-4000-8000-000000000030',
            role: 'customer',
            text: 'Minha moto e Biz 125 2019.',
            sent_at: baseTime,
          },
        ],
      }),
    );

    expect(result.output.skill).not.toBe('tratar_objecao');
  });

  it('mock planner usa responder_geral quando cliente pergunta voces abrem hoje', async () => {
    const result = await planTurn(
      context({
        recent_messages: [
          {
            id: '00000000-0000-4000-8000-000000000031',
            role: 'customer',
            text: 'Voces abrem hoje?',
            sent_at: baseTime,
          },
        ],
      }),
    );

    expect(result.output).toMatchObject({
      skill: 'responder_geral',
      tool_requests: [{ tool: 'buscarPoliticaComercial', input: { environment: 'test' } }],
    });
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
