import { describe, expect, it, vi } from 'vitest';
import { executeToolRequests, recordToolExecutionResults } from '../../../../src/atendente/executor/tool-executor.js';
import type { PlannerContext } from '../../../../src/atendente/planner/context-builder.js';
import type { ConversationState } from '../../../../src/shared/zod/agent-state.js';

const conversationId = '00000000-0000-4000-8000-000000000001';
const baseTime = '2026-04-29T12:00:00.000Z';

describe('Tool Executor Sprint 4', () => {
  it('executa tool valida e retorna resultado ok', async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            product_id: 'p1',
            product_code: 'SKU',
            product_name: 'Pirelli',
            product_type: 'tire',
            brand: 'Pirelli',
            short_description: null,
            tire_size: '100/90 R17',
            tire_position: 'rear',
            intended_use: 'mixed',
            price_amount: '175.00',
            currency: 'BRL',
            price_type: 'regular',
            total_stock_available: 2,
          },
        ],
      }),
    };

    const result = await executeToolRequests(client as never, [
      {
        tool: 'buscarProduto',
        input: {
          environment: 'test',
          product_code: 'SKU',
          apenas_com_estoque: false,
          limit: 10,
        },
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      tool: 'buscarProduto',
      ok: true,
      error_message: null,
    });
  });

  it('transforma erro de tool em resultado tool_failed sem throw', async () => {
    const client = { query: vi.fn() };
    const result = await executeToolRequests(client as never, [
      {
        tool: 'buscarProduto',
        input: {
          environment: 'test',
          apenas_com_estoque: false,
          limit: 10,
        } as never,
      },
    ]);

    expect(result[0]).toMatchObject({
      tool: 'buscarProduto',
      ok: false,
    });
    expect(result[0]?.error_message).toContain('buscarProduto exige');
  });

  it('grava tool_executed e tool_failed no ledger', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const context = plannerContext();

    await recordToolExecutionResults({ query } as never, context, [
      {
        tool: 'buscarProduto',
        input: { environment: 'test', product_code: 'SKU' },
        output: [{ product_id: 'p1' }],
        ok: true,
        duration_ms: 10,
        error_message: null,
      },
      {
        tool: 'calcularFrete',
        input: { environment: 'test', bairro: 'Meier' },
        output: null,
        ok: false,
        duration_ms: 5,
        error_message: 'fail',
      },
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (action_id) DO NOTHING');
    expect(query.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['test', conversationId, 3, 'tool_executed']),
    );
    expect(query.mock.calls[0]?.[1]?.[5]).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(query.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(['test', conversationId, 3, 'tool_failed']),
    );
    expect(query.mock.calls[1]?.[1]?.[5]).not.toBe(query.mock.calls[0]?.[1]?.[5]);
  });
});

function plannerContext(): PlannerContext {
  const state = conversationState();
  return {
    environment: 'test',
    conversation_id: conversationId,
    state,
    recent_messages: [],
    available_tools: ['buscarProduto'],
    recent_tool_results: [],
    organizer_facts: [],
    derived_signals: state.derived_signals,
  };
}

function conversationState(): ConversationState {
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
  };
}
