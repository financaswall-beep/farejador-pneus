import { describe, expect, it, vi } from 'vitest';
import type { ConversationState } from '../../../../src/shared/zod/agent-state.js';

const conversationId = '00000000-0000-4000-8000-000000000001';
const baseTime = '2026-04-29T12:00:00.000Z';

process.env.FAREJADOR_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/farejador_test';
process.env.CHATWOOT_HMAC_SECRET = 'test-secret';
process.env.ADMIN_AUTH_TOKEN = 'test-admin-token';
process.env.DATABASE_SSL = 'false';
process.env.ORGANIZADORA_ENABLED = 'false';
process.env.PLANNER_LLM_ENABLED = 'false';
process.env.ATENDENTE_SHADOW_ENABLED = 'false';
process.env.GENERATOR_LLM_ENABLED = 'false';
process.env.ATENDENTE_CONTEXT_MESSAGES_LIMIT = '20';
process.env.ATENDENTE_CONTEXT_TOOL_EVENTS_LIMIT = '7';
process.env.ATENDENTE_CONTEXT_ORGANIZER_FACTS_LIMIT = '31';

vi.mock('../../../../src/atendente/state/agent-state.repository.js', () => ({
  loadCurrent: vi.fn(async () => state()),
}));

describe('buildPlannerContext', () => {
  it('nao transforma planner_decided antigo em recent_tool_results falso', async () => {
    const { buildPlannerContext } = await import('../../../../src/atendente/planner/context-builder.js');
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: '00000000-0000-4000-8000-000000000010',
            sender_type: 'contact',
            message_type: 'incoming',
            content: 'tem pneu pra Bros?',
            sent_at: new Date(baseTime),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const context = await buildPlannerContext({ query } as never, 'test', conversationId);

    expect(context.recent_messages).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000010',
        role: 'customer',
        text: 'tem pneu pra Bros?',
        sent_at: baseTime,
      },
    ]);
    expect(context.recent_tool_results).toEqual([]);
    expect(context.organizer_facts).toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]?.[0]).toContain('FROM core.messages');
    expect(query.mock.calls[0]?.[1]).toEqual(['test', conversationId, null, 20]);
    expect(query.mock.calls[1]?.[0]).toContain("event_type IN ('tool_executed', 'tool_failed')");
    expect(query.mock.calls[1]?.[1]).toEqual(['test', conversationId, 7]);
    expect(query.mock.calls[2]?.[0]).toContain('FROM analytics.current_facts');
    expect(query.mock.calls[2]?.[1]).toEqual(['test', conversationId, 31]);
  });

  it('le tool_executed e tool_failed reais como recent_tool_results', async () => {
    const { buildPlannerContext } = await import('../../../../src/atendente/planner/context-builder.js');
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            event_type: 'tool_failed',
            event_payload: { tool: 'calcularFrete', ok: false, error_message: 'bairro_nao_encontrado' },
            occurred_at: new Date('2026-04-29T12:02:00.000Z'),
          },
          {
            event_type: 'tool_executed',
            event_payload: { tool: 'buscarProduto', ok: true, output: [{ product_id: 'p1' }] },
            occurred_at: new Date('2026-04-29T12:01:00.000Z'),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const context = await buildPlannerContext({ query } as never, 'test', conversationId);

    expect(context.recent_tool_results).toEqual([
      expect.objectContaining({ tool: 'buscarProduto', ok: true }),
      expect.objectContaining({ tool: 'calcularFrete', ok: false }),
    ]);
  });

  it('NAO consome organizer_facts em tempo real (Fase 1 isolamento 2026-05-22)', async () => {
    // Mesmo que a Organizadora tenha gravado facts em analytics.conversation_facts,
    // o PlannerContext NAO carrega esses facts pro bot consumir. organizer_facts
    // fica sempre [] no contexto entregue ao Planner/Generator.
    // Motivo: facts mal-ancorados contaminavam o atendimento (conv 593 PCX 2020).
    // A Organizadora segue gravando pra analytics/dashboard, mas o bot le state
    // proprio (global_slots, items) + recent_messages + tool_results.
    const { buildPlannerContext } = await import('../../../../src/atendente/planner/context-builder.js');
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            fact_key: 'medida_pneu',
            fact_value: '120/80-18',
            observed_at: new Date(baseTime),
            message_id: '00000000-0000-4000-8000-000000000010',
            truth_type: 'observed',
            source: 'organizadora_llm',
            confidence_level: 0.91,
            extractor_version: 'organizadora_v3.4',
            latest_evidence_text: 'preciso 120/80-18',
            latest_evidence_message_id: '00000000-0000-4000-8000-000000000010',
            latest_evidence_type: 'literal',
          },
        ],
      });

    const context = await buildPlannerContext({ query } as never, 'test', conversationId);

    // Apesar do banco ter 1 fact, o contexto vem com organizer_facts vazio.
    expect(context.organizer_facts).toEqual([]);
  });
});

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
    turn_index: 0,
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
