import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlannerContext } from '../../../src/atendente/planner/context-builder.js';
import type { AtendenteJobRow } from '../../../src/shared/repositories/ops-atendente.repository.js';
import type { ConversationState } from '../../../src/shared/zod/agent-state.js';

const conversationId = '00000000-0000-4000-8000-000000000001';
const baseTime = '2026-04-29T12:00:00.000Z';
const jobId = '00000000-0000-4000-8000-00000000000a';
const triggerMessageId = '00000000-0000-4000-8000-00000000000b';

const buildPlannerContextMock = vi.fn();
const planTurnMock = vi.fn();
const recordPlannerDecisionMock = vi.fn();
const executeToolRequestsMock = vi.fn();
const recordToolExecutionResultsMock = vi.fn();
const generateTurnMock = vi.fn();
const recordGeneratorResultMock = vi.fn();

vi.mock('../../../src/atendente/planner/context-builder.js', () => ({
  buildPlannerContext: buildPlannerContextMock,
}));

vi.mock('../../../src/atendente/planner/service.js', () => ({
  planTurn: planTurnMock,
  recordPlannerDecision: recordPlannerDecisionMock,
}));

vi.mock('../../../src/atendente/executor/tool-executor.js', () => ({
  executeToolRequests: executeToolRequestsMock,
  recordToolExecutionResults: recordToolExecutionResultsMock,
}));

vi.mock('../../../src/atendente/generator/service.js', () => ({
  generateTurn: generateTurnMock,
  recordGeneratorResult: recordGeneratorResultMock,
}));

let processAtendenteJob: typeof import('../../../src/atendente/worker.js').processAtendenteJob;
let classifyJobFailure: typeof import('../../../src/atendente/worker.js').classifyJobFailure;
let startAtendenteShadow: typeof import('../../../src/atendente/worker.js').startAtendenteShadow;

beforeAll(async () => {
  process.env.FAREJADOR_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.CHATWOOT_HMAC_SECRET = 'test';
  process.env.ADMIN_AUTH_TOKEN = 'test';
  process.env.PLANNER_LLM_ENABLED = 'false';
  process.env.ATENDENTE_SHADOW_ENABLED = 'false';
  process.env.GENERATOR_LLM_ENABLED = 'false';
  const worker = await import('../../../src/atendente/worker.js');
  processAtendenteJob = worker.processAtendenteJob;
  classifyJobFailure = worker.classifyJobFailure;
  startAtendenteShadow = worker.startAtendenteShadow;
});

