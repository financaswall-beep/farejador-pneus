import { describe, expect, it, vi } from 'vitest';
import {
  customerAsksForStock,
  executeToolRequests,
  maybeAutoChainVerificarEstoque,
  recordToolExecutionResults,
  type ToolExecutionResult,
} from '../../../../src/atendente/executor/tool-executor.js';
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

  it('sanitiza marca/product_code quando LLM Planner envia medida ou marca de moto', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    // Caso 1: marca = medida_pneu (LLM copiou medida para marca)
    await executeToolRequests({ query } as never, [
      {
        tool: 'buscarProduto',
        input: {
          environment: 'test',
          medida_pneu: '110/70-17',
          marca: '110/70-17',
          product_code: '110/70-17',
          posicao_pneu: 'front',
          apenas_com_estoque: true,
          limit: 10,
        } as never,
      },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const sql1 = String(query.mock.calls[0]?.[0]);
    const params1 = query.mock.calls[0]?.[1] ?? [];
    expect(sql1).toContain('FROM commerce.product_full');
    // marca dropped → filtro de marca nao aparece no SQL
    expect(sql1).not.toContain('brand ILIKE');
    // product_code dropped → filtro tambem nao aparece
    expect(sql1).not.toContain('product_code = ');
    // medida_pneu mantido
    expect(params1).toEqual(expect.arrayContaining(['110/70-17']));

    query.mockClear();

    // Caso 2: marca de moto (Zontes) — drop
    await executeToolRequests({ query } as never, [
      {
        tool: 'buscarProduto',
        input: {
          environment: 'test',
          medida_pneu: '160/60-17',
          marca: 'Zontes',
          posicao_pneu: 'rear',
          apenas_com_estoque: true,
          limit: 5,
        } as never,
      },
    ]);
    const sql2 = String(query.mock.calls[0]?.[0]);
    expect(sql2).not.toContain('brand ILIKE');

    query.mockClear();

    // Caso 3: marca valida (Pirelli) — mantida
    await executeToolRequests({ query } as never, [
      {
        tool: 'buscarProduto',
        input: {
          environment: 'test',
          medida_pneu: '160/60-17',
          marca: 'Pirelli',
          apenas_com_estoque: true,
          limit: 5,
        } as never,
      },
    ]);
    const sql3 = String(query.mock.calls[0]?.[0]);
    expect(sql3).toContain('brand ILIKE');
  });

  describe('auto-chain verificarEstoque pos-buscarProduto', () => {
    it.each([
      'Tem?',
      'Tem ai?',
      'Voces tem em estoque?',
      'Pronta entrega?',
      'Ainda tem esse pneu?',
      'Tem disponivel?',
      'Vcs tem 90/90-18?',
    ])('detecta intencao de estoque na mensagem: %s', (text) => {
      expect(customerAsksForStock(text)).toBe(true);
    });

    it.each([
      'Qual a medida do meu pneu?',
      'Minha moto e Honda CG 160.',
      'Quero saber o preco.',
      null,
      undefined,
      '',
    ])('NAO detecta intencao de estoque: %s', (text) => {
      expect(customerAsksForStock(text)).toBe(false);
    });

    it('dispara verificarEstoque quando cliente pediu estoque e buscarProduto retornou produto', async () => {
      // Mock para verificarEstoque
      const client = {
        query: vi.fn().mockResolvedValueOnce({
          rows: [
            {
              product_id: '11111111-2222-4333-8444-555555555555',
              product_code: 'SKU001',
              product_name: 'Pneu 90/90-18',
              location: 'loja',
              quantity_available: 5,
              quantity_reserved: 0,
            },
          ],
        }),
      };

      const existing: ToolExecutionResult[] = [
        {
          tool: 'buscarProduto',
          input: { environment: 'prod', medida_pneu: '90/90-18' },
          output: [{ product_id: '11111111-2222-4333-8444-555555555555', product_code: 'SKU001', price_amount: '79.00' }],
          ok: true,
          duration_ms: 5,
          error_message: null,
        },
      ];

      const result = await maybeAutoChainVerificarEstoque(
        client as never,
        'prod',
        'Tem em estoque?',
        existing,
      );

      expect(result).not.toBeNull();
      expect(result?.tool).toBe('verificarEstoque');
      expect(result?.ok).toBe(true);
      expect((result?.input as Record<string, unknown>)?.product_id).toBe('11111111-2222-4333-8444-555555555555');
    });

    it('NAO dispara quando verificarEstoque ja rodou no turn', async () => {
      const client = { query: vi.fn() };
      const existing: ToolExecutionResult[] = [
        {
          tool: 'buscarProduto',
          input: { environment: 'prod' },
          output: [{ product_id: 'p1' }],
          ok: true,
          duration_ms: 5,
          error_message: null,
        },
        {
          tool: 'verificarEstoque',
          input: { environment: 'prod', product_id: 'p1' },
          output: { disponivel: true, quantidade_total: 3 },
          ok: true,
          duration_ms: 5,
          error_message: null,
        },
      ];

      const result = await maybeAutoChainVerificarEstoque(
        client as never,
        'prod',
        'Tem em estoque?',
        existing,
      );

      expect(result).toBeNull();
      expect(client.query).not.toHaveBeenCalled();
    });

    it('NAO dispara quando buscarProduto retornou vazio', async () => {
      const client = { query: vi.fn() };
      const existing: ToolExecutionResult[] = [
        {
          tool: 'buscarProduto',
          input: { environment: 'prod' },
          output: [],
          ok: true,
          duration_ms: 5,
          error_message: null,
        },
      ];

      const result = await maybeAutoChainVerificarEstoque(
        client as never,
        'prod',
        'Tem em estoque?',
        existing,
      );

      expect(result).toBeNull();
      expect(client.query).not.toHaveBeenCalled();
    });

    it('NAO dispara quando cliente nao perguntou sobre estoque', async () => {
      const client = { query: vi.fn() };
      const existing: ToolExecutionResult[] = [
        {
          tool: 'buscarProduto',
          input: { environment: 'prod' },
          output: [{ product_id: 'p1' }],
          ok: true,
          duration_ms: 5,
          error_message: null,
        },
      ];

      const result = await maybeAutoChainVerificarEstoque(
        client as never,
        'prod',
        'Quero saber o preco.',
        existing,
      );

      expect(result).toBeNull();
      expect(client.query).not.toHaveBeenCalled();
    });
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