describe('Atendente Shadow Worker - Sprint 5', () => {
  it('processa job feliz, grava eventos e avanca turno shadow', async () => {
    resetMocks();

    const context = plannerContext();
    buildPlannerContextMock.mockResolvedValueOnce(context);

    const decision = {
      output: {
        skill: 'buscar_e_ofertar',
        missing_slots: [],
        tool_requests: [{ tool: 'buscarProduto', input: { environment: 'test', limit: 10 } }],
        risk_flags: [],
        confidence: 0.8,
        rationale: 'mock',
        prompt_version: 'planner-v1',
      },
      used_llm: false,
      fallback_used: false,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
    };
    planTurnMock.mockResolvedValueOnce(decision);
    recordPlannerDecisionMock.mockResolvedValueOnce(undefined);
    executeToolRequestsMock.mockResolvedValueOnce([
      {
        tool: 'buscarProduto',
        input: { environment: 'test', limit: 10 },
        output: [{ product_id: 'p1' }],
        ok: true,
        duration_ms: 5,
        error_message: null,
      },
    ]);
    recordToolExecutionResultsMock.mockResolvedValueOnce(undefined);

    generateTurnMock.mockResolvedValueOnce({
      say_text: 'Encontrei opções para você.',
      actions: [],
      blocked: false,
      block_reason: null,
      used_llm: false,
      fallback_used: false,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 1,
    });
    const fakeTurnId = '00000000-0000-4000-8000-00000000abcd';
    recordGeneratorResultMock.mockResolvedValueOnce(fakeTurnId);

    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ '?column?': 1 }] }) };
    const summary = await processAtendenteJob(client as never, fakeJob());

    expect(client.query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(client.query.mock.calls.at(-1)?.[0]).toContain('last_customer_message_id');
    expect(client.query.mock.calls.at(-1)?.[1]).toEqual(['test', conversationId, 3, triggerMessageId]);
    expect(buildPlannerContextMock).toHaveBeenCalledTimes(1);
    expect(planTurnMock).toHaveBeenCalledWith(context);
    expect(recordPlannerDecisionMock).toHaveBeenCalledWith(client, context, decision);
    expect(executeToolRequestsMock).toHaveBeenCalledTimes(1);
    expect(recordToolExecutionResultsMock).toHaveBeenCalledTimes(1);
    expect(generateTurnMock).toHaveBeenCalledTimes(1);
    expect(recordGeneratorResultMock).toHaveBeenCalledWith(
      client,
      context,
      'buscar_e_ofertar',
      expect.objectContaining({ blocked: false }),
      triggerMessageId,
    );
    expect(summary).toEqual({
      skill: 'buscar_e_ofertar',
      used_llm: false,
      fallback_used: false,
      turn_index: 3,
      tool_results: expect.arrayContaining([expect.objectContaining({ tool: 'buscarProduto', ok: true })]),
      generator_blocked: false,
      generator_block_reason: null,
      turn_id: fakeTurnId,
      actions_persisted: 0,
      actions_failed: 0,
      escalated_actions: [],
    });
  });

  it('nao chama executor quando planner nao emite tool_requests', async () => {
    resetMocks();

    buildPlannerContextMock.mockResolvedValueOnce(plannerContext());
    planTurnMock.mockResolvedValueOnce({
      output: {
        skill: 'pedir_dados_faltantes',
        missing_slots: ['moto_modelo'],
        tool_requests: [],
        risk_flags: [],
        confidence: 0.6,
        rationale: 'mock',
        prompt_version: 'planner-v1',
      },
      used_llm: false,
      fallback_used: false,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
    });
    recordPlannerDecisionMock.mockResolvedValueOnce(undefined);
    generateTurnMock.mockResolvedValueOnce({
      say_text: 'Preciso de mais informações.',
      actions: [],
      blocked: false,
      block_reason: null,
      used_llm: false,
      fallback_used: false,
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
    });
    recordGeneratorResultMock.mockResolvedValueOnce('00000000-0000-4000-8000-000000000099');

    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ '?column?': 1 }] }) };
    const summary = await processAtendenteJob(client as never, fakeJob());

    expect(executeToolRequestsMock).not.toHaveBeenCalled();
    expect(recordToolExecutionResultsMock).not.toHaveBeenCalled();
    expect(summary.tool_results).toEqual([]);
    expect(summary.skill).toBe('pedir_dados_faltantes');
  });

  it('falha limpa quando nao existe session_current para a conversa', async () => {
    resetMocks();

    const client = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };

    await expect(processAtendenteJob(client as never, fakeJob())).rejects.toThrow(
      `planner_context_missing_state:${conversationId}`,
    );
    expect(buildPlannerContextMock).not.toHaveBeenCalled();
  });

  it('classifyJobFailure mapeia planner_context_missing_state para context_build_failed', () => {
    const missing = classifyJobFailure(new Error(`planner_context_missing_state:${conversationId}`));
    expect(missing.incident_type).toBe('context_build_failed');
    expect(missing.severity).toBe('medium');

    const generic = classifyJobFailure(new Error('boom'));
    expect(generic.incident_type).toBe('action_handler_failed');
    expect(generic.severity).toBe('high');
  });

  it('startAtendenteShadow com flag desligada retorna no-op sem pollar', async () => {
    resetMocks();

    const stop = startAtendenteShadow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(buildPlannerContextMock).not.toHaveBeenCalled();
    expect(planTurnMock).not.toHaveBeenCalled();
    expect(typeof stop).toBe('function');
    stop();
  });
});

function resetMocks(): void {
  buildPlannerContextMock.mockReset();
  planTurnMock.mockReset();
  recordPlannerDecisionMock.mockReset();
  executeToolRequestsMock.mockReset();
  recordToolExecutionResultsMock.mockReset();
  generateTurnMock.mockReset();
  recordGeneratorResultMock.mockReset();
}

function fakeJob(): AtendenteJobRow {
  return {
    id: jobId,
    environment: 'test',
    conversation_id: conversationId,
    trigger_message_id: triggerMessageId,
    status: 'pending',
    attempts: 0,
  };
}

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
